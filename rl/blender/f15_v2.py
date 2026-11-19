#!/usr/bin/env python3
# F-15C v2 (spec-driven, from scratch). DO NOT touch v1 files.
# Run: & "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python rl/blender/f15_v2.py
# Coordinates: aero(x fwd, y right, z up) -> Blender (y, x, z). x = 10.05 - s.
import bpy, math, os, json
import mathutils

bpy.ops.wm.read_factory_settings(use_empty=True)
try:
    bpy.ops.preferences.addon_enable(module='io_scene_gltf2')
except Exception as e:
    print('addon enable:', e)

WS = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(WS, 'rl', 'blender', 'v2')
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(os.path.join(WS, 'src', 'models'), exist_ok=True)
GLB_PATH = os.path.join(WS, 'src', 'models', 'f15c_v2.glb')

MODEL_OBJS = []
ARCH_PATHS = []  # Blender-local path points per arch, for axis-centered audit

def A(x, y, z):
    return (y, x, z)

def s2x(s):
    return 10.05 - s

def lerp(a, b, t):
    return a + (b - a) * t

def sgn_pow(v, e):
    return math.copysign(abs(v) ** e, v) if v != 0 else 0.0

# ---------------- materials (exact 7 names) ----------------
def make_mat(name, color, metallic=0.0, roughness=0.6):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    try:
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        if bsdf is not None:
            if 'Base Color' in bsdf.inputs:
                bsdf.inputs['Base Color'].default_value = (*color, 1.0)
            if 'Metallic' in bsdf.inputs:
                try: bsdf.inputs['Metallic'].default_value = metallic
                except Exception: pass
            if 'Roughness' in bsdf.inputs:
                bsdf.inputs['Roughness'].default_value = roughness
    except Exception as e:
        print('mat warn', name, e)
    return m

M_SKIN = make_mat('skin', (0.55, 0.59, 0.64), 0.15, 0.6)
M_SKIN_DARK = make_mat('skin_dark', (0.36, 0.39, 0.43), 0.15, 0.65)
M_NOZZLE = make_mat('metal_nozzle', (0.40, 0.33, 0.28), 0.9, 0.45)
M_GLASS = make_mat('glass', (0.55, 0.62, 0.70), 0.1, 0.15)
M_COCKPIT = make_mat('cockpit', (0.08, 0.09, 0.10), 0.1, 0.85)
M_TIRE = make_mat('tire', (0.05, 0.05, 0.05), 0.0, 0.95)
M_GEAR = make_mat('gear', (0.62, 0.63, 0.64), 0.0, 0.8)
GRAY_CLAY = make_mat('v2_clay_gray', (0.62, 0.62, 0.62), 0.0, 0.9)

# ---------------- mesh helpers ----------------
def finish(name, verts, faces, mats, face_mats=None, origin=(0, 0, 0), subdiv=1):
    me = bpy.data.meshes.new(name + '_mesh')
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for m in mats:
        me.materials.append(m)
    if face_mats:
        for i, mi in enumerate(face_mats):
            try: me.polygons[i].material_index = mi
            except Exception: pass
    ob.location = origin
    if subdiv and subdiv > 0:
        s = ob.modifiers.new('Smooth', 'SUBSURF')
        s.levels = subdiv
        s.render_levels = subdiv
    MODEL_OBJS.append(ob)
    print('mesh ok:', name, len(verts), len(faces), flush=True)
    return ob

def apply_part_uv(ob, uvlist):
    # overwrite first len(uvlist) mesh verts' UVs with exact meter UVs (merged order preserved).
    # must run AFTER Smart UV so a UV layer exists; uv writes are deferred via APPLY_UV.
    try:
        me = ob.data
        uv = me.uv_layers.active
        if uv is None:
            print('apply_part_uv no-uv:', ob.name)
            return
        data = uv.data
        n = 0
        for p in me.polygons:
            for li in p.loop_indices:
                vi = me.loops[li].vertex_index
                if vi < len(uvlist):
                    data[li].uv = uvlist[vi]
                    n += 1
        print('apply_part_uv %s: %d loops' % (ob.name, n))
    except Exception as e:
        print('apply_part_uv skip:', ob.name, e)

APPLY_UV = []

def merge(parts):
    verts, faces, fm = [], [], []
    for pv, pf, mi in parts:
        base = len(verts)
        verts.extend(pv)
        for f in pf:
            faces.append(tuple(v + base for v in f))
        fm.extend([mi] * len(pf))
    return verts, faces, fm

def box_part(x0, x1, y0, y1, z0, z1, mat=0):
    c = [A(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    F = [(0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5), (0, 2, 3, 1), (4, 5, 7, 6)]
    return (c, F, mat)

def tube_part(p0, p1, r, n=10, mat=0, cap0=True, cap1=True):
    a = [p1[i] - p0[i] for i in range(3)]
    L = math.sqrt(sum(v * v for v in a)) or 1.0
    d = [v / L for v in a]
    up = [0, 0, 1] if abs(d[2]) < 0.9 else [0, 1, 0]
    e1 = [up[1]*d[2]-up[2]*d[1], up[2]*d[0]-up[0]*d[2], up[0]*d[1]-up[1]*d[0]]
    n1 = math.sqrt(sum(v*v for v in e1)) or 1.0
    e1 = [v/n1 for v in e1]
    e2 = [d[1]*e1[2]-d[2]*e1[1], d[2]*e1[0]-d[0]*e1[2], d[0]*e1[1]-d[1]*e1[0]]
    verts = []
    for p in (p0, p1):
        for k in range(n):
            t = 2*math.pi*k/n
            verts.append(A(p[0]+r*(math.cos(t)*e1[0]+math.sin(t)*e2[0]),
                           p[1]+r*(math.cos(t)*e1[1]+math.sin(t)*e2[1]),
                           p[2]+r*(math.cos(t)*e1[2]+math.sin(t)*e2[2])))
    faces = []
    for k in range(n):
        k2 = (k+1) % n
        faces.append((k, k+n, k2+n, k2))
    if cap0:
        c0 = len(verts); verts.append(A(*p0))
        for k in range(n):
            faces.append((c0, k, (k+1)%n))
    if cap1:
        c1 = len(verts); verts.append(A(*p1))
        for k in range(n):
            faces.append((c1, (k+1)%n+n, k+n))
    return (verts, faces, mat)

# swept tube along an arbitrary path (parallel-transport frames); used for canopy arches + inlet lip
def sweep_tube(pts, r, n=6, mat=0, radii=None):
    P = [list(p) for p in pts]
    npts = len(P)
    if radii is None:
        radii = [r]*npts
    tans = []
    for i in range(npts):
        a = P[max(0, i-1)]; b = P[min(npts-1, i+1)]
        d = [b[j]-a[j] for j in range(3)]; L = math.sqrt(sum(v*v for v in d)) or 1.0
        tans.append([v/L for v in d])
    def _perp(t):
        up = [0, 0, 1] if abs(t[2]) < 0.9 else [0, 1, 0]
        e = [up[1]*t[2]-up[2]*t[1], up[2]*t[0]-up[0]*t[2], up[0]*t[1]-up[1]*t[0]]
        L = math.sqrt(sum(v*v for v in e)) or 1.0
        return [v/L for v in e]
    n0 = _perp(tans[0])
    bb0 = [tans[0][1]*n0[2]-tans[0][2]*n0[1], tans[0][2]*n0[0]-tans[0][0]*n0[2], tans[0][0]*n0[1]-tans[0][1]*n0[0]]
    normals = [n0]; binorms = [bb0]
    for i in range(1, npts):
        pn = normals[-1]; t = tans[i]
        dd = sum(pn[j]*t[j] for j in range(3))
        nn = [pn[j]-dd*t[j] for j in range(3)]; L = math.sqrt(sum(v*v for v in nn)) or 1.0
        nn = [v/L for v in nn]
        bb = [t[1]*nn[2]-t[2]*nn[1], t[2]*nn[0]-t[0]*nn[2], t[0]*nn[1]-t[1]*nn[0]]
        normals.append(nn); binorms.append(bb)
    verts = []
    for i in range(npts):
        rr = radii[i] if i < len(radii) else r
        for k in range(n):
            a = 2*math.pi*k/n
            verts.append((P[i][0]+rr*(math.cos(a)*normals[i][0]+math.sin(a)*binorms[i][0]),
                          P[i][1]+rr*(math.cos(a)*normals[i][1]+math.sin(a)*binorms[i][1]),
                          P[i][2]+rr*(math.cos(a)*normals[i][2]+math.sin(a)*binorms[i][2])))
    faces = []
    for i in range(npts-1):
        for k in range(n):
            k2 = (k+1) % n
            faces.append((i*n+k, i*n+k2, (i+1)*n+k2, (i+1)*n+k))
    return (verts, faces, mat)

# fuselage loft: stations as dicts
def loft_fuse(stations, ring_n=32, cap_start=True, cap_end=False):
    verts = []
    for st in stations:
        x, w = st['x'], st['halfW']
        top, bot, zc = st['top'], st['bot'], st['zc']
        ht, hb = top - zc, zc - bot
        nt, nb = st.get('nt', 3.0), st.get('nb', 2.6)
        spine, groove = st.get('spine', 0.0), st.get('groove', 0.0)
        keel, keel_c, lobe = st.get('keel', 0.0), st.get('keel_c', 0.8), st.get('lobe', 0.0)
        for k in range(ring_n):
            th = 2*math.pi*k/ring_n
            co, si = math.cos(th), math.sin(th)
            if si >= 0:
                y = w * sgn_pow(co, 2/nt)
                z = zc + ht * sgn_pow(si, 2/nt)
            else:
                y = w * sgn_pow(co, 2/nb)
                z = zc + hb * sgn_pow(si, 2/nb)
            if si > 0.15:
                q = abs(y)
                if spine > 0:
                    z += spine * math.exp(-((q/0.38) ** 2)) * min(1.0, si*2)
                if groove > 0:
                    z -= groove * math.exp(-((q/0.55) ** 2)) * min(1.0, si*2)
            if si < -0.15:
                q = abs(y)
                if keel > 0:
                    z += keel * math.exp(-(((q-keel_c)/0.30) ** 2)) * min(1.0, -si*2)
                if lobe > 0:
                    z -= lobe * math.exp(-(((q-0.70)/0.30) ** 2)) * min(1.0, -si*2)
            verts.append(A(x, y, z))
    faces = []
    for i in range(len(stations)-1):
        for k in range(ring_n):
            k2 = (k+1) % ring_n
            a = i*ring_n+k; b = (i+1)*ring_n+k; c = (i+1)*ring_n+k2; d = i*ring_n+k2
            faces.append((a, d, c, b))
    if cap_start:
        ci = len(verts); verts.append(A(stations[0]['x'], 0, stations[0]['zc']))
        for k in range(ring_n):
            faces.append((ci, (k+1) % ring_n, k))
    if cap_end:
        base = (len(stations)-1)*ring_n
        ci = len(verts); verts.append(A(stations[-1]['x'], 0, stations[-1]['zc']))
        for k in range(ring_n):
            faces.append((ci, base+k, base+(k+1)%ring_n))
    return (verts, faces, 0)

def rect_ring(yc, half, ztop, zbot, r, ns, nc, rto=None, rto_corner=1):
    # rounded rect CCW. corners: 0 bottom-right(y1), 1 top-right(y1), 2 top-left(y0), 3 bottom-left(y0)
    y0, y1 = yc-half, yc+half
    rr = [r, r, r, r]
    if rto:
        rr[rto_corner] = rto
    pts = []
    for i in range(ns):
        pts.append((lerp(y0+rr[3], y1-rr[0], i/ns), zbot))
    corners = [((y1-rr[0], zbot+rr[0]), -math.pi/2, 0.0), ((y1-rr[1], ztop-rr[1]), 0.0, math.pi/2),
               ((y0+rr[2], ztop-rr[2]), math.pi/2, math.pi), ((y0+rr[3], zbot+rr[3]), math.pi, math.pi*1.5)]
    for ci, ((ccy, ccz), a0, a1) in enumerate(corners):
        for i in range(nc):
            a = lerp(a0, a1, i/nc)
            pts.append((ccy + rr[ci]*math.cos(a), ccz + rr[ci]*math.sin(a)))
        if a1 == 0.0:  # right edge
            for i in range(ns):
                pts.append((y1, lerp(zbot+rr[0], ztop-rr[1], i/ns)))
        elif a1 == math.pi/2:  # top edge
            for i in range(ns):
                pts.append((lerp(y1-rr[1], y0+rr[2], i/ns), ztop))
        elif a1 == math.pi:  # left edge
            for i in range(ns):
                pts.append((y0, lerp(ztop-rr[2], zbot+rr[3], i/ns)))
    return pts

def loft_rect(stations, ns=6, nc=3, cap_end=True):
    # stations: dicts xTop,xBot,yc,half,ztop,zbot,r + optional drop/sgn (top outer tilt down)
    # + optional expand (radial outward offset for a rounded lip ring)
    rings = []
    for st in stations:
        rto_c = 1 if st.get('sgn', 1) > 0 else 2  # top-outer corner index
        ring = rect_ring(st['yc'], st['half'], st['ztop'], st['zbot'], st.get('r', 0.06), ns, nc,
                         st.get('rto', None), rto_c)
        ex = st.get('expand', 0.0)
        if ex:
            zm = (st['ztop']+st['zbot'])/2
            ring2 = []
            for (y, z) in ring:
                dy, dz = y-st['yc'], z-zm
                L = max(1e-6, (dy*dy+dz*dz)**0.5)
                ring2.append((y+dy/L*ex, z+dz/L*ex))
            ring = ring2
        rings.append((st, ring))
    m = len(rings[0][1])
    verts = []
    for st, ring in rings:
        drop = st.get('drop', 0.0); sgn = st.get('sgn', 1)
        zmid = (st['ztop']+st['zbot'])/2
        for (y, z) in ring:
            f = (z - st['zbot']) / max(1e-6, (st['ztop'] - st['zbot']))
            if drop > 0:
                f_up = max(0.0, min(1.0, (z-zmid)/max(1e-6, (st['ztop']-zmid))))
                outer = max(0.0, min(1.0, (y-st['yc'])*sgn/max(1e-6, st['half'])))
                z = z - drop*f_up*outer
                f = (z - st['zbot']) / max(1e-6, (st['ztop'] - st['zbot']))
            x = lerp(st['xBot'], st['xTop'], max(0.0, min(1.0, f)))
            verts.append(A(x, y, z))
    faces = []
    for i in range(len(rings)-1):
        for k in range(m):
            k2 = (k+1) % m
            faces.append((i*m+k, i*m+k2, (i+1)*m+k2, (i+1)*m+k))
    if cap_end:
        # fan cap at end (dark handled by material split? keep skin, interior separate)
        pass
    return (verts, faces, 0, m)

# NACA 64A approx half-thickness
def naca_half(u, T):
    u = max(u, 1e-6)
    return 5*T*(0.2969*math.sqrt(u) - 0.1260*u - 0.3516*u*u + 0.2843*u**3 - 0.1015*u**4)

def build_wing_solid(rootLE, rootTE, tipLE, tipTE, Troot, Ttip, u_max_fn, nu=12, nv=8, mat=0, clip_tip=0.0, notch=None, ax=2, uv_out=None):
    # closed solid. ax = thickness axis in aero coords (2 = z for wings/stabs, 1 = y for fins/rudders)
    # winding auto-flip so grids face outward (verified by WIND audit): left horizontal + all vertical fins
    # uv_out (optional list): per-vert (u_chord_m, v_span_m) appended in vert order, for exact texel density
    # threshold epsilon for span sign
    _spanY = tipLE[1]-rootLE[1]; _spanZ = tipLE[2]-rootLE[2]
    _sax = 1 if abs(_spanY) >= abs(_spanZ) else 2
    _flip = (_spanY < -1e-9) or (abs(_spanY) <= 1e-9 and ax == 1 and _spanZ > 1e-9)
    # closed solid. span control stations support tip chamfer (clip meters) and LE notch (vn, jog meters aft)
    def L3(a, b, t): return [a[i]+(b[i]-a[i])*t for i in range(3)]
    ctrl = [(0.0, rootLE, rootTE, Troot)]
    if notch is not None:
        vn, jog = notch
        LEv = L3(rootLE, tipLE, vn); TEv = L3(rootTE, tipTE, vn); Tv = lerp(Troot, Ttip, vn)
        ctrl.append((vn, LEv, TEv, Tv))
        ctrl.append((min(1.0, vn+0.004), [LEv[0]-jog, LEv[1], LEv[2]], TEv, Tv))
    if clip_tip and clip_tip > 0:
        LEd = math.sqrt(sum((tipLE[i]-rootLE[i])**2 for i in range(3))) or 1.0
        Ap = [tipLE[i]-(tipLE[i]-rootLE[i])/LEd*clip_tip for i in range(3)]
        chT = math.sqrt(sum((tipTE[i]-tipLE[i])**2 for i in range(3))) or 1.0
        B = [tipLE[i]+(tipTE[i]-tipLE[i])/chT*clip_tip for i in range(3)]
        vA = (abs(Ap[_sax])-abs(rootLE[_sax]))/(abs(tipLE[_sax])-abs(rootLE[_sax]))
        vA = max(0.01, min(0.99, vA))
        ctrl.append((vA, Ap, L3(rootTE, tipTE, vA), lerp(Troot, Ttip, vA)))
        ctrl.append((1.0, B, tipTE, Ttip))
    else:
        ctrl.append((1.0, tipLE, tipTE, Ttip))
    ctrl = sorted(ctrl, key=lambda c: c[0])
    def ev(v):
        for i in range(len(ctrl)-1):
            if ctrl[i][0]-1e-9 <= v <= ctrl[i+1][0]+1e-9:
                t = 0.0 if ctrl[i+1][0] == ctrl[i][0] else (v-ctrl[i][0])/(ctrl[i+1][0]-ctrl[i][0])
                return (L3(ctrl[i][1], ctrl[i+1][1], t), L3(ctrl[i][2], ctrl[i+1][2], t), lerp(ctrl[i][3], ctrl[i+1][3], t))
        return (ctrl[-1][1], ctrl[-1][2], ctrl[-1][3])
    vs = sorted(set([j/nv for j in range(nv+1)]+[c[0] for c in ctrl]))
    # spanwise arclength (meters) along LE for exact-v UVs
    _span_cum = [0.0]
    _le_prev = None
    for _vv in vs:
        _le_now, _, _ = ev(_vv)
        if _le_prev is not None:
            _span_cum.append(_span_cum[-1] + math.sqrt(sum((_le_now[i]-_le_prev[i])**2 for i in range(3))))
        _le_prev = _le_now
    def _uv_of(uu, v):
        for _ji, _vj in enumerate(vs):
            if abs(_vj-v) < 1e-9:
                _le, _te, _ = ev(v)
                _ch = math.sqrt(sum((_te[i]-_le[i])**2 for i in range(3))) or 1.0
                return (uu*_ch, _span_cum[_ji])
        _le, _te, _ = ev(v)
        _ch = math.sqrt(sum((_te[i]-_le[i])**2 for i in range(3))) or 1.0
        return (uu*_ch, v*(_span_cum[-1] if _span_cum[-1] > 0 else 1.0))
    def surf(u, v):
        le, te, T = ev(v)
        chord = math.sqrt(sum((te[i]-le[i])**2 for i in range(3))) or 1.0
        yt = naca_half(u, T)*chord
        p = L3(le, te, u)
        return p, yt
    verts, faces = [], []
    W = nu+1
    for side in (1, -1):
        base = len(verts)
        for v in vs:
            um = u_max_fn(v)
            for i in range(nu+1):
                u = um*(i/nu)
                p, yt = surf(u, v)
                po = [p[0], p[1], p[2]]; po[ax] += side*yt
                verts.append(A(po[0], po[1], po[2]))
                if uv_out is not None:
                    uv_out.append(_uv_of(u, v))
        for j in range(len(vs)-1):
            for i in range(nu):
                a = base+j*W+i; b = base+j*W+i+1; c = base+(j+1)*W+i+1; d = base+(j+1)*W+i
                if side > 0: faces += [(a, b, d), (b, c, d)]
                else: faces += [(a, d, b), (b, d, c)]
    # rim: LE along span, tip/root chordwise, TE along span
    def rim_loop(get_uv_list):
        base = len(verts)
        pts = []
        for (u, v) in get_uv_list:
            um = u_max_fn(v); uu = min(u, um)
            p, yt = surf(uu, v)
            pu = [p[0], p[1], p[2]]; pu[ax] += yt
            pd = [p[0], p[1], p[2]]; pd[ax] -= yt
            pts.append((A(pu[0], pu[1], pu[2]), A(pd[0], pd[1], pd[2])))
            if uv_out is not None:
                _uv = _uv_of(uu, v)
                uv_out.append(_uv); uv_out.append(_uv)
        for a, b in pts:
            verts.extend([a, b])
        for k in range(len(pts)-1):
            a0 = base+k*2
            faces.append((a0, a0+1, a0+2)); faces.append((a0+1, a0+3, a0+2))
    rim_loop([(0, v) for v in vs])          # LE (includes chamfer kink)
    um1 = u_max_fn(1.0)
    rim_loop([(um1*(i/nu), 1.0) for i in range(nu+1)])   # tip edge
    um0 = u_max_fn(0.0)
    rim_loop([(um0*(i/nu), 0.0) for i in range(nu+1)])   # root edge
    base = len(verts)
    for v in vs:
        um = u_max_fn(v)
        p, yt = surf(um, v)
        pu = [p[0], p[1], p[2]]; pu[ax] += yt
        pd = [p[0], p[1], p[2]]; pd[ax] -= yt
        verts.append(A(pu[0], pu[1], pu[2])); verts.append(A(pd[0], pd[1], pd[2]))
        if uv_out is not None:
            _uv = _uv_of(um, v)
            uv_out.append(_uv); uv_out.append(_uv)
    for j in range(len(vs)-1):
        a0 = base+j*2
        faces.append((a0, a0+1, a0+2)); faces.append((a0+1, a0+3, a0+2))
    if _flip:
        faces = [tuple(reversed(f)) for f in faces]
    return (verts, faces, mat)

def hinge_origin(rootLE, rootTE, tipLE, tipTE, uh, vmid):
    def L3(a, b, t): return [a[i]+(b[i]-a[i])*t for i in range(3)]
    le = L3(rootLE, tipLE, vmid); te = L3(rootTE, tipTE, vmid)
    return L3(le, te, uh)

# ================= FUSELAGE =================
stations = [
    dict(s=0.0, halfW=0.012, top=0.05, bot=0.05, zc=0.05, nt=2.0, nb=2.0),
    dict(s=1.2, halfW=0.35, top=0.38, bot=-0.30, zc=0.04, nt=2.0, nb=2.0),
    dict(s=2.6, halfW=0.55, top=0.55, bot=-0.50, zc=0.025, nt=2.4, nb=2.0),
    dict(s=3.6, halfW=0.60, top=0.65, bot=-0.58, zc=0.035, nt=3.0, nb=2.4),
    dict(s=5.0, halfW=0.65, top=0.70, bot=-0.62, zc=0.04, nt=3.2, nb=2.8),
    dict(s=5.6, halfW=0.78, top=0.62, bot=-0.78, zc=-0.08, nt=4.0, nb=3.0),
    dict(s=6.5, halfW=1.35, top=0.64, bot=-0.80, zc=-0.08, nt=4.5, nb=3.0, keel=0.10),
    dict(s=8.0, halfW=1.90, top=0.66, bot=-0.76, zc=-0.05, nt=4.5, nb=3.0, spine=0.20, keel=0.10),
    dict(s=11.0, halfW=1.85, top=0.66, bot=-0.76, zc=-0.05, nt=4.5, nb=3.0, spine=0.20, keel=0.10),
    dict(s=13.5, halfW=1.50, top=0.62, bot=-0.70, zc=-0.04, nt=4.0, nb=3.0, groove=0.10, keel=0.10),
    dict(s=15.0, halfW=1.40, top=0.58, bot=-0.66, zc=-0.04, nt=4.0, nb=3.0, groove=0.14, keel=0.16, keel_c=0.0, lobe=0.05),
    dict(s=17.0, halfW=1.32, top=0.55, bot=-0.62, zc=-0.035, nt=3.5, nb=2.8, groove=0.22, keel=0.16, keel_c=0.0, lobe=0.08),
    dict(s=18.6, halfW=1.22, top=0.50, bot=-0.55, zc=-0.025, nt=3.0, nb=2.5, groove=0.28, keel=0.16, keel_c=0.0, lobe=0.08),
]
for st in stations:
    st['x'] = s2x(st['s'])
fv, ff, _ = loft_fuse(stations, ring_n=52, cap_start=True, cap_end=True)
fuse_parts = []
FUSE_RANGES = {}
DETAIL_PARTS = []
DETAIL_RANGES = {}
def _F(name, v, f, m=0):
    _off = sum(len(x[1]) for x in fuse_parts)
    FUSE_RANGES[name] = (_off, _off+len(f))
    fuse_parts.append((v, f, m))
def _D(name, v, f, m=0):
    _off = sum(len(x[1]) for x in DETAIL_PARTS)
    DETAIL_RANGES[name] = (_off, _off+len(f))
    DETAIL_PARTS.append((v, f, m))
_F('loft', fv, ff, 0)
# tail stinger (short pointed cone between nozzles, s18.4~19.6)
sting_st = [
    dict(x=s2x(18.4), halfW=0.03, top=0.10, bot=-0.15, zc=-0.025, nt=2.0, nb=2.0),
    dict(x=s2x(18.8), halfW=0.10, top=0.075, bot=-0.125, zc=-0.025, nt=2.0, nb=2.0),
    dict(x=s2x(19.3), halfW=0.125, top=0.10, bot=-0.15, zc=-0.025, nt=2.0, nb=2.0),
    dict(x=s2x(19.6), halfW=0.012, top=-0.013, bot=-0.037, zc=-0.025, nt=2.0, nb=2.0),
]
svv, sff, _ = loft_fuse(sting_st, ring_n=12, cap_start=False, cap_end=False)
_F('stinger', svv, sff, 0)

# ================= INTAKES (separate objects: crisp boxes, dark interior) =================
for sgn, tag in ((-1, 'L'), (1, 'R')):
    yc = sgn*1.60
    sts = [
        dict(xTop=s2x(5.4)+0.01, xBot=s2x(6.1)+0.01, yc=yc, half=0.475, ztop=0.55, zbot=-0.75, r=0.06, rto=0.25, drop=0.08, sgn=sgn, expand=0.025),
        dict(xTop=s2x(5.4), xBot=s2x(6.1), yc=yc, half=0.50, ztop=0.55, zbot=-0.75, r=0.06, rto=0.25, drop=0.08, sgn=sgn),
        dict(xTop=s2x(6.8), xBot=s2x(6.8), yc=yc, half=0.50, ztop=0.58, zbot=-0.78, r=0.06, rto=0.25, drop=0.08, sgn=sgn),
        dict(xTop=s2x(9.0), xBot=s2x(9.0), yc=yc, half=0.50, ztop=0.60, zbot=-0.80, r=0.07, rto=0.20, drop=0.06, sgn=sgn),
        dict(xTop=s2x(11.0), xBot=s2x(11.0), yc=yc, half=0.50, ztop=0.60, zbot=-0.80, r=0.07, rto=0.15, drop=0.06, sgn=sgn),
        dict(xTop=s2x(13.0), xBot=s2x(13.0), yc=yc, half=0.46, ztop=0.55, zbot=-0.70, r=0.07, rto=0.15, drop=0.05, sgn=sgn),
    ]
    dv, df, _, m = loft_rect(sts, ns=10, nc=4)
    # dark inlet back face (recessed inside) + ramp, near-black cockpit mat (faces +Y fwd)
    y0, y1 = yc-0.44, yc+0.44
    xT, xB = s2x(5.4)-1.0, s2x(6.1)-1.0
    iv = [A(xT, y0, 0.48), A(xT, y1, 0.48), A(xB, y1, -0.68), A(xB, y0, -0.68)]
    rv = [A(s2x(5.4), y0, 0.40), A(s2x(5.4), y1, 0.32), A(s2x(5.4)-1.0, y1, -0.30), A(s2x(5.4)-1.0, y0, -0.30)]
    # inner dark sleeve: front 0.3m band (skin_dark) + deep section (cockpit black)
    Xc = sgn*1.60; Xi = Xc-sgn*0.46; Xo = Xc+sgn*0.46
    YA = s2x(5.4)+0.01-0.05; YM = YA-0.3; YB = s2x(5.4)-1.3; ZT = 0.50; ZB = -0.70
    sleeve = []
    if sgn > 0:
        sleeve.append(([(Xi, YA, ZT), (Xo, YA, ZT), (Xo, YM, ZT), (Xi, YM, ZT)], [(0, 2, 1), (0, 3, 2)], 2))
        sleeve.append(([(Xi, YM, ZT), (Xo, YM, ZT), (Xo, YB, ZT), (Xi, YB, ZT)], [(0, 2, 1), (0, 3, 2)], 1))
        # bottom wall (faces up into duct)
        sleeve.append(([(Xi, YA, ZB), (Xo, YA, ZB), (Xo, YM, ZB), (Xi, YM, ZB)], [(0, 1, 2), (0, 2, 3)], 2))
        sleeve.append(([(Xi, YM, ZB), (Xo, YM, ZB), (Xo, YB, ZB), (Xi, YB, ZB)], [(0, 1, 2), (0, 2, 3)], 1))
    else:
        sleeve.append(([(Xi, YA, ZT), (Xo, YA, ZT), (Xo, YM, ZT), (Xi, YM, ZT)], [(0, 1, 2), (0, 2, 3)], 2))
        sleeve.append(([(Xi, YM, ZT), (Xo, YM, ZT), (Xo, YB, ZT), (Xi, YB, ZT)], [(0, 1, 2), (0, 2, 3)], 1))
        # bottom wall (faces up into duct)
        sleeve.append(([(Xi, YA, ZB), (Xo, YA, ZB), (Xo, YM, ZB), (Xi, YM, ZB)], [(0, 2, 1), (0, 3, 2)], 2))
        sleeve.append(([(Xi, YM, ZB), (Xo, YM, ZB), (Xo, YB, ZB), (Xi, YB, ZB)], [(0, 2, 1), (0, 3, 2)], 1))
    if sgn > 0:
        # inner wall (faces +X toward duct center)
        sleeve.append(([(Xi, YA, ZB), (Xi, YA, ZT), (Xi, YM, ZT), (Xi, YM, ZB)], [(0, 1, 2), (0, 2, 3)], 2))
        sleeve.append(([(Xi, YM, ZB), (Xi, YM, ZT), (Xi, YB, ZT), (Xi, YB, ZB)], [(0, 1, 2), (0, 2, 3)], 1))
        # outer wall (faces -X toward duct center)
        sleeve.append(([(Xo, YA, ZB), (Xo, YA, ZT), (Xo, YM, ZT), (Xo, YM, ZB)], [(0, 3, 2), (0, 2, 1)], 2))
        sleeve.append(([(Xo, YM, ZB), (Xo, YM, ZT), (Xo, YB, ZT), (Xo, YB, ZB)], [(0, 3, 2), (0, 2, 1)], 1))
    else:
        # inner wall (faces -X toward duct center)
        sleeve.append(([(Xi, YA, ZT), (Xi, YA, ZB), (Xi, YM, ZB), (Xi, YM, ZT)], [(0, 1, 2), (0, 2, 3)], 2))
        sleeve.append(([(Xi, YM, ZT), (Xi, YM, ZB), (Xi, YB, ZB), (Xi, YB, ZT)], [(0, 1, 2), (0, 2, 3)], 1))
        # outer wall (faces +X toward duct center)
        sleeve.append(([(Xo, YA, ZT), (Xo, YA, ZB), (Xo, YM, ZB), (Xo, YM, ZT)], [(0, 3, 2), (0, 2, 1)], 2))
        sleeve.append(([(Xo, YM, ZT), (Xo, YM, ZB), (Xo, YB, ZB), (Xo, YB, ZT)], [(0, 3, 2), (0, 2, 1)], 1))
    ivv, iff, ifm = merge([(dv, df, 0), (iv, [(0, 2, 1), (0, 3, 2)], 1), (rv, [(0, 2, 1), (0, 3, 2)], 1)] + sleeve)
    fin = finish('intake_'+tag, ivv, iff, [M_SKIN, M_COCKPIT, M_SKIN_DARK], ifm, subdiv=0)
    # (no crease: subdiv 0 keeps the crisp box + rounded lip exactly)
    # diverter gap: no splitter plate (removed - outer face was 0.02 from duct wall, shaded patch)

# (fuselage merged+finished later, after AIM-7 bays and fillets are appended)

# ================= CANOPY =================
can_st = [
    dict(x=s2x(3.4), halfW=0.10, top=0.68, bot=0.620, zc=0.650, nt=2.5, nb=2.5),
    dict(x=s2x(4.2), halfW=0.42, top=1.10, bot=0.661, zc=0.880, nt=2.5, nb=2.5),
    dict(x=s2x(4.55), halfW=0.447, top=1.36, bot=0.674, zc=1.017, nt=2.5, nb=2.5),
    dict(x=s2x(4.9), halfW=0.475, top=1.45, bot=0.686, zc=1.068, nt=2.5, nb=2.5),
    dict(x=s2x(5.25), halfW=0.465, top=1.375, bot=0.657, zc=1.016, nt=2.5, nb=2.5),
    dict(x=s2x(5.8), halfW=0.45, top=1.25, bot=0.614, zc=0.932, nt=2.5, nb=2.5),
    dict(x=s2x(7.2), halfW=0.30, top=0.95, bot=0.640, zc=0.795, nt=2.5, nb=2.5),
    dict(x=s2x(9.5), halfW=0.10, top=0.82, bot=0.640, zc=0.730, nt=2.5, nb=2.5),
]
cv, cf, _ = loft_fuse(can_st, ring_n=24, cap_start=False, cap_end=True)
hinge_can = (s2x(7.2), 0, 0.80)
cv = [(v[0]-hinge_can[1], v[1]-hinge_can[0], v[2]-hinge_can[2]) for v in cv]
# windshield arch + rear frame: swept tubes following the glass surface
def canopy_arch_points(s_target, lift=0.008):
    xt = s2x(s_target)
    xs = [c['x'] for c in can_st]
    i = 0
    for j in range(len(can_st)-1):
        if (xs[j]-xt)*(xs[j+1]-xt) <= 0:
            i = j; break
    c0, c1 = can_st[i], can_st[i+1]
    t = (xt-c0['x'])/(c1['x']-c0['x']) if c1['x'] != c0['x'] else 0
    t = max(0.0, min(1.0, t))
    halfW = lerp(c0['halfW'], c1['halfW'], t); top = lerp(c0['top'], c1['top'], t)
    zc = lerp(c0['zc'], c1['zc'], t)
    ht = top-zc
    bot = lerp(c0['bot'], c1['bot'], t)
    # arch terminates at the sill (glass bottom edge = deck level): no burial, no float
    sill = bot + 0.015
    _sraw = max(-1.0, min(1.0, (sill-zc)/max(1e-6, ht)))
    th_lo = math.asin(max(-1.0, min(1.0, sgn_pow(_sraw, 1.0/0.8))))
    th_hi = math.pi - th_lo
    pts = []
    N = 24
    for k in range(N+1):
        th = th_lo + (th_hi-th_lo)*(k/N)
        co, si = math.cos(th), math.sin(th)
        y = halfW*sgn_pow(co, 2/2.5); z = zc+ht*sgn_pow(si, 2/2.5)
        L = math.hypot(y, z-zc) or 1.0
        y += y/L*lift; z += (z-zc)/L*lift
        pts.append((y-hinge_can[1], xt-hinge_can[0], z-hinge_can[2]))
    return pts, (th_lo, th_hi, sill)

arch_parts = []
_pth1, _info1 = canopy_arch_points(4.25, 0.005); _pth2, _info2 = canopy_arch_points(7.2, 0.005)
ARCH_PATHS.extend([_pth1, _pth2])
ARCH_INFO = {'s4.25': _info1, 's7.2': _info2}
arch_parts.append(sweep_tube(_pth1, 0.015, 6, 1))
arch_parts.append(sweep_tube(_pth2, 0.016, 6, 1))
cparts = [(cv, cf, 0)] + arch_parts
cav, caf, cafm = merge(cparts)
canopy_ob = finish('canopy', cav, caf, [M_GLASS, M_SKIN_DARK], cafm, origin=A(*hinge_can), subdiv=1)

# ================= COCKPIT =================
ck = []
ck.append(box_part(s2x(5.6), s2x(4.6), -0.34, 0.34, 0.30, 0.62, 0))       # panel block
ck.append(box_part(s2x(4.9), s2x(4.5), -0.40, 0.40, 0.55, 0.66, 0))       # glareshield
ck.append(box_part(s2x(6.2), s2x(4.4), -0.50, -0.38, 0.45, 0.60, 0))      # consoles
ck.append(box_part(s2x(6.2), s2x(4.4), 0.38, 0.50, 0.45, 0.60, 0))
ck.append(box_part(s2x(7.0), s2x(5.2), -0.35, 0.35, 0.10, 0.30, 0))       # floor/tub
ck.append(box_part(s2x(6.8), s2x(6.0), -0.25, 0.25, 0.30, 0.75, 0))       # seat
ck.append(box_part(s2x(5.15), s2x(5.05), -0.07, 0.07, 0.80, 1.05, 1))     # HUD glass
ckv, ckf, ckfm = merge(ck)
cockpit_ob = finish('cockpit', ckv, ckf, [M_COCKPIT, M_GLASS], ckfm, subdiv=0)

# ================= WINGS =================
GAP = 0.012  # chord-fraction gap (~6cm root, 2cm tip)
for sgn, tag in ((-1, 'L'), (1, 'R')):
    # wing root buried 0.10 into duct wall (was coplanar at +-2.10 -> z-fight slot)
    rootLE = (s2x(8.6), sgn*2.00, 0.40)
    rootTE = (s2x(13.6), sgn*2.00, 0.40)
    tipLE = (s2x(13.1), sgn*6.53, 0.323)
    tipTE = (s2x(14.6), sgn*6.53, 0.323)
    vF0, vF1 = (2.2-2.00)/4.53, (4.3-2.00)/4.53
    vA0, vA1 = (4.4-2.00)/4.53, (6.2-2.00)/4.53
    def umax_fixed(v):
        if vF0-0.008 <= v <= vF1+0.008: return 0.75-GAP/2
        if vA0-0.008 <= v <= vA1+0.008: return 0.75-GAP/2
        return 1.0
    _wuv = []
    wv, wf, _ = build_wing_solid(rootLE, rootTE, tipLE, tipTE, 0.06, 0.03, umax_fixed, nu=18, nv=14, clip_tip=0.4, uv_out=_wuv)
    _wob = finish('wing_'+tag, wv, wf, [M_SKIN], None, subdiv=1)
    APPLY_UV.append((_wob, _wuv))
    # flap
    def umax_flap(v): return 1.0
    h0 = hinge_origin(rootLE, rootTE, tipLE, tipTE, 0.75, (vF0+vF1)/2)
    fv2, ff2, _ = build_wing_solid(rootLE, rootTE, tipLE, tipTE, 0.055, 0.028,
        lambda v: 1.0, nu=6, nv=4)
    # crop flap solid to its span/chord window manually: rebuild with v mapping
    def L3(a, b, t): return [a[i]+(b[i]-a[i])*t for i in range(3)]
    # NOTE: simpler - build patch then translate so origin at hinge
    fvv = [(v[0]-h0[1], v[1]-h0[0], v[2]-h0[2]) for v in fv2]
    # flap span crop: keep verts whose span fraction in range (approx by Blender X)
    # Instead rebuild properly scoped:
    rLE2 = L3(rootLE, tipLE, vF0); rTE2 = L3(rootTE, tipTE, vF0)
    tLE2 = L3(rootLE, tipLE, vF1); tTE2 = L3(rootTE, tipTE, vF1)
    # hinge-line LE for control = 0.75+GAP/2 chord
    def ctrl_LE(a, b):
        return [a[i]+(b[i]-a[i])*(0.75+GAP/2) for i in range(3)]
    cR_LE, cR_TE = ctrl_LE(rLE2, rTE2), rTE2
    cT_LE, cT_TE = ctrl_LE(tLE2, tTE2), tTE2
    _fuv = []
    cfv, cff, _ = build_wing_solid(cR_LE, cR_TE, cT_LE, cT_TE, 0.05, 0.026, lambda v: 1.0, nu=6, nv=4, uv_out=_fuv)
    cfl = [(v[0]-h0[1], v[1]-h0[0], v[2]-h0[2]) for v in cfv]
    _fob = finish('flap_'+tag, cfl, cff, [M_SKIN], None, origin=A(*h0), subdiv=0)
    APPLY_UV.append((_fob, _fuv))
    # aileron
    h1 = hinge_origin(rootLE, rootTE, tipLE, tipTE, 0.75, (vA0+vA1)/2)
    rLE3 = L3(rootLE, tipLE, vA0); rTE3 = L3(rootTE, tipTE, vA0)
    tLE3 = L3(rootLE, tipLE, vA1); tTE3 = L3(rootTE, tipTE, vA1)
    cR_LE = ctrl_LE(rLE3, rTE3); cT_LE = ctrl_LE(tLE3, tTE3)
    _auv = []
    cav2, caf2, _ = build_wing_solid(cR_LE, rTE3, cT_LE, tTE3, 0.045, 0.026, lambda v: 1.0, nu=6, nv=4, uv_out=_auv)
    cal = [(v[0]-h1[1], v[1]-h1[0], v[2]-h1[2]) for v in cav2]
    _aob = finish('ail_'+tag, cal, caf2, [M_SKIN], None, origin=A(*h1), subdiv=0)
    APPLY_UV.append((_aob, _auv))

def lens_octa(rx, ry, rz):
    V = [(rx,0,0), (-rx,0,0), (0,ry,0), (0,-ry,0), (0,0,rz), (0,0,-rz)]
    F = [(0,2,4), (2,1,4), (1,3,4), (3,0,4), (2,0,5), (1,2,5), (3,1,5), (0,3,5)]
    return (V, F, 0)

def audit_part(name, verts, faces):
    # centroid test on a raw part (valid for small closed solids); prints inward ratio
    n = len(verts)
    cx = [sum(v[0] for v in verts)/n, sum(v[1] for v in verts)/n, sum(v[2] for v in verts)/n]
    tot = neg = 0
    for f in faces:
        pts = [verts[i] for i in f]
        nn = [0.0, 0.0, 0.0]
        m = len(pts)
        for i in range(m):
            a = pts[i]; b = pts[(i+1) % m]
            nn[0] += (a[1]-b[1])*(a[2]+b[2])
            nn[1] += (a[2]-b[2])*(a[0]+b[0])
            nn[2] += (a[0]-b[0])*(a[1]+b[1])
        c = [sum(p[j] for p in pts)/m for j in range(3)]
        d = (c[0]-cx[0])*nn[0] + (c[1]-cx[1])*nn[1] + (c[2]-cx[2])*nn[2]
        tot += 1
        if d < 0:
            neg += 1
    print('PART-AUDIT %s: %.1f%% inward (%d/%d)' % (name, 100.0*neg/max(1, tot), neg, tot))
    return neg, tot

# gun recess (dark oval, cockpit mat) + small fairing ahead (right wing root, s~9.5)
# built relative to origin; origin placed at recess center for game lookup
_gx, _gy, _gz = 0.55, 2.15, 0.50
_gring = []
for _k in range(16):
    _th = 2*math.pi*_k/16
    _gring.append((0.10*math.cos(_th), 0.28*math.sin(_th), 0.0))
_gv = [(0, 0, 0)] + _gring
_gf = [(0, 1+k, 1+(k+1) % 16) for k in range(16)]
audit_part('gun-recess', _gv, _gf)
_gfair = box_part(0.95-_gx, 1.45-_gx, 2.05-_gy, 2.32-_gy, 0.44-_gz, 0.50-_gz, 0)
_guv, _guf, _gfm = merge([(_gv, _gf, 1), _gfair])
_guob = finish('gun_R', _guv, _guf, [M_SKIN, M_COCKPIT], _gfm, origin=A(_gx, _gy, _gz), subdiv=0)

# ================= STABS =================
for sgn, tag in ((-1, 'L'), (1, 'R')):
    rootLE = (s2x(15.6), sgn*1.70, 0.05); rootTE = (s2x(18.9), sgn*1.70, 0.05)
    tipLE = (s2x(18.2), sgn*4.30, 0.05); tipTE = (s2x(19.3), sgn*4.30, 0.05)
    piv = (s2x(17.0), sgn*1.70, 0.05)
    _suv = []
    sv, sf, _ = build_wing_solid(rootLE, rootTE, tipLE, tipTE, 0.045, 0.028, lambda v: 1.0, nu=12, nv=8, notch=(0.45, 0.15), clip_tip=0.25, uv_out=_suv)
    sv = [(v[0]-piv[1], v[1]-piv[0], v[2]-piv[2]) for v in sv]
    _sob = finish('stab_'+tag, sv, sf, [M_SKIN], None, origin=A(*piv), subdiv=2)
    APPLY_UV.append((_sob, _suv))

# ================= FINS + RUDDERS =================
for sgn, tag in ((-1, 'L'), (1, 'R')):
    rootLE = (s2x(14.3), sgn*1.35, 0.60); rootTE = (s2x(17.9), sgn*1.35, 0.60)
    tipLE = (s2x(16.6), sgn*1.35, 3.53); tipTE = (s2x(18.3), sgn*1.35, 3.53)
    # fin fixed: leading part u 0..0.62 (thickness lateral), tip front chamfer 0.35
    _fiuv = []
    fv2, ff2, _ = build_wing_solid(rootLE, rootTE, tipLE, tipTE, 0.05, 0.04, lambda v: 0.62, nu=12, nv=10, ax=1, clip_tip=0.35, uv_out=_fiuv)
    # small antenna blade on fin tip top (sits behind clipped front corner)
    _ant = box_part(s2x(17.9), s2x(17.35), sgn*1.35-0.02, sgn*1.35+0.02, 3.53, 3.63, 0)
    _fvv, _fff, _ffm = merge([(fv2, ff2, 0), _ant])
    _fiob = finish('fin_'+tag, _fvv, _fff, [M_SKIN], _ffm, subdiv=2)
    APPLY_UV.append((_fiob, _fiuv))
    h0 = hinge_origin(rootLE, rootTE, tipLE, tipTE, 0.628, 0.45)
    rLE = [rootLE[i]+(rootTE[i]-rootLE[i])*(0.62+0.02/3.6) for i in range(3)]
    tLE = [tipLE[i]+(tipTE[i]-tipLE[i])*(0.62+0.02/1.7) for i in range(3)]
    _ruv = []
    rv, rf, _ = build_wing_solid(rLE, rootTE, tLE, tipTE, 0.045, 0.035, lambda v: 1.0, nu=6, nv=6, ax=1, uv_out=_ruv)
    rv = [(v[0]-h0[1], v[1]-h0[0], v[2]-h0[2]) for v in rv]
    _ruob = finish('rud_'+tag, rv, rf, [M_SKIN], None, origin=A(*h0), subdiv=0)
    APPLY_UV.append((_ruob, _ruv))

# ================= NOZZLES (16 fluted petals, exit taper, dark core + rib) =================
for sgn, tag in ((-1, 'L'), (1, 'R')):
    oy, ox, oz = sgn*0.70, s2x(18.6), -0.025
    NP = 32  # 16 plates + 16 grooves (0.02 deep)
    rings = [(0.0, 0.525), (0.27, 0.508), (0.53, 0.492), (0.8, 0.475), (0.84, 0.485)]
    ov, of = [], []
    for zi, (zz, rr) in enumerate(rings):
        for k in range(NP):
            th = 2*math.pi*k/NP
            rk = rr - (0.020 if k % 2 == 1 else 0.0)
            ov.append(A(ox-zz, oy+rk*math.cos(th), oz+rk*math.sin(th)))
    for zi in range(len(rings)-1):
        for k in range(NP):
            k2 = (k+1) % NP
            of.append((zi*NP+k, zi*NP+k2, (zi+1)*NP+k2, (zi+1)*NP+k))
    # dark inner sleeve
    iv, iff = [], []
    for zi, (zz, rr) in enumerate([(0.05, 0.49), (0.45, 0.47), (0.78, 0.44)]):
        for k in range(NP):
            th = 2*math.pi*k/NP
            iv.append(A(ox-zz, oy+rr*math.cos(th), oz+rr*math.sin(th)))
    for zi in range(2):
        for k in range(NP):
            k2 = (k+1) % NP
            iff.append(((zi+1)*NP+k, zi*NP+k, zi*NP+k2, (zi+1)*NP+k2))
    # inner rib ring (V bump inward at mid)
    rv2, rf2 = [], []
    for zi, (zz, rr) in enumerate([(0.36, 0.44), (0.42, 0.412), (0.48, 0.44)]):
        for k in range(NP):
            th = 2*math.pi*k/NP
            rv2.append(A(ox-zz, oy+rr*math.cos(th), oz+rr*math.sin(th)))
    for zi in range(2):
        for k in range(NP):
            k2 = (k+1) % NP
            rf2.append((zi*NP+k, (zi+1)*NP+k, (zi+1)*NP+k2, zi*NP+k2))
    tv = [A(ox-0.05, oy, oz)]
    for k in range(16):
        th = 2*math.pi*k/16
        tv.append(A(ox-0.05, oy+0.40*math.cos(th), oz+0.40*math.sin(th)))
    tf = [(0, (k+1) % 16+1, k+1) for k in range(16)]
    nv, nf, nfm = merge([(ov, of, 0), (iv, iff, 1), (rv2, rf2, 1), (tv, tf, 1)])
    nv = [(v[0]-oy, v[1]-ox, v[2]-oz) for v in nv]
    nz = finish('nozzle_'+tag, nv, nf, [M_NOZZLE, M_COCKPIT], nfm, origin=A(ox, oy, oz), subdiv=0)
    try:
        import bmesh as _bm2
        me = nz.data
        bm = _bm2.new(); bm.from_mesh(me)
        bm.verts.ensure_lookup_table(); bm.edges.ensure_lookup_table()
        try:
            cl = bm.edges.layers.float["crease_edge"]
        except KeyError:
            cl = bm.edges.layers.float.new("crease_edge")
        for j in range(len(rings)-1):
            for k in range(NP):
                e = bm.edges.get((bm.verts[j*NP+k], bm.verts[(j+1)*NP+k]))
                if e is not None:
                    e[cl] = 1.0
        bm.to_mesh(me); bm.free()
    except Exception as e:
        print('crease skip nozzle', tag, e)

# ================= SPEEDBRAKE =================
sb_piv = (s2x(7.6), 0, 0.72)
sbv, sbf, _ = box_part(s2x(9.6)-sb_piv[0], s2x(7.6)-sb_piv[0], -0.45, 0.45, 0.70-sb_piv[2], 0.75-sb_piv[2], 0)
finish('speedbrake', sbv, sbf, [M_SKIN], None, origin=A(*sb_piv), subdiv=0)

# ================= PYLONS (airfoil section + AIM-9 rail with side nubs) =================
for sgn, tag in ((-1, 'L'), (1, 'R')):
    yc = sgn*3.8
    rootLE = (s2x(10.0), yc, 0.45); rootTE = (s2x(11.5), yc, 0.45)
    tipLE = (s2x(10.0), yc, -0.55); tipTE = (s2x(11.2), yc, -0.55)
    _puv = []
    pv, pf, _ = build_wing_solid(rootLE, rootTE, tipLE, tipTE, 0.06, 0.05, lambda v: 1.0, nu=8, nv=4, ax=1, uv_out=_puv)
    # AIM-9 rail (slim) + side nubs under pylon
    rail = box_part(s2x(11.3)-0.0, s2x(10.2)-0.0, yc-0.05, yc+0.05, -0.68, -0.60, 0)
    nub1 = box_part(s2x(11.0), s2x(10.5), min(yc+0.05, yc+0.11), max(yc+0.05, yc+0.11), -0.66, -0.58, 0)
    nub2 = box_part(s2x(11.0), s2x(10.5), min(yc-0.05, yc-0.11), max(yc-0.05, yc-0.11), -0.66, -0.58, 0)
    pvv, pff, pfm = merge([(pv, pf, 0), rail, nub1, nub2])
    _pob = finish('pylon_'+tag, pvv, pff, [M_SKIN], pfm, subdiv=0)
    APPLY_UV.append((_pob, _puv))

# intake-to-wing root fillet (merged into fuselage: outer extent capped at 2.10)
for sgn in (-1, 1):
    fil_st = [
        dict(x=s2x(7.6), halfW=0.03, top=0.56, bot=0.50, zc=0.53, nt=2.0, nb=2.0),
        dict(x=s2x(8.4), halfW=0.16, top=0.62, bot=0.46, zc=0.54, nt=2.5, nb=2.5),
        dict(x=s2x(9.2), halfW=0.20, top=0.62, bot=0.44, zc=0.53, nt=2.5, nb=2.5),
        dict(x=s2x(10.0), halfW=0.13, top=0.58, bot=0.46, zc=0.52, nt=2.0, nb=2.0),
        dict(x=s2x(10.6), halfW=0.03, top=0.53, bot=0.49, zc=0.51, nt=2.0, nb=2.0),
    ]
    fv0, ff0, _ = loft_fuse(fil_st, ring_n=12, cap_start=False, cap_end=False)
    fv0 = [(v[0]+sgn*1.9, v[1], v[2]) for v in fv0]
    _F('fillet_%s' % ('R' if sgn > 0 else 'L'), fv0, ff0, 0)

# nose pitot (needle slightly below nose tip, r0.015, length 0.5) + 2 AoA probes
_pit_st = [
    dict(x=10.55, halfW=0.002, top=-0.058, bot=-0.062, zc=-0.06, nt=2.0, nb=2.0),
    dict(x=10.30, halfW=0.015, top=-0.045, bot=-0.075, zc=-0.06, nt=2.0, nb=2.0),
    dict(x=9.95, halfW=0.015, top=-0.045, bot=-0.075, zc=-0.06, nt=2.0, nb=2.0),
]
_pv, _pf, _ = loft_fuse(_pit_st, ring_n=8, cap_start=True, cap_end=False)
audit_part('pitot', _pv, _pf)
_D('pitot', _pv, _pf, 0)
for _sgn, _sx in ((-1, -0.58), (1, 0.58)):
    _aoa_st = [
        dict(x=6.10, halfW=0.002, top=0.422, bot=0.418, zc=0.42, nt=2.0, nb=2.0),
        dict(x=5.95, halfW=0.020, top=0.440, bot=0.400, zc=0.42, nt=2.0, nb=2.0),
        dict(x=5.90, halfW=0.020, top=0.440, bot=0.400, zc=0.42, nt=2.0, nb=2.0),
    ]
    _av, _af, _ = loft_fuse(_aoa_st, ring_n=8, cap_start=True, cap_end=False)
    _av = [(v[0]+0.0, v[1]+_sx, v[2]) for v in _av]
    audit_part('aoa_%s' % ('L' if _sgn < 0 else 'R'), _av, _af)
    _D('aoa_%s' % ('L' if _sgn < 0 else 'R'), _av, _af, 0)

# blade antennas x4 (thin trapezoids, merged into fuselage; 2 spine-top + 2 belly)
for _bn, _br in (('spine-fwd', ((2.0, 0, 0.70), (1.5, 0, 0.70), (1.90, 0, 0.87), (1.50, 0, 0.87))),
                 ('belly-mid', ((0.8, 0, -0.78), (0.3, 0, -0.78), (0.75, 0, -0.95), (0.35, 0, -0.95))),
                 ('spine-aft', ((-1.9, 0, 0.68), (-2.4, 0, 0.68), (-1.95, 0, 0.83), (-2.35, 0, 0.83))),
                 ('belly-nose', ((5.6, 0, -0.62), (5.2, 0, -0.62), (5.55, 0, -0.77), (5.25, 0, -0.77)))):
    _bLE0, _bTE0, _bLE1, _bTE1 = _br
    _bv, _bf, _ = build_wing_solid(_bLE0, _bTE0, _bLE1, _bTE1, 0.06, 0.06, lambda v: 1.0, nu=4, nv=2, ax=1)
    audit_part('blade-'+_bn, _bv, _bf)
    _D('blade-'+_bn, _bv, _bf, 0)

# stab pivot teardrop fairings (both sides, merged into fuselage)
for _sgn2 in (-1, 1):
    _stf = [
        dict(x=-6.3, halfW=0.03, top=0.14, bot=-0.04, zc=0.05, nt=2.0, nb=2.0),
        dict(x=-6.95, halfW=0.30, top=0.14, bot=-0.04, zc=0.05, nt=2.5, nb=2.5),
        dict(x=-7.6, halfW=0.03, top=0.14, bot=-0.04, zc=0.05, nt=2.0, nb=2.0),
    ]
    _sv0, _sf0, _ = loft_fuse(_stf, ring_n=10, cap_start=True, cap_end=True)
    _sv0, _sf0, _ = loft_fuse(_stf, ring_n=10, cap_start=True, cap_end=True)
    _sv0 = [(v[0]+_sgn2*1.70, v[1], v[2]) for v in _sv0]
    audit_part('stabfair-%s' % ('L' if _sgn2 < 0 else 'R'), _sv0, _sf0)
    _D('stabfair-%s' % ('L' if _sgn2 < 0 else 'R'), _sv0, _sf0, 0)

# nav light lens nubs (separate nodes so the game can read positions; aero coords)
for _nln, _nlp, _nlr in (('navlight_L', (-4.45, -6.50, 0.34), (0.035, 0.035, 0.025)),
                         ('navlight_R', (-4.45, 6.50, 0.34), (0.035, 0.035, 0.025)),
                         ('navlight_T', (-9.52, 0.0, 0.02), (0.025, 0.025, 0.025))):
    _nv, _nf, _ = lens_octa(*_nlr)
    audit_part(_nln, _nv, _nf)
    finish(_nln, _nv, _nf, [M_GLASS], None, origin=A(_nlp[1], _nlp[0], _nlp[2]), subdiv=0)

# AIM-7 semi-recessed bays (4): shallow dark plates under intake lower corners
for _bi, _yy in enumerate((1.2, 1.95, 1.2, 1.95)):
    _sgnb = -1 if _bi < 2 else 1
    bay = box_part(s2x(12.5), s2x(8.5), min(_sgnb*_yy-0.11, _sgnb*_yy+0.11), max(_sgnb*_yy-0.11, _sgnb*_yy+0.11), -0.82, -0.79, 1)
    _D('bay%d' % _bi, *bay)
fvv, fff, ffm = merge(fuse_parts)
fuselage_ob = finish('fuselage', fvv, fff, [M_SKIN, M_SKIN_DARK], ffm, subdiv=2)
# small add-on details in one flat-shaded object (tri budget: no subdiv here)
_ddv, _ddf, _ddm = merge(DETAIL_PARTS)
details_ob = finish('details', _ddv, _ddf, [M_SKIN, M_SKIN_DARK], _ddm, subdiv=0)

# ================= GEARS (tire open tube + recessed side discs, axle; no coplanar caps) =================
def gear_wheel(r, wdt):
    parts = []
    tv, tf = [], []
    n = 20
    for xx in (-wdt/2, wdt/2):
        for k in range(n):
            th = 2*math.pi*k/n
            tv.append((xx, r*math.cos(th), r*math.sin(th)))
    for k in range(n):
        k2 = (k+1)%n
        tf.append((k, k2, k2+n, k+n))
    parts.append((tv, tf, 1))
    for xside in (-1, 1):
        xx = xside*(wdt/2-0.015)
        dv = [(xx, 0, 0)]
        for k in range(n):
            th = 2*math.pi*k/n
            dv.append((xx, r*0.985*math.cos(th), r*0.985*math.sin(th)))
        if xside > 0:
            df = [(0, 1+k, 1+(k+1) % n) for k in range(n)]
        else:
            df = [(0, 1+(k+1) % n, 1+k) for k in range(n)]
        parts.append((dv, df, 1))
    return parts

def shift(v, dx, dy, dz): return [(p[0]+dx, p[1]+dy, p[2]+dz) for p in v]

hx, hy, hz = s2x(3.3), 0, -0.62
gp = []
sv, sf, _ = tube_part((0, 0, 0), (0, 0, -0.62), 0.05, 10, 0)
gp.append((sv, sf, 0))
cv, cf, _ = tube_part((0, 0, -0.62), (0, 0, -0.70), 0.058, 10, 0)
gp.append((cv, cf, 0))
pv, pf, _ = tube_part((0, 0, -0.70), (0, 0, -1.24), 0.032, 8, 0)
gp.append((pv, pf, 0))
av, af, _ = tube_part((0, -0.22, -1.30), (0, 0.22, -1.30), 0.045, 8, 0)
gp.append((av, af, 0))
for _ts in (-1, 1):
    _tl = box_part(-0.05, 0.05, min(_ts*0.05, _ts*0.075), max(_ts*0.05, _ts*0.075), -1.20, -0.45, 0)
    gp.append(_tl)
for off in (-0.13, 0.13):
    for pv, pf, pm in gear_wheel(0.28, 0.16):
        gp.append((shift(pv, off, 0, -1.30), pf, pm))
gv, gf, gfm = merge(gp)
finish('gear_N', gv, gf, [M_GEAR, M_TIRE], gfm, origin=A(hx, hy, hz), subdiv=0)

for sgn, tag in ((-1, 'L'), (1, 'R')):
    hx, hy, hz = s2x(11.2), sgn*1.40, -0.70
    gp = []
    sv, sf, _ = tube_part((0, 0, 0), (0, 0, -0.50), 0.05, 10, 0)
    gp.append((sv, sf, 0))
    cv, cf, _ = tube_part((0, 0, -0.50), (0, 0, -0.58), 0.058, 10, 0)
    gp.append((cv, cf, 0))
    pv, pf, _ = tube_part((0, 0, -0.58), (0, 0, -1.02), 0.034, 8, 0)
    gp.append((pv, pf, 0))
    av, af, _ = tube_part((0, -0.20, -1.08), (0, 0.20, -1.08), 0.05, 8, 0)
    gp.append((av, af, 0))
    for _ts in (-1, 1):
        _tl = box_part(-0.04, 0.06, min(_ts*0.05, _ts*0.075), max(_ts*0.05, _ts*0.075), -1.00, -0.45, 0)
        gp.append(_tl)
    for pv, pf, pm in gear_wheel(0.425, 0.24):
        gp.append((shift(pv, 0, 0, -1.08), pf, pm))
    gv, gf, gfm = merge(gp)
    finish('gear_'+tag, gv, gf, [M_GEAR, M_TIRE], gfm, origin=A(hx, hy, hz), subdiv=0)

print('objects:', len(MODEL_OBJS), [o.name for o in MODEL_OBJS])

# ---------------- winding audit (RAW meshes, before any recalc) ----------------
print('=== WINDING AUDIT (raw, pre-recalc) ===')
for o in MODEL_OBJS:
    me = o.data
    me.update()
    nverts = len(me.vertices)
    cx = mathutils.Vector((0, 0, 0))
    for v in me.vertices:
        cx += v.co
    cx /= max(1, nverts)
    tot = neg = 0
    totX = negX = 0
    for p in me.polygons:
        n = p.normal; c = p.center
        d = (c[0]-cx[0])*n[0] + (c[1]-cx[1])*n[1] + (c[2]-cx[2])*n[2]
        tot += 1
        if d < 0:
            neg += 1
        try:
            mname = me.materials[p.material_index].name if len(me.materials) else ''
        except Exception:
            mname = ''
        if mname == 'cockpit':
            continue
        totX += 1
        if d < 0:
            negX += 1
    print('WIND %s: all %.1f%% inward (%d/%d) | exterior %.1f%% (%d/%d)' % (
        o.name, 100.0*neg/max(1, tot), neg, tot, 100.0*negX/max(1, totX), negX, totX))

# part-level breakdown for the two big residuals (vert ranges from construction order)
def _part_wind(me, cx, v0, nv, flist, label):
    tot = neg = 0
    for f in flist:
        try:
            p = me.polygons[f]
        except Exception:
            continue
        n = p.normal; c = p.center
        d = (c[0]-cx[0])*n[0] + (c[1]-cx[1])*n[1] + (c[2]-cx[2])*n[2]
        tot += 1
        if d < 0:
            neg += 1
    print('  PART %s: %.1f%% inward (%d/%d)' % (label, 100.0*neg/max(1, tot), neg, tot))

try:
    _fuse = bpy.data.objects['fuselage'].data
    _fuse.update()
    _cx = mathutils.Vector((0, 0, 0))
    for _v in _fuse.vertices:
        _cx += _v.co
    _cx /= max(1, len(_fuse.vertices))
    _off = 0
    # loft side quads + caps: side faces first (segments*ring), then nose fan, tail fan
    _nloft_side = (len(stations)-1)*52
    _part_wind(_fuse, _cx, 0, 0, list(range(FUSE_RANGES['loft'][0], FUSE_RANGES['loft'][0]+_nloft_side)), 'fuselage-loft-sides')
    _part_wind(_fuse, _cx, 0, 0, list(range(FUSE_RANGES['loft'][0]+_nloft_side, FUSE_RANGES['loft'][0]+_nloft_side+52)), 'fuselage-cap-nose')
    _part_wind(_fuse, _cx, 0, 0, list(range(FUSE_RANGES['loft'][0]+_nloft_side+52, FUSE_RANGES['loft'][0]+_nloft_side+104)), 'fuselage-cap-tail')
    for _pn in ('stinger', 'fillet_L', 'fillet_R'):
        _a, _b = FUSE_RANGES[_pn]
        _part_wind(_fuse, _cx, 0, 0, list(range(_a, _b)), 'fuselage-'+_pn)
    # NOTE: small offset parts skip the global-centroid PART test (centroid misfires
    # for off-center parts); they are verified per-part pre-merge (audit_part) plus
    # AXIS tests below.
    _det = bpy.data.objects['details'].data
    _det.update()
    _dcx = mathutils.Vector((0, 0, 0))
    for _v in _det.vertices:
        _dcx += _v.co
    _dcx /= max(1, len(_det.vertices))
    _can = bpy.data.objects['canopy'].data
    _can.update()
    _ccx = mathutils.Vector((0, 0, 0))
    for _v in _can.vertices:
        _ccx += _v.co
    _ccx /= max(1, len(_can.vertices))
    _part_wind(_can, _ccx, 0, 0, list(range(168)), 'canopy-loft-sides')
    _part_wind(_can, _ccx, 0, 0, list(range(168, 192)), 'canopy-cap-rear')
    _part_wind(_can, _ccx, 0, 0, list(range(192, 336)), 'canopy-arch1')
    _part_wind(_can, _ccx, 0, 0, list(range(336, 480)), 'canopy-arch2')

    def _axis_wind(me, faces, ref_fn, label):
        tot = neg = 0
        for f in faces:
            try:
                p = me.polygons[f]
            except Exception:
                continue
            n = p.normal; c = p.center
            r = ref_fn(c)
            d = (c[0]-r[0])*n[0] + (c[1]-r[1])*n[1] + (c[2]-r[2])*n[2]
            tot += 1
            if d < 0:
                neg += 1
        print('  AXIS %s: %.1f%% inward (%d/%d)' % (label, 100.0*neg/max(1, tot), neg, tot))

    def _arch_ref(path):
        def fn(c):
            best = None; bd = 1e18
            for q in path:
                dd = (c[0]-q[0])**2 + (c[1]-q[1])**2 + (c[2]-q[2])**2
                if dd < bd:
                    bd = dd; best = q
            return best
        return fn

    if len(ARCH_PATHS) >= 2:
        _axis_wind(_can, list(range(192, 336)), _arch_ref(ARCH_PATHS[0]), 'canopy-arch1-tube')
        _axis_wind(_can, list(range(336, 480)), _arch_ref(ARCH_PATHS[1]), 'canopy-arch2-tube')
        try:
            _bad = []
            for _f in range(336, 480):
                _p = _can.polygons[_f]
                _n = _p.normal; _c = _p.center
                _best = None; _bd = 1e18
                for _q in ARCH_PATHS[1]:
                    _dd = (_c[0]-_q[0])**2 + (_c[1]-_q[1])**2 + (_c[2]-_q[2])**2
                    if _dd < _bd:
                        _bd = _dd; _best = _q
                _d = (_c[0]-_best[0])*_n[0] + (_c[1]-_best[1])*_n[1] + (_c[2]-_best[2])*_n[2]
                if _d < 0:
                    _bad.append(_f-336)
            print('arch2 bad local faces:', _bad[:40])
        except Exception as _e2:
            print('arch2 bad-face probe skip:', _e2)
    # arch placement: verified externally (PM round 9: arch bbox inside glass bbox).
    # arches hug the glass (lift 0.005, tube r 0.015) and terminate at sill height;
    # winding verified 0% inward by AXIS test above. No further arch work.
    for _gn, _zc in (('gear_N', -1.30), ('gear_L', -1.08), ('gear_R', -1.08)):
        _gm = bpy.data.objects[_gn].data
        _gm.update()
        _zero = 0.0
        _axis_wind(_gm, list(range(0, 30)), lambda c: (_zero, _zero, c[2]), _gn+'-strut')
        _axis_wind(_gm, list(range(30, 60)), lambda c: (_zero, _zero, c[2]), _gn+'-collar')
        _axis_wind(_gm, list(range(60, 84)), lambda c: (_zero, _zero, c[2]), _gn+'-piston')
        _axis_wind(_gm, list(range(84, 108)), lambda c: (c[0], _zero, _zc), _gn+'-axle')
        _axis_wind(_gm, list(range(108, 114)), lambda c: (-0.0625, 0.0, -0.825), _gn+'-link0')
        _axis_wind(_gm, list(range(114, 120)), lambda c: (0.0625, 0.0, -0.825), _gn+'-link1')
        _nw = 60
        _base = 120
        _offs = (-0.13, 0.13) if _gn == 'gear_N' else (0.0,)
        for _wi, _wo in enumerate(_offs):
            _axis_wind(_gm, list(range(_base+_wi*_nw, _base+(_wi+1)*_nw)),
                           lambda c, _x=_wo, _z=-1.30 if _gn == 'gear_N' else -1.08: (_x, 0.0, _z),
                           '%s-wheel%d-axis' % (_gn, _wi))
    _det = bpy.data.objects['details'].data
    _det.update()
    def _ax(partname, ref_fn, label):
        if partname in FUSE_RANGES:
            _a, _b = FUSE_RANGES[partname]; _mo = _fuse
        else:
            _a, _b = DETAIL_RANGES[partname]; _mo = _det
        _axis_wind(_mo, list(range(_a, _b)), ref_fn, label)
    _ax('stinger', lambda c: (0.0, c[1], -0.025), 'fuselage-stinger-axis')
    _fil0 = [(2.45, -1.9, 0.53), (1.65, -1.9, 0.54), (0.85, -1.9, 0.53), (0.05, -1.9, 0.52), (-0.55, -1.9, 0.51)]
    _fil1 = [(x, -y, z) for (x, y, z) in _fil0]
    def _fil_ref(spine):
        def fn(c):
            best = None; bd = 1e18
            for q in spine:
                dd = (c[0]-q[1])**2 + (c[1]-q[0])**2 + (c[2]-q[2])**2
                if dd < bd:
                    bd = dd; best = (q[1], q[0], q[2])
            return best
        return fn
    _ax('fillet_L', _fil_ref(_fil0), 'fuselage-filletL-axis')
    _ax('fillet_R', _fil_ref(_fil1), 'fuselage-filletR-axis')
    for _tag, _sgn2 in (('L', 1), ('R', -1)):
        _imo = bpy.data.objects['intake_'+_tag].data
        _imo.update()
        _axis_wind(_imo, [280, 281], lambda c: (c[0], c[1]+1.0, c[2]), 'intake-%s-back' % _tag)
        _axis_wind(_imo, [282, 283], lambda c: (c[0], c[1]+1.0, c[2]+0.3), 'intake-%s-ramp' % _tag)
        _axis_wind(_imo, [284, 285], lambda c: (c[0], c[1], c[2]-1.0), 'intake-%s-sleeveTop' % _tag)
        _axis_wind(_imo, [286, 287], lambda c: (c[0], c[1], c[2]+1.0), 'intake-%s-sleeveBot' % _tag)
        _axis_wind(_imo, [288, 289], lambda c: (c[0]-_sgn2, c[1], c[2]), 'intake-%s-sleeveIn' % _tag)
        _axis_wind(_imo, [290, 291], lambda c: (c[0]+_sgn2, c[1], c[2]), 'intake-%s-sleeveOut' % _tag)
    _ax('pitot', lambda c: (0.0, c[1], -0.06), 'details-pitot-axis')
    _ax('aoa_L', lambda c: (-0.58, c[1], 0.42), 'details-aoaL-axis')
    _ax('aoa_R', lambda c: (0.58, c[1], 0.42), 'details-aoaR-axis')
    def _seg_ref(p0, p1):
        def fn(c):
            ax = p1[0]-p0[0]; ay = p1[1]-p0[1]; az = p1[2]-p0[2]
            t = ((c[0]-p0[0])*ax + (c[1]-p0[1])*ay + (c[2]-p0[2])*az)/max(1e-9, ax*ax+ay*ay+az*az)
            t = max(0.0, min(1.0, t))
            return (p0[0]+ax*t, p0[1]+ay*t, p0[2]+az*t)
        return fn
    _blseg = {'blade-spine-fwd': ((0.0, 1.75, 0.70), (0.0, 1.70, 0.87)),
              'blade-belly-mid': ((0.0, 0.55, -0.78), (0.0, 0.55, -0.95)),
              'blade-spine-aft': ((0.0, -2.20, 0.68), (0.0, -2.15, 0.83)),
              'blade-belly-nose': ((0.0, 5.40, -0.62), (0.0, 5.40, -0.77))}
    for _bn2 in ('blade-spine-fwd', 'blade-belly-mid', 'blade-spine-aft', 'blade-belly-nose'):
        _s0, _s1 = _blseg[_bn2]
        _ax(_bn2, _seg_ref(_s0, _s1), 'details-%s-axis' % _bn2)
    for _sgn2, _tag2 in ((-1, 'L'), (1, 'R')):
        _mo2 = bpy.data.objects['fin_'+_tag2].data
        _mo2.update()
        _rLE = (s2x(14.3), _sgn2*1.35, 0.60); _rTE = (s2x(17.9), _sgn2*1.35, 0.60)
        _tLE = (s2x(16.6), _sgn2*1.35, 3.53); _tTE = (s2x(18.3), _sgn2*1.35, 3.53)
        _m0 = ((_rLE[1]+_rTE[1])/2, (_rLE[0]+_rTE[0])/2, 0.60)
        _m1 = ((_tLE[1]+_tTE[1])/2, (_tLE[0]+_tTE[0])/2, 3.53)
        _axis_wind(_mo2, list(range(len(_mo2.polygons))), _seg_ref(_m0, _m1), 'fin-%s-axis' % _tag2)
    _bb0 = DETAIL_RANGES['blade-spine-fwd'][0]
    _part_wind(_det, _dcx, 0, 0, list(range(_bb0, _bb0+32)), 'details-blade-grids')
    _part_wind(_det, _dcx, 0, 0, list(range(_bb0+32, _bb0+36)), 'details-blade-LErim')
    _part_wind(_det, _dcx, 0, 0, list(range(_bb0+36, _bb0+44)), 'details-blade-tiprim')
    _part_wind(_det, _dcx, 0, 0, list(range(_bb0+44, _bb0+52)), 'details-blade-rootrim')
    _part_wind(_det, _dcx, 0, 0, list(range(_bb0+52, _bb0+56)), 'details-blade-TE')
    for _si2, _sx2 in (('stabfair-L', -1.7), ('stabfair-R', 1.7)):
        _ax(_si2, lambda c, _x=_sx2: (_x, -6.95, 0.05), 'details-%s-axis' % _si2)
    for _bi, (_bx, _bz) in enumerate([(-1.2, -0.805), (-1.95, -0.805), (1.2, -0.805), (1.95, -0.805)]):
        _ax('bay%d' % _bi, lambda c, _x=_bx: (_x, -0.45, -0.805), 'details-bay%d' % _bi)
except Exception as _e:
    print('part audit skip:', _e)

# ---------------- smoothing + UV + normals ----------------
bpy.ops.object.select_all(action='DESELECT')
for o in MODEL_OBJS:
    o.select_set(True)
bpy.context.view_layer.objects.active = MODEL_OBJS[0]
bpy.ops.object.shade_smooth()

# ---------------- smoothing + UV (uniform texel density) ----------------
bpy.ops.object.select_all(action='DESELECT')
for o in MODEL_OBJS:
    o.select_set(True)
bpy.context.view_layer.objects.active = MODEL_OBJS[0]
bpy.ops.object.shade_smooth()

SKIP_SMART = set()  # smart-project everything first; loft parts get cylindrical UV after
for o in MODEL_OBJS:
    # Source winding is authored outward (verified by WIND audit above).
    # normals_make_consistent was removed on purpose: it flipped open parts
    # (intake ducts) and hid the inverted-source bug that broke the game.
    if o.name in SKIP_SMART:
        continue
    try:
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=66, island_margin=0.02)
        bpy.ops.object.mode_set(mode='OBJECT')
    except Exception as e:
        try: bpy.ops.object.mode_set(mode='OBJECT')
        except Exception: pass
        print('UV skip:', o.name, e)

for _ob, _uvl in APPLY_UV:
    apply_part_uv(_ob, _uvl)
APPLY_UV.clear()

def _ensure_uv(me):
    uv = me.uv_layers.active
    if uv is None:
        uv = me.uv_layers.new(name='UVMap')
    return me.uv_layers.active

def _write_loft_uv(me, ring_n, n_rings, n_side_faces, k0=0):
    # cylindrical UV in meters from mesh rings (Blender X right, Y fwd, Z up).
    # side faces are the first n_side_faces polygons, ordered segment-major.
    # u seam placed at ring index k0 (bottom = hidden).
    import mathutils as _MU
    uv = _ensure_uv(me)
    data = uv.data
    # ring centroids + cumulative perimeter per ring, seam at k0
    ring_c = []
    ring_u = []
    for i in range(n_rings):
        pts = [me.vertices[i*ring_n+k].co for k in range(ring_n)]
        cx = sum(p[0] for p in pts)/ring_n
        cy = sum(p[1] for p in pts)/ring_n
        cz = sum(p[2] for p in pts)/ring_n
        ring_c.append(_MU.Vector((cx, cy, cz)))
        order = [(k0+k) % ring_n for k in range(ring_n)]
        uk = [0.0]*ring_n
        run = 0.0
        uk[order[0]] = 0.0
        for j in range(ring_n):
            a = pts[order[j]]
            b = pts[order[(j+1) % ring_n]]
            run += (b-a).length
            if j+1 < ring_n:
                uk[order[j+1]] = run
        ring_u.append(uk)
    # centerline arclength
    varc = [0.0]
    for i in range(1, n_rings):
        varc.append(varc[-1] + (ring_c[i]-ring_c[i-1]).length)
    for pi in range(min(n_side_faces, len(me.polygons))):
        p = me.polygons[pi]
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            i = vi // ring_n; k = vi % ring_n
            if i >= n_rings:
                continue
            data[li].uv = (ring_u[i][k], varc[i])

SKIN_MATS = {'skin', 'skin_dark', 'glass', 'metal_nozzle'}
TEX_DENSITY = 4.0  # world meters per 1.0 UV

def _islands(me, data):
    # union-find UV islands: shared mesh edge + matching UVs at both ends
    edge_map = {}
    for p in me.polygons:
        li = p.loop_indices
        n = len(li)
        for e in range(n):
            l0, l1 = li[e], li[(e+1) % n]
            v0, v1 = me.loops[l0].vertex_index, me.loops[l1].vertex_index
            key = (v0, v1) if v0 < v1 else (v1, v0)
            u0, u1 = tuple(data[l0].uv), tuple(data[l1].uv)
            if v0 > v1:
                u0, u1 = u1, u0
            edge_map.setdefault(key, []).append((p.index, u0, u1))
    parent = {}
    def find(a):
        while parent.get(a, a) != a:
            parent[a] = parent.get(parent[a], parent[a])
            a = parent[a]
        return a
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    for key, lst in edge_map.items():
        if len(lst) != 2:
            continue
        (fa, au0, au1), (fb, bu0, bu1) = lst
        du = abs(au0[0]-bu0[0])+abs(au0[1]-bu0[1])+abs(au1[0]-bu1[0])+abs(au1[1]-bu1[1])
        du2 = abs(au0[0]-bu1[0])+abs(au0[1]-bu1[1])+abs(au1[0]-bu0[0])+abs(au1[1]-bu0[1])
        if min(du, du2) < 1e-4:
            union(fa, fb)
    isl = {}
    for p in me.polygons:
        isl.setdefault(find(p.index), []).append(p.index)
    return list(isl.values())

def _isl_uv_area(me, data, faces):
    a = 0.0
    for fi in faces:
        p = me.polygons[fi]
        uv = [data[li].uv for li in p.loop_indices]
        for i in range(1, len(uv)-1):
            e1 = uv[i]-uv[0]; e2 = uv[i+1]-uv[0]
            a += abs(e1.x*e2.y - e1.y*e2.x)/2
    return a

def _isl_world_area(me, faces):
    return sum(me.polygons[fi].area for fi in faces)

try:
    _fuse = bpy.data.objects['fuselage'].data
    _write_loft_uv(_fuse, 52, 13, 12*52, k0=39)
    _fuseloops = _fuse.uv_layers.active.data
    for _ri, _rlab in ((0, 'nose-tip'), (2, 'nose-mid')):
        _us = []
        for _fi in range(_ri*52, _ri*52+52):
            for _li in _fuse.polygons[_fi].loop_indices:
                _vi = _fuse.loops[_li].vertex_index
                if _vi // 52 == _ri:
                    _us.append(_fuseloops[_li].uv[0])
        print('cyl-uv %s u-range: %.2f .. %.2f (v-run %.2f)' % (_rlab, min(_us), max(_us),
              max(_fuseloops[_li].uv[1] for _fi in range(_ri*52, _ri*52+52) for _li in _fuse.polygons[_fi].loop_indices) -
              min(_fuseloops[_li].uv[1] for _fi in range(_ri*52, _ri*52+52) for _li in _fuse.polygons[_fi].loop_indices)))
    _can = bpy.data.objects['canopy'].data
    _write_loft_uv(_can, 24, 8, 7*24, k0=18)
    for _tag in ('intake_L', 'intake_R'):
        _im = bpy.data.objects[_tag].data
        _write_loft_uv(_im, 56, 6, 5*56, k0=0)
    for o in MODEL_OBJS:
        me = o.data
        if not me.materials:
            continue
        if any(s.name not in SKIN_MATS and s.name != 'cockpit' for s in me.materials):
            continue
        uv = me.uv_layers.active
        if uv is None:
            continue
        data = uv.data
        for isl in _islands(me, data):
            w3 = _isl_world_area(me, isl)
            w2 = _isl_uv_area(me, data, isl)
            if w3 <= 1e-9 or w2 <= 1e-9:
                continue
            s = math.sqrt(w3/w2)/TEX_DENSITY
            if abs(s-1.0) < 1e-6:
                continue
            cx = sum(data[me.polygons[fi].loop_indices[0]].uv[0] for fi in isl)/len(isl)
            cy = sum(data[me.polygons[fi].loop_indices[0]].uv[1] for fi in isl)/len(isl)
            for fi in isl:
                for li in me.polygons[fi].loop_indices:
                    u = data[li].uv
                    data[li].uv = (cx + (u[0]-cx)*s, cy + (u[1]-cy)*s)
    print('UV density unified per-island to %.1f m/uv' % TEX_DENSITY)
except Exception as e:
    print('UV direct/rescale skip:', e)

# ---------------- tri count (evaluated) ----------------
try:
    deps = bpy.context.evaluated_depsgraph_get()
    total = 0
    for o in MODEL_OBJS:
        try:
            ev = o.evaluated_get(deps)
            m = ev.to_mesh()
            m.calc_loop_triangles()
            total += len(m.loop_triangles)
            ev.to_mesh_clear()
        except Exception as e:
            print('tricount skip', o.name, e)
    print('TRI_TOTAL_EST:', total)
except Exception as e:
    print('tricount fail', e)

# ---------------- panel_lines vertex groups (NO geometry change; for normal-map baking) ----------------
# base-mesh vertex indices; baker maps them (note: export applies subsurf, so indices refer to the cage mesh)
import json as _pjs
_panel = {}
def _mark(obname, idxs, label):
    try:
        ob = bpy.data.objects[obname]
        vg = ob.vertex_groups.get('panel_lines') or ob.vertex_groups.new(name='panel_lines')
        vg.add([int(i) for i in idxs], 1.0, 'REPLACE')
        _panel.setdefault(obname, []).append({'label': label, 'count': len(idxs), 'verts': [int(i) for i in idxs]})
    except Exception as e:
        print('panel group skip:', obname, e)
for _si, _sl in ((2, 'radome-joint'), (5, 'intake-start'), (7, 'wing-LE'), (9, 'TE-engines'), (12, 'nozzle-face')):
    _mark('fuselage', list(range(_si*52, (_si+1)*52)), _sl)
_mark('canopy', list(range(0, 24)), 'windshield-base')
_mark('canopy', list(range(6*24, 7*24)), 'rear-frame')
for _t in ('L', 'R'):
    _mark('intake_'+_t, list(range(56)), 'lip-ring')
for _t in ('L', 'R'):
    _mark('nozzle_'+_t, list(range(32)), 'front-ring')
    _mark('nozzle_'+_t, list(range(4*32, 5*32)), 'exit-ring')
try:
    with open(os.path.join(OUT_DIR, 'panel_lines.json'), 'w') as _pf:
        _pjs.dump(_panel, _pf, indent=1)
    print('panel_lines groups:', {k: sum(e['count'] for e in v) for k, v in _panel.items()})
except Exception as e:
    print('panel json skip:', e)

# ---------------- export GLB (no Draco: loader dependency free) ----------------
# attributes are POSITION/NORMAL/TEXCOORD_0 only (no vertex colors, no 2nd UV, no tangents)
bpy.ops.object.select_all(action='DESELECT')
for o in MODEL_OBJS:
    if o.name != 'v2_clay_gray':
        o.select_set(True)
bpy.ops.export_scene.gltf(filepath=GLB_PATH, export_format='GLB', use_selection=True,
                           export_apply=True, export_yup=True)
print('exported:', GLB_PATH)

# ---------------- render setup ----------------
import mathutils
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
try: scene.display.shading.color_type = 'MATERIAL'
except Exception: pass
try:
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = 'SCREEN'
except Exception: pass
world = bpy.data.worlds.new('v2_world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.5, 0.52, 0.55, 1.0)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
scene.world = world
for lname, lpos, energy in (('key', (12, 18, 10), 3.0), ('fill', (-14, 6, 4), 0.8), ('rim', (-6, -16, 8), 1.5), ('under', (4, 2, -14), 1.0)):
    ld = bpy.data.lights.new(lname, 'SUN'); ld.energy = energy
    lo = bpy.data.objects.new(lname, ld); scene.collection.objects.link(lo)
    lo.location = lpos
    d = mathutils.Vector((0, 0.5, 0.3)) - mathutils.Vector(lpos)
    lo.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

cam_data = bpy.data.cameras.new('v2_cam')
cam = bpy.data.objects.new('v2_cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

allmin = [1e9]*3; allmax = [-1e9]*3
for o in MODEL_OBJS:
    lx, ly, lz = o.location
    for v in o.data.vertices:
        wx, wy, wz = v.co[0]+lx, v.co[1]+ly, v.co[2]+lz
        allmin[0] = min(allmin[0], wx); allmin[1] = min(allmin[1], wx*0+wy); allmin[2] = min(allmin[2], wz)
        allmax[0] = max(allmax[0], wx); allmax[1] = max(allmax[1], wy); allmax[2] = max(allmax[2], wz)
print('bounds:', allmin, allmax)
center = [(allmin[i]+allmax[i])/2 for i in range(3)]
corners = [[allmin[0] if i&1 else allmax[0], allmin[1] if i&2 else allmax[1], allmin[2] if i&4 else allmax[2]] for i in range(8)]

def frame_persp(vdir, lens=50):
    dd = mathutils.Vector(vdir).normalized()
    vfov = 2*math.atan(12/lens); hfov = 2*math.atan(18/lens)
    tv, th = math.tan(vfov/2), math.tan(hfov/2)
    need = 0
    for c in corners:
        rel = mathutils.Vector((c[0]-center[0], c[1]-center[1], c[2]-center[2]))
        along = rel.dot(dd)
        perp = rel - along*dd
        up = abs(perp.z); side = (perp - perp.z*mathutils.Vector((0,0,1))).length
        need = max(need, up/tv - along, side/th - along)
    dist = need*1.1 + 0.5
    cam.location = (center[0]-dd[0]*dist, center[1]-dd[1]*dist, center[2]-dd[2]*dist)
    cam.rotation_euler = dd.to_track_quat('-Z', 'Y').to_euler()
    return dist

# gray-clay swap helper for ortho
saved_mats = {}
def set_clay(on):
    for o in MODEL_OBJS:
        me = o.data
        if on:
            saved_mats[o.name] = [s for s in me.materials]
            me.materials.clear()
            me.materials.append(GRAY_CLAY)
        else:
            me.materials.clear()
            for s in saved_mats.get(o.name, []):
                me.materials.append(s)

# ---------------- ortho 3-view (white bg, gray) ----------------
scene.render.resolution_x = 1600; scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = True
try: scene.display.shading.background_type = 'WORLD'
except Exception: pass
try: scene.display.shading.background_color = (1, 1, 1)
except Exception: pass
try:
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1.0)
except Exception: pass
set_clay(True)
# flat unlit silhouettes for verification
try:
    _prev_light = scene.display.shading.light
    _prev_cavity = scene.display.shading.show_cavity
except Exception:
    _prev_light, _prev_cavity = 'STUDIO', True
try: scene.display.shading.light = 'FLAT'
except Exception: pass
try: scene.display.shading.show_cavity = False
except Exception: pass
cam_data.type = 'ORTHO'
ortho_meta = {}
views_ortho = {
    'top':    dict(dir=(0, 0, -1), scale=38.0, up_axis='Y', right_axis='X'),
    'side':   dict(dir=(1, 0.02, -0.03), scale=24.0, up_axis='Z', right_axis='Yfwd'),
    'front':  dict(dir=(0, -1, 0.02), scale=16.0, up_axis='Z', right_axis='Xneg'),
}
import mathutils as MU
for vname, v in views_ortho.items():
    dd = MU.Vector(v['dir']).normalized()
    cam_data.ortho_scale = v['scale']
    # center camera on object center projected
    cam.location = (center[0]-dd[0]*30, center[1]-dd[1]*30, center[2]-dd[2]*30)
    cam.rotation_euler = dd.to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(OUT_DIR, 'ortho_%s_raw.png' % vname)
    bpy.ops.render.render(write_still=True)
    print('rendered ortho', vname)
    ortho_meta[vname] = dict(scale=v['scale'], center=center,
        cam_loc=list(cam.location), cam_rot=list(cam.rotation_euler))
with open(os.path.join(OUT_DIR, 'ortho_meta.json'), 'w') as f:
    json.dump(dict(center=center, views={k: dict(scale=v['scale']) for k, v in views_ortho.items()}), f, indent=1)
set_clay(False)
try: scene.display.shading.light = _prev_light
except Exception: pass
try: scene.display.shading.show_cavity = _prev_cavity
except Exception: pass

# ---------------- perspective 6 views ----------------
try:
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.45, 0.47, 0.5, 1.0)
except Exception: pass
scene.render.film_transparent = False
cam_data.type = 'PERSP'
scene.render.resolution_x = 1280; scene.render.resolution_y = 720
views = {
    'front_level': ((0.08, -1, -0.02), 50),
    'side': ((1, 0.04, -0.06), 50),
    'top': ((0, 0, -1), 50),
    'bottom': ((0, 0, 1), 50),
    'tqf': ((-0.5, -0.7, -0.4), 50),
    'tqr': ((0.5, 0.7, -0.35), 50),
}
for vname, (vdir, lens) in views.items():
    cam_data.lens = lens
    d = frame_persp(vdir, lens)
    scene.render.filepath = os.path.join(OUT_DIR, 'preview_%s.png' % vname)
    bpy.ops.render.render(write_still=True)
    print('rendered:', vname, d)

# ---------------- dogtooth closeup (stab LE notch at v=0.45, right side) ----------------
cam_data.lens = 50
# notch world (Blender): X=+2.87, Y=-6.72, Z=0.10
nt = (2.87, -6.75, 0.10)
cam.location = (nt[0]+2.2, nt[1]+2.6, nt[2]+2.4)
dd = mathutils.Vector((nt[0]-cam.location[0], nt[1]-cam.location[1], nt[2]-cam.location[2])).normalized()
cam.rotation_euler = dd.to_track_quat('-Z', 'Y').to_euler()
scene.render.filepath = os.path.join(OUT_DIR, 'closeup_stab_notch.png')
bpy.ops.render.render(write_still=True)
print('rendered: closeup_stab_notch')
for _ck, _ct, _co in (('closeup_wingtip', (6.39, -3.10, 0.35), (0.8, 0.8, 4.5)),
                       ('closeup_fintip', (1.35, -7.00, 3.55), (2.0, 2.5, 2.2))):
    cam.location = (_ct[0]+_co[0], _ct[1]+_co[1], _ct[2]+_co[2])
    dd = mathutils.Vector((_ct[0]-cam.location[0], _ct[1]-cam.location[1], _ct[2]-cam.location[2])).normalized()
    cam.rotation_euler = dd.to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(OUT_DIR, _ck+'.png')
    bpy.ops.render.render(write_still=True)
    print('rendered:', _ck)

# ---------------- checker UV diagnostic (tqf framing, all slots -> checker) ----------------
try:
    cimg = bpy.data.images.new('v2_checker', 512, 512)
    px = [0.0]*(512*512*4)
    for yy in range(512):
        for xx in range(512):
            on = ((xx//64) + (yy//64)) % 2 == 0
            v = 1.0 if on else 0.05
            i = (yy*512+xx)*4
            px[i] = v; px[i+1] = v; px[i+2] = v; px[i+3] = 1.0
    cimg.pixels[:] = px
    cmat = bpy.data.materials.new('v2_checker_mat')
    cmat.use_nodes = True
    bsdf = cmat.node_tree.nodes.get('Principled BSDF')
    tex = cmat.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = cimg
    try:
        cmat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    except Exception:
        pass
    saved2 = {}
    for o in MODEL_OBJS:
        me = o.data
        saved2[o.name] = [s for s in me.materials]
        me.materials.clear()
        me.materials.append(cmat)
    try:
        _prev_ct = scene.display.shading.color_type
    except Exception:
        _prev_ct = 'MATERIAL'
    try: scene.display.shading.color_type = 'TEXTURE'
    except Exception: pass
    d = frame_persp((-0.5, -0.7, -0.4), 50)
    scene.render.filepath = os.path.join(OUT_DIR, 'check_uv_tqf.png')
    bpy.ops.render.render(write_still=True)
    print('rendered: check_uv_tqf')
    try: scene.display.shading.color_type = _prev_ct
    except Exception: pass
    for o in MODEL_OBJS:
        me = o.data
        me.materials.clear()
        for s in saved2.get(o.name, []):
            me.materials.append(s)
except Exception as e:
    print('checker skip:', e)

# ---------------- backface-culling proof renders (single-sided game check) ----------------
try:
    scene.display.shading.show_backface_culling = True
    for _cn, (_cv, _cl) in (('cull_front', ((0.08, -1, -0.02), 50)), ('cull_tqf', ((-0.5, -0.7, -0.4), 50)),
                            ('cull_side', ((1, 0.04, -0.06), 50)), ('cull_bottom', ((0, 0, 1), 50))):
        cam_data.lens = _cl
        frame_persp(_cv, _cl)
        scene.render.filepath = os.path.join(OUT_DIR, _cn+'.png')
        bpy.ops.render.render(write_still=True)
        print('rendered:', _cn)
except Exception as e:
    print('cull skip:', e)
try:
    scene.display.shading.show_backface_culling = False
except Exception:
    pass
print('V2_DONE')
