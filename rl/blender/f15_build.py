# F-15C Blender 모델링 (헤드리스). 실행:
# & "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python rl/blender/f15_build.py
# 좌표: Blender X 우측, Y 기수(+), Z 위. aero(x 전방,y 우측,z 위) → Blender (y, x, z).
# glTF +Y up 내보내기는 (bx,by,bz)->(bx,bz,-by) 이므로 three 로컬(x 우,y 위,z -기수)과 그대로 일치한다.
import bpy
import math
import os

bpy.ops.wm.read_factory_settings(use_empty=True)

WS = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GLB_PATH = os.path.join(WS, 'src', 'models', 'f15c.glb')
PREV_DIR = os.path.join(WS, 'rl', 'blender')
os.makedirs(os.path.join(WS, 'src', 'models'), exist_ok=True)

MODEL_OBJS = []

# 공력좌표 (x 전방, y 우측, z 위) → Blender
def A(x, y, z):
    return (y, x, z)

def lerp(a, b, t):
    return a + (b - a) * t

def sgn_pow(v, e):
    return math.copysign(abs(v) ** e, v) if v != 0 else 0.0

# ---------------- 재질 (이름만, 절차적 PBR 은 three 쪽에서 입힘) ----------------
def make_mat(name, color, metallic=0.0, roughness=0.6, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        m.blend_method = 'BLEND'
    return m

M_SKIN = make_mat('skin', (0.56, 0.60, 0.65), 0.15, 0.6)
M_SKIN_DARK = make_mat('skin_dark', (0.38, 0.41, 0.45), 0.15, 0.62)
M_NOZZLE = make_mat('metal_nozzle', (0.42, 0.35, 0.30), 0.9, 0.45)
M_DARK = make_mat('dark', (0.05, 0.05, 0.06), 0.2, 0.9)
M_GLASS = make_mat('glass', (0.85, 0.74, 0.52), 0.1, 0.07, 0.4)
M_COCKPIT = make_mat('cockpit', (0.08, 0.09, 0.10), 0.1, 0.85)
M_TIRE = make_mat('tire', (0.05, 0.05, 0.05), 0.0, 0.95)
M_GEAR = make_mat('gear', (0.62, 0.63, 0.64), 0.0, 0.8)

# ---------------- 지오메트리 생성기 ----------------
def finish(name, verts, faces, mats, face_mats=None, origin=(0, 0, 0), subdiv=2, bevel_w=0.02):
    me = bpy.data.meshes.new(name + '_mesh')
    nv = len(verts)
    for f in faces:
        for vi in f:
            if vi < 0 or vi >= nv:
                raise ValueError('bad index in ' + name)
    me.from_pydata(verts, [], faces)
    me.update()
    # 열린 경계선 크리즈 (서브디비전에서 뒷전이 뭉개지지 않게)
    try:
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(me)
        cl = bm.edges.layers.crease.verify()
        for e in bm.edges:
            if e.is_boundary:
                e[cl] = 1.0
        bm.to_mesh(me)
        bm.free()
    except Exception as _e:
        print('crease skip:', name, _e)
    print('mesh ok:', name, len(verts), len(faces), flush=True)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for m in mats:
        me.materials.append(m)
    if face_mats:
        for i, mi in enumerate(face_mats):
            me.polygons[i].material_index = mi
    ob.location = origin
    if bevel_w and bevel_w > 0:
        b = ob.modifiers.new('EdgeRound', 'BEVEL')
        b.width = bevel_w
        b.segments = 1
        b.limit_method = 'ANGLE'
        b.angle_limit = math.radians(45)
    if subdiv and subdiv > 0:
        s = ob.modifiers.new('Smooth', 'SUBSURF')
        s.levels = subdiv
        s.render_levels = subdiv
    MODEL_OBJS.append(ob)
    return ob

def merge(parts):
    # parts: [(verts, faces, mat_index), ...] → 합친 (verts, faces, face_mats)
    verts, faces, fm = [], [], []
    for pv, pf, mi in parts:
        base = len(verts)
        verts.extend(pv)
        for f in pf:
            faces.append(tuple(v + base for v in f))
        fm.extend([mi] * len(pf))
    return verts, faces, fm

def box_part(x0, x1, y0, y1, z0, z1, mat=0):
    # aero 좌표 박스 (x 전방, y 우측, z 위)
    c = [A(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    # 순서: 0:(x0,y0,z0) 1:(x0,y0,z1) 2:(x0,y1,z0) 3:(x0,y1,z1) 4:(x1,y0,z0) 5:(x1,y0,z1) 6:(x1,y1,z0) 7:(x1,y1,z1)
    F = [(0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3), (0, 1, 3, 2), (4, 6, 7, 5)]
    return (c, F, mat)

def tube_part(p0, p1, r, n=10, mat=0, cap0=True, cap1=True):
    # aero 좌표 두 점 사이 원통 (p = (x, y, z))
    import math as _m
    a = [p1[i] - p0[i] for i in range(3)]
    L = _m.sqrt(sum(v * v for v in a))
    d = [v / L for v in a]
    up = [0, 0, 1] if abs(d[2]) < 0.9 else [0, 1, 0]
    e1 = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]]
    n1 = _m.sqrt(sum(v * v for v in e1))
    e1 = [v / n1 for v in e1]
    e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]]
    verts = []
    for p in (p0, p1):
        for k in range(n):
            t = 2 * _m.pi * k / n
            verts.append(A(p[0] + r * (_m.cos(t) * e1[0] + _m.sin(t) * e2[0]),
                           p[1] + r * (_m.cos(t) * e1[1] + _m.sin(t) * e2[1]),
                           p[2] + r * (_m.cos(t) * e1[2] + _m.sin(t) * e2[2])))
    faces = []
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((k, k2, k2 + n, k + n))
    if cap0:
        c0 = len(verts)
        verts.append(A(*p0))
        for k in range(n):
            faces.append((c0, (k + 1) % n, k))
    if cap1:
        c1 = len(verts)
        verts.append(A(*p1))
        for k in range(n):
            faces.append((c1, k + n, (k + 1) % n + n))
    return (verts, faces, mat)

def quad_part(p0, p1, p2, p3, mat=0):
    # +X(전방) facing: p0 좌상, p1 우상, p2 우하, p3 좌하 (aero)
    return ([A(*p0), A(*p1), A(*p2), A(*p3)], [(0, 3, 2), (0, 2, 1)], mat)

def loft_part(stations, ring_n=24, cap_start=False, cap_end=False, mat=0):
    # stations: [(x, halfW, hTop, hBot, zc, nTop, nBot)] 기수 → 꼬리 순서 (바깥 법선)
    verts = []
    for (x, w, ht, hb, zc, nt, nb) in stations:
        for k in range(ring_n):
            th = 2 * math.pi * k / ring_n
            co, si = math.cos(th), math.sin(th)
            if si >= 0:
                y = w * sgn_pow(co, 2 / nt)
                z = zc + ht * sgn_pow(si, 2 / nt)
            else:
                y = w * sgn_pow(co, 2 / nb)
                z = zc + hb * sgn_pow(si, 2 / nb)
            verts.append(A(x, y, z))
    faces = []
    for i in range(len(stations) - 1):
        for k in range(ring_n):
            k2 = (k + 1) % ring_n
            a = i * ring_n + k
            b = (i + 1) * ring_n + k
            c = (i + 1) * ring_n + k2
            d = i * ring_n + k2
            faces.append((a, b, c, d))
    if cap_start:
        x, w, ht, hb, zc, nt, nb = stations[0]
        ci = len(verts)
        verts.append(A(x, 0, zc))
        for k in range(ring_n):
            faces.append((ci, (k + 1) % ring_n, k))
    if cap_end:
        x, w, ht, hb, zc, nt, nb = stations[-1]
        base = (len(stations) - 1) * ring_n
        ci = len(verts)
        verts.append(A(x, 0, zc))
        for k in range(ring_n):
            faces.append((ci, base + k, base + (k + 1) % ring_n))
    return (verts, faces, mat)

def wing_part(rootLE, rootTE, tipLE, tipTE, tdir, thick, u0=0, u1=1, v0=0, v1=1,
              nu=10, nv=5, camber=0.8, origin=None, notch=None, mat=0, te_rim=None):
    # aero 좌표 양력면 (three surface() 이식). notch=(vn, jog): 앞전 독투스
    def L3(a, b, t):
        return [a[i] + (b[i] - a[i]) * t for i in range(3)]
    def prof(u):
        return 4 * (math.sqrt(max(u, 0)) - u)
    def pt(u, v, side):
        vv = v
        if notch and v > notch[0]:
            vv = v - notch[1]
        le = L3(rootLE, tipLE, vv)
        te = L3(rootTE, tipTE, v)
        p = L3(le, te, u)
        chord = math.hypot(te[0] - le[0], te[1] - le[1], te[2] - le[2])
        t = 0.5 * lerp(thick[0], thick[1], v) * chord * prof(u) * (1 if side > 0 else camber)
        x = p[0] + tdir[0] * t * side
        y = p[1] + tdir[1] * t * side
        z = p[2] + tdir[2] * t * side
        if origin:
            x -= origin[0]
            y -= origin[1]
            z -= origin[2]
        return A(x, y, z)
    verts, faces = [], []
    W = nu + 1
    for side in (1, -1):
        base = len(verts)
        for j in range(nv + 1):
            v = lerp(v0, v1, j / nv)
            for i in range(nu + 1):
                u = lerp(u0, u1, i / nu)
                verts.append(pt(u, v, side))
        for j in range(nv):
            for i in range(nu):
                a = base + j * W + i
                b = base + j * W + i + 1
                c = base + (j + 1) * W + i + 1
                d = base + (j + 1) * W + i
                if side > 0:
                    faces.append((a, b, d))
                    faces.append((b, c, d))
                else:
                    faces.append((a, d, b))
                    faces.append((b, d, c))
    def edge_loop(lst):
        base = len(verts)
        for (u, v) in lst:
            verts.append(pt(u, v, 1))
            verts.append(pt(u, v, -1))
        for k in range(len(lst) - 1):
            a = base + k * 2
            faces.append((a, a + 1, a + 2))
            faces.append((a + 1, a + 3, a + 2))
    def along(fu, fv):
        lst = []
        if fu is not None:
            for j in range(nv + 1):
                lst.append((fu, lerp(v0, v1, j / nv)))
        else:
            for i in range(nu + 1):
                lst.append((lerp(u0, u1, i / nu), fv))
        return lst
    def te_web(lst, inset):
        # 조종면 틈: 뒤쪽을 보는 얇은 벽, 앞전 쪽으로 살짝 넣음
        base = len(verts)
        for (u, v) in lst:
            q1 = pt(u, v, 1)
            q2 = pt(u, v, -1)
            verts.append((q1[0], q1[1] + inset, q1[2]))
            verts.append((q2[0], q2[1] + inset, q2[2]))
        for k in range(len(lst) - 1):
            a = base + k * 2
            faces.append((a, a + 2, a + 1))
            faces.append((a + 1, a + 2, a + 3))
    if u0 > 0.001:
        edge_loop(along(u0, None))
    if te_rim is not None and te_rim < 0.999:
        te_web(along(te_rim, None), 0.03)
    edge_loop(along(None, v0))
    edge_loop(along(None, v1))
    # 좌우 미러(-y)된 부품은 와인딩이 뒤집히므로 되돌림 (바깥 법선 유지)
    if rootLE[1] < 0:
        faces = [tuple(reversed(f)) for f in faces]
    return (verts, faces, mat)

def arch_tube(x0, zc, rx, rz, tube_r=0.02, n_path=10, n_tube=6, mat=1):
    # 동체 단면(좌우) 타원 아치. Blender 좌표 직접 계산
    verts, faces = [], []
    for i in range(n_path + 1):
        a = math.pi * i / n_path
        ca, sa = math.cos(a), math.sin(a)
        for j in range(n_tube):
            b = 2 * math.pi * j / n_tube
            cb, sb = math.cos(b), math.sin(b)
            lat = (rx + tube_r * cb) * ca
            vert = zc + (rz + tube_r * cb) * sa
            ax = x0 + tube_r * sb
            verts.append((lat, ax, vert))
    for i in range(n_path):
        for j in range(n_tube):
            j2 = (j + 1) % n_tube
            a0 = i * n_tube + j
            b0 = (i + 1) * n_tube + j
            c0 = (i + 1) * n_tube + j2
            d0 = i * n_tube + j2
            faces.append((a0, b0, c0, d0))
    return (verts, faces, mat)

# ---------------- 고정 기체 ----------------
# 기수 (오자이브, 처짐)
nose_st = [
    (9.72, 0.012, 0.012, 0.012, -0.30, 2, 2), (9.55, 0.06, 0.055, 0.065, -0.28, 2, 2),
    (9.2, 0.15, 0.14, 0.17, -0.24, 2, 2), (8.8, 0.27, 0.25, 0.30, -0.18, 2, 2),
    (8.3, 0.40, 0.37, 0.43, -0.12, 2.1, 2), (7.8, 0.52, 0.48, 0.55, -0.05, 2.2, 2.2),
    (7.3, 0.58, 0.56, 0.63, 0.0, 2.4, 2.2), (7.0, 0.62, 0.60, 0.66, 0.04, 2.6, 2.2),
    (6.3, 0.64, 0.66, 0.60, 0.06, 2.8, 2.4), (5.4, 0.70, 0.72, 0.62, 0.02, 3.0, 2.6),
    (4.5, 0.80, 0.72, 0.75, 0.0, 3.2, 2.8), (3.6, 0.92, 0.70, 0.94, -0.02, 3.4, 3.0),
    (2.6, 0.98, 0.68, 0.96, -0.04, 3.6, 3.0), (1.6, 1.02, 0.66, 0.96, -0.05, 3.7, 3.0),
    (0.5, 1.04, 0.64, 0.96, -0.05, 3.8, 3.0),
]
# 중앙 동체 (리프팅 바디: 완만한 볼록 상면, 평평한 하면)
mid_st = [
    (4.7, 1.10, 0.50, 0.88, -0.12, 4.5, 3), (3.2, 1.40, 0.55, 1.12, -0.08, 4.5, 3),
    (0.5, 1.62, 0.60, 1.05, -0.06, 4.5, 3), (-2.5, 1.60, 0.58, 0.95, -0.06, 4.5, 3),
    (-5.0, 1.60, 0.56, 0.85, -0.06, 4.5, 3), (-6.6, 1.50, 0.50, 0.72, -0.06, 4, 3),
    (-7.5, 1.30, 0.44, 0.60, -0.06, 4, 3),
]
# 테일콘
tail_st = [
    (-6.6, 1.30, 0.45, 0.60, -0.06, 4, 3), (-7.5, 1.05, 0.38, 0.50, -0.06, 4, 3),
    (-8.3, 0.70, 0.30, 0.40, -0.06, 3.5, 2.5), (-9.0, 0.42, 0.22, 0.30, -0.06, 3, 2.5),
    (-9.35, 0.18, 0.12, 0.16, -0.06, 2.5, 2.5),
]

fuse_parts = []
fuse_parts.append(loft_part(nose_st, 28, cap_start=True, mat=0))
fuse_parts.append(loft_part(mid_st, 32, mat=0))
fuse_parts.append(loft_part(tail_st, 24, cap_end=True, mat=0))
# 엔진 나셀 2개
for sgn in (-1, 1):
    tube = []
    secs = [(-5.5, 0.64), (-6.2, 0.64), (-7.0, 0.63), (-7.8, 0.62)]
    nv, nf = [], []
    for si, (xx, rr) in enumerate(secs):
        for k in range(20):
            th = 2 * math.pi * k / 20
            nv.append(A(xx, sgn * 0.70 + rr * math.cos(th), -0.06 + rr * math.sin(th)))
    for si in range(len(secs) - 1):
        for k in range(20):
            k2 = (k + 1) % 20
            nv_idx_a = si * 20 + k
            nv_idx_b = (si + 1) * 20 + k
            nv_idx_c = (si + 1) * 20 + k2
            nv_idx_d = si * 20 + k2
            nf.append((nv_idx_a, nv_idx_b, nv_idx_c, nv_idx_d))
    fuse_parts.append((nv, nf, 0))
# 테일 붐 페어링 2개 (앞뒤로 가늘어짐)
for sgn in (-1, 1):
    boom = [
        (-4.2, 0.10, 0.20, 0.20, -0.08, 4, 4), (-6.5, 0.16, 0.25, 0.25, -0.08, 4, 4),
        (-8.8, 0.10, 0.18, 0.18, -0.08, 4, 4),
    ]
    bv, bf, _bm = loft_part(boom, 12, mat=0)
    bv = [(v[0] + sgn * 1.50, v[1], v[2]) for v in bv]
    fuse_parts.append((bv, bf, 0))
# 흡입구 덕트 + 입구 + 램프 + 분리판 + 립
for sgn in (-1, 1):
    duct = [
        (4.45, 0.55, 0.60, 0.90, -0.15, 14, 14), (3.4, 0.56, 0.60, 0.92, -0.14, 14, 14),
        (2.4, 0.57, 0.58, 0.92, -0.12, 14, 14), (1.4, 0.57, 0.56, 0.92, -0.10, 14, 14),
        (0.8, 0.50, 0.30, 0.90, -0.10, 14, 14),
    ]
    dv, df, _dm = loft_part(duct, 28, mat=0)
    dv = [(v[0] + sgn * 1.55, v[1], v[2]) for v in dv]
    fuse_parts.append((dv, df, 0))
    # 입구 어두운 면 (위 약 15도 앞으로 기울어짐)
    y0, y1 = sgn * 1.55 - 0.475, sgn * 1.55 + 0.475
    fuse_parts.append(quad_part((4.57, y0, 0.25), (4.57, y1, 0.25), (4.27, y1, -0.95), (4.27, y0, -0.95), 2))
    # 램프 (위에서 앞으로 숙임, 바깥 위 모서리 기울어짐)
    fuse_parts.append(quad_part((4.3, sgn * 1.55 - 0.53, 0.18), (4.3, sgn * 1.55 + 0.53, 0.12),
                               (3.4, sgn * 1.55 + 0.53, -0.50), (3.4, sgn * 1.55 - 0.53, -0.50), 1))
    # 분리판 (동체와 덕트 사이 얇은 판 + 틈)
    fuse_parts.append(box_part(1.7, 4.5, min(sgn * 0.92, sgn * 0.95), max(sgn * 0.92, sgn * 0.95), -0.6, 0.4, 0))
    # 상하 립
    fuse_parts.append(box_part(4.3, 4.75, sgn * 1.55 - 0.55, sgn * 1.55 + 0.55, 0.38, 0.48, 0))
    fuse_parts.append(box_part(4.15, 4.6, sgn * 1.55 - 0.55, sgn * 1.55 + 0.55, -1.02, -0.92, 0))
# 기관포 배출구 (우측), 피토관, 받음각 베인, 안테나, 테일후크, 기관포? 레일
fuse_parts.append(box_part(3.15, 3.65, 1.33, 1.37, 0.01, 0.19, 2))
fuse_parts.append(tube_part((9.35, 0.17, -0.22), (10.05, 0.19, -0.25), 0.012, 6, 3))
fuse_parts.append(box_part(8.54, 8.66, -0.34, -0.30, -0.16, -0.04, 3))
for (bx, by, bz, w, h, d) in [(1.2, 0, 0.95, 0.03, 0.35, 0.3), (-3.2, 0, 0.85, 0.03, 0.3, 0.3), (-1.0, 0, -0.95, 0.03, 0.3, 0.3)]:
    fuse_parts.append(box_part(bx - d / 2, bx + d / 2, by - w / 2, by + w / 2, bz - h / 2, bz + h / 2, 2))
fuse_parts.append(box_part(6.45, 6.75, -0.04, 0.04, -0.70, -0.54, 2))
hook = tube_part((-6.9, 0, -0.55), (-7.9, 0, -0.78), 0.035, 6, 2)
fuse_parts.append(hook)
# 기수 상면 무광 반사방지 패널 (어두운 회색, 데크 곡면을 따름)
_ag = [(6.4, 0.30, 0.718), (7.0, 0.30, 0.648), (7.6, 0.28, 0.51), (8.0, 0.26, 0.438)]
for _i in range(len(_ag) - 1):
    _x0, _w0, _z0 = _ag[_i]
    _x1, _w1, _z1 = _ag[_i + 1]
    _av = [A(_x0, -_w0, _z0), A(_x1, -_w1, _z1), A(_x1, _w1, _z1), A(_x0, _w0, _z0)]
    fuse_parts.append((_av, [(0, 1, 2), (0, 2, 3)], 2))
# LERX 스트레이크 (덕트 위 뒤쪽 → 주익 뿌리 앞전을 잇는 작은 삼각익)
for sgn in (-1, 1):
    sv, sf, _sm = wing_part((4.0, sgn * 1.80, 0.42), (2.2, sgn * 1.82, 0.30),
                            (1.7, sgn * 1.35, -0.05), (1.5, sgn * 1.40, -0.15),
                            (0, 0, 1), (0.03, 0.02), 0, 1, 0, 1, 4, 2, 1.0, None, None, 0)
    fuse_parts.append((sv, sf, 0))
# AIM-120 동체 레일 4개 (동체에 붙임)
for xx, yy in ((2.2, 1.47), (2.2, -1.47), (-2.6, 1.47), (-2.6, -1.47)):
    fuse_parts.append(box_part(xx - 0.9, xx + 0.9, yy - 0.07, yy + 0.07, -1.12, -0.98, 0))

def tapered_pylon(x0, x1, yc, ztop, zbot, hw=0.08):
    xm = (x0 + x1) / 2
    return loft_part([
        (x0, 0.015, 0.02, 0.02, (ztop + zbot) / 2, 4, 4),
        (xm - 0.3, hw, (ztop - zbot) / 2, (ztop - zbot) / 2, (ztop + zbot) / 2, 4, 4),
        (xm + 0.3, hw, (ztop - zbot) / 2, (ztop - zbot) / 2, (ztop + zbot) / 2, 4, 4),
        (x1, 0.015, 0.02, 0.02, (ztop + zbot) / 2, 4, 4),
    ], 10, mat=0)

# 파일런 (중앙 + 주익, 앞뒤 유선형, 날개에 붙임)
pv, pf, _pm = tapered_pylon(-2.3, 0.7, 0, -0.70, -1.20)
fuse_parts.append((pv, pf, 0))
for sgn in (-1, 1):
    pv, pf, _pm = tapered_pylon(-1.9, 0.7, sgn * 3.4, -0.36, -0.85)
    pv = [(v[0] + sgn * 3.4, v[1], v[2]) for v in pv]
    fuse_parts.append((pv, pf, 0))
    fuse_parts.append(box_part(-1.6, 0.6, sgn * 3.4 - 0.05, sgn * 3.4 + 0.05, -0.97, -0.85, 1))

fv, ff, fmats = merge(fuse_parts)
finish('fuselage', fv, ff, [M_SKIN, M_SKIN_DARK, M_DARK, M_GEAR], fmats, subdiv=2, bevel_w=0)

# ---------------- 캐노피 (별도 오브젝트, 뒷 힌지 피벗) ----------------
canopy_st = [
    (6.45, 0.08, 0.10, 0.35, 0.55, 2.5, 2.5), (6.05, 0.32, 0.38, 0.35, 0.55, 2.5, 2.5),
    (5.9, 0.45, 0.55, 0.35, 0.55, 2.5, 2.5),
    (5.2, 0.58, 0.70, 0.35, 0.55, 2.5, 2.5), (4.4, 0.62, 0.78, 0.35, 0.55, 2.5, 2.5),
    (3.6, 0.58, 0.66, 0.35, 0.55, 2.5, 2.5), (3.0, 0.40, 0.36, 0.35, 0.55, 2.5, 2.5),
    (2.7, 0.10, 0.08, 0.35, 0.55, 2.5, 2.5), (2.1, 0.05, 0.05, 0.3, 0.55, 2.5, 2.5),
]
cv, cf, _cm = loft_part(canopy_st, 20, cap_start=True, cap_end=True, mat=0)
hinge_c = (2.9, 0, 0.6)
cv = [(v[0] - hinge_c[1], v[1] - hinge_c[0], v[2] - hinge_c[2]) for v in cv]
def _arch_on_glass(target_x):
    bi, bd = 0, 1e9
    for i, st in enumerate(canopy_st):
        d = abs(st[0] - target_x)
        if d < bd:
            bd, bi = d, i
    ring = [cv[bi * 20 + k] for k in range(20)]
    cx = sum(p[0] for p in ring) / 20
    cz = sum(p[2] for p in ring) / 20
    pts = []
    for k in range(21):
        p = ring[k % 20]
        dx, dz = p[0] - cx, p[2] - cz
        if dz < -0.05 and k not in (0, 20):
            pts.append(None)
            continue
        L = math.hypot(dx, dz) or 1.0
        pts.append((p[0] + dx / L * 0.008, p[1], p[2] + dz / L * 0.008))
    segs, cur = [], []
    for p in pts:
        if p is None:
            if len(cur) > 1:
                segs.append(cur)
            cur = []
        else:
            cur.append(p)
    if len(cur) > 1:
        segs.append(cur)
    verts, faces, nt = [], [], 6
    for seg in segs:
        base = len(verts)
        for i in range(len(seg) - 1):
            p0, p1 = seg[i], seg[i + 1]
            dd = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
            L = math.sqrt(sum(v * v for v in dd)) or 1.0
            dd = [v / L for v in dd]
            up = [0, 0, 1] if abs(dd[2]) < 0.9 else [0, 1, 0]
            e1 = [up[1] * dd[2] - up[2] * dd[1], up[2] * dd[0] - up[0] * dd[2], up[0] * dd[1] - up[1] * dd[0]]
            n1 = math.sqrt(sum(v * v for v in e1)) or 1.0
            e1 = [v / n1 for v in e1]
            e2 = [dd[1] * e1[2] - dd[2] * e1[1], dd[2] * e1[0] - dd[0] * e1[2], dd[0] * e1[1] - dd[1] * e1[0]]
            for j in range(nt):
                th = 2 * math.pi * j / nt
                for p in (p0, p1):
                    verts.append((p[0] + 0.02 * (math.cos(th) * e1[0] + math.sin(th) * e2[0]),
                                  p[1] + 0.02 * (math.cos(th) * e1[1] + math.sin(th) * e2[1]),
                                  p[2] + 0.02 * (math.cos(th) * e1[2] + math.sin(th) * e2[2])))
        for i in range(len(seg) - 1):
            for j in range(nt):
                j2 = (j + 1) % nt
                a0 = base + i * 2 * nt + j
                b0 = base + i * 2 * nt + nt + j
                c0 = base + i * 2 * nt + nt + j2
                d0 = base + i * 2 * nt + j2
                faces.append((a0, b0, c0, d0))
    return (verts, faces, 1)
arch1 = _arch_on_glass(5.55)
arch2 = _arch_on_glass(3.3)
sills = []
for sgn in (-1, 1):
    sills.append(box_part(3.1 - hinge_c[0], 6.0 - hinge_c[0], sgn * 0.58 - 0.025 - hinge_c[1],
                          sgn * 0.58 + 0.025 - hinge_c[1], 0.575 - hinge_c[2], 0.625 - hinge_c[2], 1))
# 윈드실드 기둥 2개 + 중앙 포스트 (유리 곡면을 따르는 얇은 프레임)
_wshield = []
for _p0, _p1, _r in (((6.1, -0.45, 0.62), (5.2, -0.42, 1.02), 0.018),
                    ((6.1, 0.45, 0.62), (5.2, 0.42, 1.02), 0.018),
                    ((6.15, 0, 0.60), (5.45, 0, 1.08), 0.015)):
    _tv, _tf, _tm = tube_part(_p0, _p1, _r, 6, 1)
    _tv = [(v[0], v[1] - 2.9, v[2] - 0.6) for v in _tv]
    _wshield.append((_tv, _tf, 1))
cparts = [(cv, cf, 0), arch1, arch2] + sills + _wshield
cav, caf, cafm = merge(cparts)
finish('canopy', cav, caf, [M_GLASS, M_DARK], cafm, origin=A(*hinge_c), subdiv=2, bevel_w=0)

# ---------------- 주익 + 조종면 ----------------
def surf_origin(spec, u0, v0):
    def L3(a, b, t):
        return [a[i] + (b[i] - a[i]) * t for i in range(3)]
    h0 = L3(L3(spec[0], spec[2], v0), L3(spec[1], spec[3], v0), u0)
    return h0

for sgn, tag in ((1, 'R'), (-1, 'L')):
    rootLE = (1.9, sgn * 1.2, -0.28)
    rootTE = (-3.08, sgn * 1.2, -0.28)
    tipLE = (-3.4, sgn * 6.525, -0.37)
    tipTE = (-4.8, sgn * 6.525, -0.37)
    spec = (rootLE, rootTE, tipLE, tipTE)
    patches = [
        wing_part(rootLE, rootTE, tipLE, tipTE, (0, 0, 1), (0.06, 0.035), 0, 1, 0, 0.06, 8, 1, 0.7, None, 0),
        wing_part(rootLE, rootTE, tipLE, tipTE, (0, 0, 1), (0.06, 0.035), 0, 0.72, 0.06, 0.52, 8, 3, 0.7, None, 0, te_rim=0.72),
        wing_part(rootLE, rootTE, tipLE, tipTE, (0, 0, 1), (0.06, 0.035), 0, 1, 0.52, 0.60, 8, 1, 0.7, None, 0),
        wing_part(rootLE, rootTE, tipLE, tipTE, (0, 0, 1), (0.06, 0.035), 0, 0.74, 0.60, 0.92, 8, 2, 0.7, None, 0, te_rim=0.74),
        wing_part(rootLE, rootTE, tipLE, tipTE, (0, 0, 1), (0.06, 0.035), 0, 1, 0.92, 1, 8, 1, 0.7, None, 0),
    ]
    wv, wf, wfm = merge(patches)
    finish('wing_' + tag, wv, wf, [M_SKIN], wfm, subdiv=2, bevel_w=0)
    # 플랩
    h0 = surf_origin(spec, 0.72, 0.06)
    fv2, ff2, _f = wing_part(rootLE, rootTE, tipLE, tipTE, (0, 0, 1), (0.06, 0.035), 0.72, 1, 0.06, 0.52, 5, 4, 0.7, h0, 0)
    fvv, fff, fffm = merge([(fv2, ff2, 0)])
    finish('flap_' + tag, fvv, fff, [M_SKIN], fffm, origin=A(*h0), subdiv=1, bevel_w=0.015)
    # 에일러론
    h1 = surf_origin(spec, 0.74, 0.60)
    av, af, _a = wing_part(rootLE, rootTE, tipLE, tipTE, (0, 0, 1), (0.06, 0.035), 0.74, 1, 0.60, 0.92, 5, 3, 0.7, h1, 0)
    avv, aff, affm = merge([(av, af, 0)])
    finish('ail_' + tag, avv, aff, [M_SKIN], affm, origin=A(*h1), subdiv=1, bevel_w=0.015)

# ---------------- 수평미익 (전가동, 독투스 노치) ----------------
for sgn, tag in ((1, 'R'), (-1, 'L')):
    rootLE = (-5.2, sgn * 1.76, -0.1)
    rootTE = (-8.9, sgn * 1.76, -0.1)
    tipLE = (-8.2, sgn * 4.3, -0.1)
    tipTE = (-9.35, sgn * 4.3, -0.1)
    piv = (-7.0, sgn * 1.76, -0.1)
    sv, sf, _s = wing_part(rootLE, rootTE, tipLE, tipTE, (0, 0, 1), (0.045, 0.028),
                           0, 1, 0, 1, 10, 5, 1.0, piv, (0.5, 0.1), 0)
    svv, sff, sffm = merge([(sv, sf, 0)])
    finish('stab_' + tag, svv, sff, [M_SKIN], sffm, origin=A(*piv), subdiv=2, bevel_w=0)

# ---------------- 수직미익 + 러더 ----------------
for sgn, tag in ((1, 'R'), (-1, 'L')):
    rootLE = (-4.7, sgn * 1.50, 0.3)
    rootTE = (-8.15, sgn * 1.50, 0.3)
    tipLE = (-6.8, sgn * 1.50, 3.3)
    tipTE = (-7.9, sgn * 1.50, 3.45)
    spec = (rootLE, rootTE, tipLE, tipTE)
    patches = [
        wing_part(rootLE, rootTE, tipLE, tipTE, (0, 1, 0), (0.065, 0.045), 0, 1, 0.55, 1, 10, 3, 1.0, None, 0),
        wing_part(rootLE, rootTE, tipLE, tipTE, (0, 1, 0), (0.065, 0.045), 0, 0.68, 0, 0.55, 10, 4, 1.0, None, 0, te_rim=0.68),
        # 앞전 아래 필릿 (수평미익 위 노치)
        wing_part((-3.2, sgn * 1.50, 0.45), (-4.6, sgn * 1.50, 0.45), (-4.4, sgn * 1.50, 0.9), (-4.9, sgn * 1.50, 0.9),
                  (0, 1, 0), (0.035, 0.035), 0, 1, 0, 1, 4, 2, 1.0, None, 0),
    ]
    # 미익 끝 ECM 캡
    patches.append(box_part(-7.7, -6.9, sgn * 1.50 - 0.07, sgn * 1.50 + 0.07, 3.35, 3.55, 0))
    vvv, vff, vffm = merge(patches)
    finish('fin_' + tag, vvv, vff, [M_SKIN], vffm, subdiv=2, bevel_w=0)
    h0 = surf_origin(spec, 0.68, 0.02)
    rv, rf, _r = wing_part(rootLE, rootTE, tipLE, tipTE, (0, 1, 0), (0.065, 0.045), 0.68, 1, 0.02, 0.55, 5, 4, 1.0, h0, 0)
    rvv, rff, rffm = merge([(rv, rf, 0)])
    finish('rud_' + tag, rvv, rff, [M_SKIN], rffm, origin=A(*h0), subdiv=1, bevel_w=0.015)

# ---------------- 노즐 (15 페탈 느낌, 별도 피벗) ----------------
for sgn, tag in ((1, 'R'), (-1, 'L')):
    oy, ox, oz = sgn * 0.70, -7.8, -0.06
    parts = []
    # 외곽 원뿔 (15각, 짝수 세그먼트 약간 부풀림)
    rings = [(0.0, 0.63), (0.4, 0.60), (0.8, 0.57), (1.2, 0.55)]
    ov, of = [], []
    for zi, (zz, rr) in enumerate(rings):
        for k in range(15):
            th = 2 * math.pi * k / 15
            bump = 0.02 * (k % 2) * math.sin(math.pi * zi / (len(rings) - 1))
            ov.append(A(ox - zz, oy + (rr + bump) * math.cos(th), oz + (rr + bump) * math.sin(th)))
    for zi in range(len(rings) - 1):
        for k in range(15):
            k2 = (k + 1) % 15
            ov_a = zi * 15 + k
            ov_b = (zi + 1) * 15 + k
            ov_c = (zi + 1) * 15 + k2
            ov_d = zi * 15 + k2
            of.append((ov_a, ov_b, ov_c, ov_d))
    parts.append((ov, of, 0))
    # 내부 어두운 원뿔 (뒤집힘)
    iv, iif = [], []
    for zi, (zz, rr) in enumerate([(0.1, 0.56), (0.6, 0.52), (1.05, 0.48)]):
        for k in range(15):
            th = 2 * math.pi * k / 15
            iv.append(A(ox - zz, oy + rr * math.cos(th), oz + rr * math.sin(th)))
    for zi in range(2):
        for k in range(15):
            k2 = (k + 1) % 15
            iif.append(((zi + 1) * 15 + k, zi * 15 + k, zi * 15 + k2, (zi + 1) * 15 + k2))
    parts.append((iv, iif, 1))
    # 터빈면
    tv = [A(ox - 0.12, oy, oz)]
    for k in range(15):
        th = 2 * math.pi * k / 15
        tv.append(A(ox - 0.12, oy + 0.46 * math.cos(th), oz + 0.46 * math.sin(th)))
    tf = [(0, k + 1, (k + 1) % 15 + 1) for k in range(15)]
    parts.append((tv, tf, 1))
    nv, nf, nfm = merge(parts)
    nv = [(v[0] - oy, v[1] - ox, v[2] - oz) for v in nv]
    finish('nozzle_' + tag, nv, nf, [M_NOZZLE, M_DARK], nfm, origin=A(ox, oy, oz), subdiv=1, bevel_w=0)

# ---------------- 스피드브레이크 ----------------
sb_piv = (2.6, 0, 0.56)
sbv, sbf, _sb = box_part(1.4 - sb_piv[0], 2.6 - sb_piv[0], -1.1, 1.1, 0.56 - sb_piv[2], 0.60 - sb_piv[2], 0)
sbvv, sbff, sbffm = merge([(sbv, sbf, 0)])
finish('speedbrake', sbvv, sbff, [M_SKIN], sbffm, origin=A(*sb_piv), subdiv=0, bevel_w=0)

# ---------------- 조종석 내부 (무광 검정 글레어실드 + HUD + 계기판) ----------------
ck_parts = []
# 둥글게 감싸는 글레어실드 (가로 롤 + 양옆 패드)
ck_parts.append(tube_part((5.78, -0.35, 0.74), (5.78, 0.35, 0.74), 0.085, 12, 0))
ck_parts.append(box_part(5.66, 5.90, -0.44, -0.30, 0.64, 0.74, 0))
ck_parts.append(box_part(5.66, 5.90, 0.30, 0.44, 0.64, 0.74, 0))
# 계기판 + MFD 베젤/화면 3개
ck_parts.append(box_part(5.42, 5.52, -0.32, 0.32, 0.28, 0.62, 0))
for _yy in (-0.22, 0.0, 0.22):
    ck_parts.append(box_part(5.40, 5.44, _yy - 0.09, _yy + 0.09, 0.38, 0.54, 1))
    ck_parts.append(box_part(5.395, 5.405, _yy - 0.07, _yy + 0.07, 0.40, 0.52, 1))
# HUD 컴바이너 (얇은 유리 2장 + 가는 기둥 + 받침)
ck_parts.append(box_part(5.65, 5.67, -0.065, 0.065, 0.80, 1.04, 2))
ck_parts.append(box_part(5.75, 5.77, -0.065, 0.065, 0.80, 1.04, 2))
ck_parts.append(box_part(5.62, 5.78, -0.085, -0.065, 0.78, 1.02, 1))
ck_parts.append(box_part(5.62, 5.78, 0.065, 0.085, 0.78, 1.02, 1))
ck_parts.append(box_part(5.60, 5.80, -0.10, 0.10, 0.76, 0.80, 1))
# 사이드 콘솔 + 바닥
ck_parts.append(box_part(4.2, 5.3, -0.50, -0.38, 0.50, 0.62, 0))
ck_parts.append(box_part(4.2, 5.3, 0.38, 0.50, 0.50, 0.62, 0))
ck_parts.append(box_part(3.6, 5.3, -0.40, 0.40, 0.24, 0.30, 0))
ckv, ckf, ckfm = merge(ck_parts)
finish('cockpit', ckv, ckf, [M_COCKPIT, M_DARK, M_GLASS], ckfm, subdiv=1, bevel_w=0)

# ---------------- 착륙장치 (Blender 좌표 직접 계산, 차축 = X 방향) ----------------
def gear_wheel(r, wdt, mat_tire, mat_hub):
    # 차축이 Blender X(좌우) 방향 바퀴, 원점 중심
    parts = []
    tv, tf = [], []
    n = 16
    for xx in (-wdt / 2, wdt / 2):
        for k in range(n):
            th = 2 * math.pi * k / n
            tv.append((xx, r * math.cos(th), r * math.sin(th)))
    for k in range(n):
        k2 = (k + 1) % n
        tf.append((k, k2, k2 + n, k + n))
    parts.append((tv, tf, mat_tire))
    hv, hf = [], []
    for xx in (-wdt / 2 - 0.005, wdt / 2 + 0.005):
        for k in range(12):
            th = 2 * math.pi * k / 12
            hv.append((xx, r * 0.55 * math.cos(th), r * 0.55 * math.sin(th)))
    for k in range(12):
        k2 = (k + 1) % 12
        hf.append((k, k2, k2 + 12, k + 12))
    cap = len(hv)
    hv.append((-wdt / 2 - 0.005, 0, 0))
    for k in range(12):
        hf.append((cap, k, (k + 1) % 12))
    cap2 = len(hv)
    hv.append((wdt / 2 + 0.005, 0, 0))
    for k in range(12):
        hf.append((cap2, k + 12, (k + 1) % 12 + 12))
    parts.append((hv, hf, mat_hub))
    return parts

def shift_verts(verts, dx, dy, dz):
    return [(v[0] + dx, v[1] + dy, v[2] + dz) for v in verts]

# 전륜 (피벗 = 힌지)
hx, hy, hz = 4.4, 0, -0.85
gp = []
sv, sf, _sm = tube_part((0, 0, 0), (0, 0, -1.06), 0.06, 8, 0)
gp.append((sv, sf, 0))
for off in (-0.13, 0.13):
    for pv, pf, pm in gear_wheel(0.29, 0.18, 1, 0):
        gp.append((shift_verts(pv, off, 0, -1.06), pf, pm))
for sgn in (-1, 1):
    dv, df, _dm = box_part(3.9, 4.9, min(sgn * 0.16, sgn * 0.20), max(sgn * 0.16, sgn * 0.20), -1.75, -0.90, 0)
    gp.append((shift_verts(dv, -hy, -hx, -hz), df, 0))
gv, gf, gfm = merge(gp)
finish('gear_N', gv, gf, [M_GEAR, M_TIRE], gfm, origin=A(hx, hy, hz), subdiv=0, bevel_w=0)

# 주륜
for sgn, tag in ((-1, 'L'), (1, 'R')):
    hx, hy, hz = -0.75, sgn * 1.38, -0.70
    gp = []
    sv, sf, _sm = tube_part((0, 0, 0), (0, 0, -1.08), 0.07, 8, 0)
    gp.append((sv, sf, 0))
    for pv, pf, pm in gear_wheel(0.42, 0.25, 1, 0):
        gp.append((shift_verts(pv, 0, 0, -1.08), pf, pm))
    dv, df, _dm = box_part(-1.35, -0.15, min(sgn * 1.36, sgn * 1.40), max(sgn * 1.36, sgn * 1.40), -1.20, -0.30, 0)
    gp.append((shift_verts(dv, -hy, -hx, -hz), df, 0))
    gv, gf, gfm = merge(gp)
    finish('gear_' + tag, gv, gf, [M_GEAR, M_TIRE], gfm, origin=A(hx, hy, hz), subdiv=0, bevel_w=0)

print('objects:', len(MODEL_OBJS))

# ---------------- 스무딩 + UV ----------------
try:
    bpy.ops.object.select_all(action='DESELECT')
    for o in MODEL_OBJS:
        o.select_set(True)
    bpy.context.view_layer.objects.active = MODEL_OBJS[0]
    bpy.ops.object.shade_smooth()
    print('shade smooth ok')
except Exception as e:
    print('shade smooth skip:', e)

for o in MODEL_OBJS:
    try:
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=66, island_margin=0.02)
        bpy.ops.object.mode_set(mode='OBJECT')
    except Exception as e:
        try:
            bpy.ops.object.mode_set(mode='OBJECT')
        except Exception:
            pass
        print('UV skip:', o.name)

# ---------------- 확인용 렌더 6장 (Workbench + 3점 조명 + 회색 배경) ----------------
import mathutils
scene = bpy.context.scene
shading = scene.display.shading
try:
    shading.light = 'STUDIO'
except Exception:
    pass
try:
    shading.color_type = 'MATERIAL'
except Exception:
    pass
try:
    shading.show_cavity = True
    shading.cavity_type = 'SCREEN'
except Exception:
    pass
try:
    shading.show_shadows = True
    shading.shadow_intensity = 0.4
except Exception:
    pass
# 회색 월드 배경
world = bpy.data.worlds.new('prev_world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.45, 0.47, 0.5, 1.0)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
scene.world = world
try:
    shading.background_type = 'WORLD'
except Exception:
    pass
try:
    shading.use_scene_lights = True
    shading.use_scene_lights_render = True
    shading.use_scene_world = True
    shading.use_scene_world_render = True
except Exception:
    pass
# 3점 조명 (썬 3개)
for lname, lpos, energy in (('key', (12, 18, 10), 3.0), ('fill', (-14, 6, 4), 0.8), ('rim', (-6, -16, 8), 1.5)):
    ld = bpy.data.lights.new(lname, 'SUN')
    ld.energy = energy
    lo = bpy.data.objects.new(lname, ld)
    scene.collection.objects.link(lo)
    lo.location = lpos
    d = mathutils.Vector((0, 0.5, 0.3)) - mathutils.Vector(lpos)
    lo.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
cam_data = bpy.data.cameras.new('prev_cam')
cam_data.lens = 50
cam = bpy.data.objects.new('prev_cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
# 기체 바운딩 박스 (월드 좌표)
allmin = [1e9, 1e9, 1e9]
allmax = [-1e9, -1e9, -1e9]
for o in MODEL_OBJS:
    lx, ly, lz = o.location[0], o.location[1], o.location[2]
    for v in o.data.vertices:
        wx, wy, wz = v.co[0] + lx, v.co[1] + ly, v.co[2] + lz
        allmin[0] = min(allmin[0], wx)
        allmin[1] = min(allmin[1], wy)
        allmin[2] = min(allmin[2], wz)
        allmax[0] = max(allmax[0], wx)
        allmax[1] = max(allmax[1], wy)
        allmax[2] = max(allmax[2], wz)
print('bounds:', allmin, allmax)
center = [(allmin[i] + allmax[i]) / 2 for i in range(3)]
corners = [[allmin[0] if i & 1 else allmax[0], allmin[1] if i & 2 else allmax[1], allmin[2] if i & 4 else allmax[2]] for i in range(8)]
tan_v = math.tan(math.radians(27.0) / 2)
tan_h = math.tan(math.radians(39.6) / 2)
views = {
    'preview_front_level': ((0.08, -1, -0.02), 50, None),
    'preview_side': ((1, 0.04, -0.06), 50, None),
    'preview_top': ((0, 0, -1), 50, None),
    'preview_bottom': ((0.2, -0.3, 1), 50, None),
    'preview_tqf': ((-0.5, -0.7, -0.4), 50, None),
    'preview_tqr': ((0.5, 0.7, -0.35), 50, None),
    'preview_cockpit': ((0, -1, -0.07), 15, 'cockpit'),
}
for vname, (vdir, lens, mode) in views.items():
    cam_data.lens = lens
    if mode == 'cockpit':
        # 1인칭 시점 (게임 카메라와 동일 위치): 캐노피 유리는 가림, 그림자 끔
        try:
            bpy.data.objects['canopy'].hide_render = True
            bpy.data.objects['cockpit'].hide_render = True
        except KeyError:
            pass
        try:
            shading.show_shadows = False
            shading.show_cavity = False
        except Exception:
            pass
        cam.location = (0, 4.75, 1.12)
        dd = mathutils.Vector(vdir).normalized()
        cam.rotation_euler = dd.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(PREV_DIR, vname + '.png')
        bpy.ops.render.render(write_still=True)
        try:
            bpy.data.objects['canopy'].hide_render = False
            bpy.data.objects['cockpit'].hide_render = False
        except KeyError:
            pass
        try:
            shading.show_shadows = True
            shading.show_cavity = True
        except Exception:
            pass
        print('rendered:', vname, '1인칭')
        continue
    vfov = 2 * math.atan(12 / lens)
    hfov = 2 * math.atan(18 / lens)
    tan_v = math.tan(vfov / 2)
    tan_h = math.tan(hfov / 2)
    dd = mathutils.Vector(vdir).normalized()
    need = 0
    for c in corners:
        rel = mathutils.Vector((c[0] - center[0], c[1] - center[1], c[2] - center[2]))
        along = rel.dot(dd)
        perp = rel - along * dd
        up = abs(perp.z)
        side = (perp - perp.z * mathutils.Vector((0, 0, 1))).length
        need = max(need, up / tan_v - along, side / tan_h - along)
    dist = need * 1.1 + 0.5
    cam.location = (center[0] - dd[0] * dist, center[1] - dd[1] * dist, center[2] - dd[2] * dist)
    cam.rotation_euler = dd.to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(PREV_DIR, vname + '.png')
    bpy.ops.render.render(write_still=True)
    print('rendered:', vname, 'dist %.1f' % dist)

# ---------------- GLB 내보내기 ----------------
bpy.ops.object.select_all(action='DESELECT')
for o in MODEL_OBJS:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=GLB_PATH, export_format='GLB', use_selection=True,
                          export_apply=True, export_yup=True)
print('exported:', GLB_PATH)
