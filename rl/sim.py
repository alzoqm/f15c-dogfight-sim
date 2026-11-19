"""F-15C 6-DOF 비행역학 — src/flightmodel.js · f15.js · atmosphere.js 의 벡터화(numpy) 이식.

배치 B대의 기체를 한꺼번에 적분한다 (강화학습용 대량 병렬 시뮬레이션).
좌표계는 JS와 동일:
  - 월드(three.js): X 동, Y 위, -Z 북. 기체 로컬: 기수 -Z, 위 +Y, 오른쪽 +X
  - 공력 기체좌표: x 기수, y 오른쪽, z 아래. 각속도 omega = (p, q, r)
  - 쿼터니언 (x, y, z, w)
AI 기체 기준 (G 명령 CAS, 연료 고정, 착륙장치·플랩 없음, 평평한 지면 높이 0).
"""
import numpy as np

D2R = np.pi / 180.0
R2D = 180.0 / np.pi
G0 = 9.80665

# ---------------------------------------------------------------- 제원 (f15.js)
S, B_SPAN, C_MAC = 56.5, 13.05, 4.86
MASS_EMPTY, MASS_CREW, FUEL_INT, GUN_AMMO, ROUND_MASS = 12973.0, 110.0, 6103.0, 940, 0.26
INERTIA_REF = dict(mass=20412.0, Ixx=38912.0, Iyy=223846.0, Izz=254760.0, Ixz=-705.0)
ENG = dict(milSL=64900.0, abSL=105700.0, idleN=0.66)
DE_UP, DE_DOWN, DE_RATE = 29 * D2R, 15 * D2R, 40 * D2R
DA_MAX, DA_RATE = 20 * D2R, 90 * D2R
DR_MAX, DR_RATE = 30 * D2R, 90 * D2R
NZ_MAX, NZ_MIN = 9.0, -3.0
NZ_STRUCT, NZ_STRUCT_NEG = 13.5, -6.5
ALPHA_CAS, ALPHA_CAS_NEG = 30 * D2R, -12 * D2R


def _tab(t):
    a = np.array(t, dtype=np.float64)
    return a[:, 0].copy(), a[:, 1].copy()


CL_TAB = _tab([[-90, 0], [-70, -0.62], [-50, -0.9], [-40, -0.84], [-30, -0.86], [-25, -0.87],
               [-20, -0.8], [-15, -0.67], [-10, -0.49], [-5, -0.24], [0, 0.03], [5, 0.31],
               [10, 0.6], [15, 0.88], [20, 1.12], [25, 1.32], [30, 1.46], [35, 1.52], [40, 1.48],
               [45, 1.38], [50, 1.26], [60, 1.03], [70, 0.72], [80, 0.37], [90, 0]])
CLM_TAB = _tab([[0, 1.0], [0.6, 1.04], [0.85, 1.12], [0.95, 1.16], [1.05, 1.12], [1.2, 1.0], [1.5, 0.84], [2.0, 0.66], [2.5, 0.54]])
CD0_TAB = _tab([[0, 0.0205], [0.7, 0.0205], [0.85, 0.022], [0.92, 0.025], [0.97, 0.032], [1.02, 0.041], [1.1, 0.044], [1.2, 0.0425], [1.5, 0.0375], [2.0, 0.0315], [2.5, 0.0285]])
K_TAB = _tab([[0, 0.128], [0.8, 0.132], [0.95, 0.15], [1.1, 0.22], [1.5, 0.3], [2.0, 0.4], [2.5, 0.48]])
CMA_TAB = _tab([[0, -0.28], [0.8, -0.3], [0.9, -0.36], [1.0, -0.55], [1.2, -0.8], [1.5, -0.86], [2.5, -0.86]])
CMQ_TAB = _tab([[0, -4.6], [0.9, -4.8], [1.2, -3.8], [2.5, -3.0]])
CMDE_TAB = _tab([[0, 0.48], [0.8, 0.48], [0.95, 0.45], [1.1, 0.38], [1.5, 0.33], [2.0, 0.28], [2.5, 0.25]])
AIL_M_TAB = _tab([[0, 1], [0.9, 1], [1.2, 0.75], [2.0, 0.55], [2.5, 0.5]])
DIR_M_TAB = _tab([[0, 1], [1.0, 1], [1.5, 0.75], [2.0, 0.55], [2.5, 0.45]])


def interp(tab, x):
    return np.interp(x, tab[0], tab[1])


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def move_toward(cur, target, max_delta):
    d = target - cur
    return np.where(np.abs(d) <= max_delta, target, cur + np.sign(d) * max_delta)


# ---------------------------------------------------------------- 대기 (atmosphere.js)
R_AIR, GAMMA = 287.05287, 1.4
RHO0, P0, T0 = 1.225, 101325.0, 288.15


def isa(h):
    h = np.clip(h, -500.0, 32000.0)
    T1 = T0 - 0.0065 * h
    p1 = P0 * np.power(np.maximum(T1, 1.0) / T0, 5.255877)
    p2 = 22632.06 * np.exp(-G0 * (h - 11000.0) / (R_AIR * 216.65))
    T3 = 216.65 + 0.001 * (h - 20000.0)
    p3 = 5474.889 * np.power(216.65 / T3, 34.1632)
    T = np.where(h < 11000, T1, np.where(h < 20000, 216.65, T3))
    p = np.where(h < 11000, p1, np.where(h < 20000, p2, p3))
    rho = p / (R_AIR * T)
    a = np.sqrt(GAMMA * R_AIR * T)
    return T, p, rho, a, rho / RHO0


def impact_pressure(M, p):
    sub = p * (np.power(1 + 0.2 * M * M, 3.5) - 1)
    Ms = np.maximum(M, 1.0)
    sup = p * (166.9215801 * np.power(Ms, 7) / np.power(7 * Ms * Ms - 1, 2.5) - 1)
    return np.where(M <= 1, sub, sup)


# ---------------------------------------------------------------- 공력 (f15.js)
def cl_basic(alpha, M):
    ad = alpha * R2D
    cl = np.where(ad > 90, -interp(CL_TAB, 180 - ad) * 0.7,
                  np.where(ad < -90, -interp(CL_TAB, -180 - ad) * 0.7, interp(CL_TAB, ad)))
    return cl * interp(CLM_TAB, M)


_INV_A = np.array([-12, -10, -5, 0, 5, 10, 15, 20, 25, 30], dtype=np.float64)
_INV_CL = np.interp(_INV_A, CL_TAB[0], CL_TAB[1])


def alpha_for_cl(CLreq, M, aMin, aMax):
    """f15.js alphaForCL (이분법)의 정확한 역함수: CL(α)는 −12°~30°에서 단조 증가하는 구간 선형 → 표 역보간
    (aMin = −12°, aMax = 30° 전용, 플랩 없음)"""
    return np.interp(CLreq / interp(CLM_TAB, M), _INV_CL, _INV_A) * D2R


def aero_coeffs(alpha, beta, M, phat, qhat, rhat, sb, agl, t):
    a, b = alpha, beta
    aAbsDeg = np.abs(a) * R2D
    sa, ca = np.sin(a), np.cos(a)
    sbeta = np.sin(b)
    hb = np.maximum(0.3, agl) / B_SPAN
    ge = (256 * hb * hb) / (1 + 256 * hb * hb)
    CL = cl_basic(a, M)
    CL = CL * (1 + 0.09 * (1 - ge))
    CLw = CL
    cd0 = interp(CD0_TAB, M)
    k = interp(K_TAB, M)
    cdAtt = cd0 + k * CLw * CLw * ge
    cdFlat = cd0 + 1.25 * sa * sa
    CD = np.maximum(cdAtt, cdFlat) + 0.55 * sbeta * sbeta + sb * 0.055
    CY = -0.9 * sbeta
    aPos = np.clip(a, 0, 0.8)
    Clb = -(0.045 + 0.13 * np.sin(aPos))
    Clp = -0.28 + 0.36 * smoothstep(26, 50, aAbsDeg)
    Clr = 0.04 + 0.1 * np.clip(CLw, 0, 1.5)
    effA = np.maximum(0.22, ca * ca) * interp(AIL_M_TAB, M)
    Clda = 0.09 * effA
    Cldr = -0.008
    machDir = interp(DIR_M_TAB, M)
    Cnb = np.where(aAbsDeg < 32, 0.12 * (1 - (aAbsDeg / 32) ** 2), -0.06 * smoothstep(32, 48, aAbsDeg)) * machDir
    Cnr = -0.36 * (0.35 + 0.65 * np.maximum(0, np.cos(2 * a)))
    Cnp = -0.03 - 0.06 * np.clip(sa, 0, 0.7)
    Cnda = -0.008 * effA
    Cndr = 0.075 * np.maximum(0.18, ca * ca) * np.where(M > 1, interp(DIR_M_TAB, M), 1.0)
    Cma = interp(CMA_TAB, M)
    Cmq = interp(CMQ_TAB, M)
    Cmde = interp(CMDE_TAB, M) * np.maximum(0.35, 1 - 0.5 * sa * sa)
    Cm = 0.004 + Cma * np.sin(a) * np.where(np.abs(a) > np.pi / 2, -1.0, 1.0) + Cmq * qhat
    Cm = Cm + 0.012 * sb - 0.015 * (1 - ge)
    rock = smoothstep(28, 42, aAbsDeg)
    Cl = Clb * sbeta + Clp * phat + Clr * rhat + rock * 0.012 * np.sin(t * 2.3 + np.sin(t * 0.7))
    Cn = Cnb * sbeta + Cnr * rhat + Cnp * phat + rock * 0.004 * np.sin(t * 1.1 + 1.3)
    return dict(CL=CL, CD=CD, CY=CY, Cl=Cl, Cm=Cm, Cn=Cn, Cmde=Cmde, CLde=-0.25, CDde=0.05,
                Clda=Clda, Cldr=Cldr, Cnda=Cnda, Cndr=Cndr, CYdr=-0.15)


# ---------------------------------------------------------------- 쿼터니언/벡터
def qrot(q, v):
    """three.js Vector3.applyQuaternion — q (...,4) xyzw, v (...,3)"""
    qx, qy, qz, qw = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    x, y, z = v[..., 0], v[..., 1], v[..., 2]
    ix = qw * x + qy * z - qz * y
    iy = qw * y + qz * x - qx * z
    iz = qw * z + qx * y - qy * x
    iw = -qx * x - qy * y - qz * z
    return np.stack([ix * qw + iw * -qx + iy * -qz - iz * -qy,
                     iy * qw + iw * -qy + iz * -qx - ix * -qz,
                     iz * qw + iw * -qz + ix * -qy - iy * -qx], axis=-1)


def qconj(q):
    return np.stack([-q[..., 0], -q[..., 1], -q[..., 2], q[..., 3]], axis=-1)


def qmul(a, b):
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([ax * bw + aw * bx + ay * bz - az * by,
                     ay * bw + aw * by + az * bx - ax * bz,
                     az * bw + aw * bz + ax * by - ay * bx,
                     aw * bw - ax * bx - ay * by - az * bz], axis=-1)


def local_to_aero(v):
    return np.stack([-v[..., 2], v[..., 0], -v[..., 1]], axis=-1)


def aero_to_local(a):
    return np.stack([a[..., 1], -a[..., 2], -a[..., 0]], axis=-1)


def quat_from_euler_yxz(pitch, yaw):
    """THREE.Euler(pitch, yaw, 0, 'YXZ') → 쿼터니언"""
    c1, s1 = np.cos(pitch / 2), np.sin(pitch / 2)
    c2, s2 = np.cos(yaw / 2), np.sin(yaw / 2)
    c3, s3 = 1.0, 0.0
    x = s1 * c2 * c3 + c1 * s2 * s3
    y = c1 * s2 * c3 - s1 * c2 * s3
    z = c1 * c2 * s3 - s1 * s2 * c3
    w = c1 * c2 * c3 + s1 * s2 * s3
    return np.stack([x, y, z, w], axis=-1)


def norm(v):
    return np.sqrt(np.sum(v * v, axis=-1))


# ---------------------------------------------------------------- 기체 배치
class Fleet:
    """B대의 F-15C 상태 (모두 numpy 배열)"""

    def __init__(self, B):
        self.B = B
        z = lambda: np.zeros(B)
        self.pos = np.zeros((B, 3))
        self.vel = np.zeros((B, 3))
        self.quat = np.tile(np.array([0, 0, 0, 1.0]), (B, 1))
        self.omega = np.zeros((B, 3))
        self.fuel = np.full(B, FUEL_INT)
        self.ammo = np.full(B, float(GUN_AMMO))
        self.thrust_mul = np.ones(B)
        self.nz_bonus = z()
        # 조종 입력
        self.c_pitch, self.c_roll, self.c_yaw, self.c_thr = z(), z(), z(), z()
        self.sb_cmd = np.zeros(B, dtype=bool)
        self.sb_pos = z()
        # 구동기
        self.de, self.da, self.dr = z(), z(), z()
        # 엔진 (좌우 동일 입력 → 한 대로 계산 후 ×2)
        self.eng_n, self.eng_ab, self.eng_abT = np.full(B, ENG['idleN']), z(), z()
        # FCS 상태
        self.nzI, self.nzF, self.alphaDot, self.prevAlpha, self.qDot, self.prevQ = z(), np.ones(B), z(), z(), z(), z()
        # 출력
        self.alpha, self.beta, self.V, self.M, self.qbar = z(), z(), z(), z(), z()
        self.theta, self.phi, self.nz, self.agl, self.thrust, self.drag = z(), z(), np.ones(B), z(), z(), z()
        self.time = z()
        self.crashed = np.zeros(B, dtype=bool)
        self.overstress = np.zeros(B, dtype=bool)

    def reset(self, idx, pos, heading_deg, speed, throttle, pitch_deg=0.0):
        """idx: 인덱스 배열. heading 0 = 북(-Z)"""
        pitch = np.asarray(pitch_deg, dtype=float) * D2R * np.ones(len(idx))
        yaw = -np.asarray(heading_deg, dtype=float) * D2R * np.ones(len(idx))
        q = quat_from_euler_yxz(pitch, yaw)
        self.pos[idx] = pos
        self.quat[idx] = q
        v = np.zeros((len(idx), 3)); v[:, 2] = -np.asarray(speed, dtype=float)
        self.vel[idx] = qrot(q, v)
        self.omega[idx] = 0
        self.sb_cmd[idx] = False; self.sb_pos[idx] = 0
        thr = np.asarray(throttle, dtype=float) * np.ones(len(idx))
        self.c_thr[idx] = thr; self.c_pitch[idx] = 0; self.c_roll[idx] = 0; self.c_yaw[idx] = 0
        self.eng_n[idx] = np.where(thr > 0, ENG['idleN'] + (1 - ENG['idleN']) * np.minimum(thr / 0.8, 1), ENG['idleN'])
        self.eng_ab[idx] = 0; self.eng_abT[idx] = 0
        self.nzI[idx] = 0; self.nzF[idx] = 1
        self.de[idx] = 0; self.da[idx] = 0; self.dr[idx] = 0
        self.crashed[idx] = False; self.overstress[idx] = False
        self.time[idx] = 0
        self.nz[idx] = 1

    # ------------------------------------------------------------ 한 적분 단계 (dt = 1/240)
    def step(self, dt):
        alive = ~self.crashed
        m = MASS_EMPTY + MASS_CREW + self.fuel + self.ammo * ROUND_MASS
        k = 0.55 + 0.45 * (m / INERTIA_REF['mass'])
        Ixx, Iyy, Izz, Ixz = INERTIA_REF['Ixx'] * k, INERTIA_REF['Iyy'] * k, INERTIA_REF['Izz'] * k, INERTIA_REF['Ixz'] * k
        self.time += dt

        Tk, p_atm, rho, a_snd, sigma = isa(self.pos[:, 1])
        qi = qconj(self.quat)
        vb = local_to_aero(qrot(qi, self.vel))
        V = norm(vb)
        Vs = np.maximum(V, 1e-6)
        alpha = np.where(V > 0.5, np.arctan2(vb[:, 2], vb[:, 0]), 0.0)
        beta = np.where(V > 0.5, np.arcsin(np.clip(vb[:, 1] / Vs, -1, 1)), 0.0)
        qbar = 0.5 * rho * V * V
        M = V / a_snd
        agl = self.pos[:, 1] - 0.0 - 2.1
        fwd = qrot(self.quat, np.broadcast_to(np.array([0, 0, -1.0]), (self.B, 3)))
        theta = np.arcsin(np.clip(fwd[:, 1], -1, 1))
        side = qrot(self.quat, np.broadcast_to(np.array([1.0, 0, 0]), (self.B, 3)))
        upB = qrot(self.quat, np.broadcast_to(np.array([0, 1.0, 0]), (self.B, 3)))
        phi = np.arctan2(-side[:, 1], upB[:, 1])
        self.alpha, self.beta, self.V, self.M, self.qbar, self.theta, self.phi, self.agl = alpha, beta, V, M, qbar, theta, phi, agl

        sb_target = np.where(self.sb_cmd & (alpha < 25 * D2R), 1.0, 0.0)
        self.sb_pos = move_toward(self.sb_pos, sb_target, dt / 2)

        Vd = np.maximum(V, 15)
        w = self.omega
        phat = w[:, 0] * B_SPAN / (2 * Vd)
        qhat = w[:, 1] * C_MAC / (2 * Vd)
        rhat = w[:, 2] * B_SPAN / (2 * Vd)
        A = aero_coeffs(alpha, beta, M, phat, qhat, rhat, self.sb_pos, agl, self.time)

        # ---- FCS (G 명령 CAS, NDI) — AI 기체 경로
        de_c, da_c, dr_c = self._fcs(dt, m, Ixx, Iyy, Izz, Ixz, A, alpha, beta, theta, phi, V, M, qbar)
        self.de = move_toward(self.de, np.clip(de_c, -DE_DOWN, DE_UP), DE_RATE * dt)
        self.da = move_toward(self.da, np.clip(da_c, -DA_MAX, DA_MAX), DA_RATE * dt)
        self.dr = move_toward(self.dr, np.clip(dr_c, -DR_MAX, DR_MAX), DR_RATE * dt)
        de, da, dr = self.de, self.da, self.dr

        CL = A['CL'] + A['CLde'] * de
        CD = A['CD'] + A['CDde'] * de * de + 0.02 * (da * da + dr * dr)
        CY = A['CY'] + A['CYdr'] * dr
        Cl = A['Cl'] + A['Clda'] * da + A['Cldr'] * dr
        Cm = A['Cm'] + A['Cmde'] * de
        Cn = A['Cn'] + A['Cnda'] * da + A['Cndr'] * dr

        ux, uy, uz = vb[:, 0] / Vs, vb[:, 1] / Vs, vb[:, 2] / Vs
        lx, lz = uz, -ux
        ln = np.hypot(lx, lz); ln = np.where(ln > 0, ln, 1.0)
        lx, lz = lx / ln, lz / ln
        qS = qbar * S
        Lf, Df, Yf = CL * qS, CD * qS, CY * qS
        on = V > 0.5
        Fb = np.zeros((self.B, 3)); Mb = np.zeros((self.B, 3))
        Fb[:, 0] = np.where(on, -Df * ux + Lf * lx, 0)
        Fb[:, 1] = np.where(on, -Df * uy + Yf, 0)
        Fb[:, 2] = np.where(on, -Df * uz + Lf * lz, 0)
        Mb[:, 0] = np.where(on, Cl * qS * B_SPAN, 0)
        Mb[:, 1] = np.where(on, Cm * qS * C_MAC, 0)
        Mb[:, 2] = np.where(on, Cn * qS * B_SPAN, 0)
        self.drag = np.where(on, Df, 0)

        # ---- 엔진
        T1 = self._engine(dt, self.c_thr, Tk, p_atm, sigma, M)
        thrust = 2 * T1 * self.thrust_mul
        Fb[:, 0] += thrust
        self.thrust = thrust

        nz = -Fb[:, 2] / (m * G0)
        self.nz = nz
        self.overstress |= (nz > NZ_STRUCT) | (nz < NZ_STRUCT_NEG)

        Fw = qrot(self.quat, aero_to_local(Fb))
        acc = Fw / m[:, None]
        acc[:, 1] -= G0
        al = alive[:, None]
        self.vel = np.where(al, self.vel + acc * dt, self.vel)
        self.pos = np.where(al, self.pos + self.vel * dt, self.pos)

        Ip = Ixx * w[:, 0] - Ixz * w[:, 2]
        Iq = Iyy * w[:, 1]
        Ir = Izz * w[:, 2] - Ixz * w[:, 0]
        rx = Mb[:, 0] - (w[:, 1] * Ir - w[:, 2] * Iq)
        ry = Mb[:, 1] - (w[:, 2] * Ip - w[:, 0] * Ir)
        rz = Mb[:, 2] - (w[:, 0] * Iq - w[:, 1] * Ip)
        det = Ixx * Izz - Ixz * Ixz
        pd = (Izz * rx + Ixz * rz) / det
        rd = (Ixz * rx + Ixx * rz) / det
        qd = ry / Iyy
        wn = w + np.stack([pd, qd, rd], axis=-1) * dt
        wl = norm(wn)
        wn = np.where((wl > 12)[:, None], wn * (12 / np.maximum(wl, 1e-9))[:, None], wn)
        self.omega = np.where(al, wn, w)

        wloc = aero_to_local(self.omega)
        ang = norm(wloc) * dt
        axis = wloc / np.maximum(norm(wloc), 1e-12)[:, None]
        h = ang / 2
        dq = np.concatenate([axis * np.sin(h)[:, None], np.cos(h)[:, None]], axis=-1)
        qn = qmul(self.quat, dq)
        qn = qn / norm(qn)[:, None]
        self.quat = np.where((al & (ang > 1e-9)[:, None]), qn, self.quat)

        # 지면 충돌 (평지, 동체 하부 여유 ~2 m)
        self.crashed |= self.pos[:, 1] < 2.0

    def _engine(self, dt, throttle, Tk, p_atm, sigma, M):
        idleN = ENG['idleN']
        dry = np.clip(throttle / 0.8, 0, 1)
        nCmd = idleN + (1 - idleN) * dry
        up = nCmd > self.eng_n
        maxRate = np.where(up, np.where(self.eng_n < 0.85, 0.11, 0.17), 0.3)
        self.eng_n = self.eng_n + np.clip((nCmd - self.eng_n) * np.where(up, 1.6, 2.2), -maxRate, maxRate) * dt
        wantAB = (throttle > 0.802) & (self.eng_n > 0.965)
        self.eng_abT = np.where(wantAB, self.eng_abT + dt, 0.0)
        abCmd = 0.12 + 0.88 * np.clip((throttle - 0.8) / 0.2, 0, 1)
        ab_on = move_toward(self.eng_ab, abCmd, 1.1 * dt)
        self.eng_ab = np.where(wantAB, np.where(self.eng_abT > 0.4, ab_on, self.eng_ab), move_toward(self.eng_ab, 0.0, 3 * dt))
        lapse = np.power(sigma, 0.8)
        fMil = np.maximum(0.2, 1 + 0.1 * M - 0.2 * M * M)
        fAB = 1 + 0.2 * M + 0.08 * M * M
        t2 = Tk * (1 + 0.2 * M * M)
        lim = np.where(t2 > 470, np.maximum(0, 1 - (t2 - 470) / 55), 1.0)
        ptRatio = (p_atm + impact_pressure(M, p_atm)) / P0
        lim = np.where(ptRatio > 2.2, lim / (1 + ((ptRatio - 2.2) / 0.5) ** 2), lim)
        nf = np.clip((self.eng_n - idleN) / (1 - idleN), 0, 1)
        dryT = np.where(self.eng_n < idleN * 0.9, 0.0, ENG['milSL'] * lapse * fMil * (0.05 + 0.95 * np.power(nf, 1.7)) * lim)
        abT = np.maximum(0, ENG['abSL'] * fAB - ENG['milSL'] * fMil) * lapse * self.eng_ab * lim
        return dryT + abT

    def _fcs(self, dt, m, Ixx, Iyy, Izz, Ixz, A, alpha, beta, theta, phi, V_true, M, qbar):
        self.alphaDot = self.alphaDot + ((alpha - self.prevAlpha) / dt - self.alphaDot) * min(1.0, dt / 0.04)
        self.prevAlpha = alpha.copy()
        W = m * G0
        V = np.maximum(V_true, 40)
        nzMax = np.where(m < 23000, NZ_MAX, NZ_MAX + (7.33 - NZ_MAX) * np.clip((m - 23000) / 7000, 0, 1)) + self.nz_bonus
        nzMin = NZ_MIN
        p = self.c_pitch
        nzRaw = np.where(p >= 0, 1 + p * (nzMax - 1), 1 + p * (1 - nzMin))
        self.nzF = self.nzF + (nzRaw - self.nzF) * min(1.0, dt / 0.22)
        nzCmd = self.nzF
        qS = np.maximum(qbar * S, 1)
        aCmd = alpha_for_cl(nzCmd * W / qS, M, ALPHA_CAS_NEG, ALPHA_CAS) + self.nzI
        aCl = np.clip(aCmd, ALPHA_CAS_NEG, ALPHA_CAS)
        alphaLimited = (aCl != aCmd) | (aCmd >= ALPHA_CAS - 1e-4)
        aCmd = aCl
        nzAch = cl_basic(aCmd, M) * qS / W
        nzFF = np.clip(np.minimum(nzCmd, nzAch), nzMin, nzMax)
        qFF = G0 * (nzFF - np.cos(theta) * np.cos(phi)) / V
        over = np.maximum(0, self.nz - nzMax) - np.maximum(0, nzMin - self.nz)
        aPred = alpha + 0.2 * self.alphaDot
        qCmd = qFF + 2.8 * (aCmd - aPred) - 1.5 * G0 * over / V

        aEff = np.clip(alpha, -0.3, 0.6)
        pMax = 4.0 * np.clip(1 - 1.4 * np.maximum(0, alpha - 0.25), 0.3, 1)
        ps = self.c_roll * pMax
        betaCmd = -self.c_yaw * 0.12
        pCmd = ps * np.cos(aEff)
        rCmd = ps * np.sin(aEff) + G0 * np.sin(phi) * np.cos(theta) / V + 2.5 * (beta - betaCmd)
        w = self.omega
        pd = 7 * (pCmd - w[:, 0]); rd = 4 * (rCmd - w[:, 2])
        self.qDot = self.qDot + ((w[:, 1] - self.prevQ) / dt - self.qDot) * min(1.0, dt / 0.03)
        self.prevQ = w[:, 1].copy()
        qd = 11 * (qCmd - w[:, 1])
        Ip = Ixx * w[:, 0] - Ixz * w[:, 2]; Iq = Iyy * w[:, 1]; Ir = Izz * w[:, 2] - Ixz * w[:, 0]
        Mx = Ixx * pd - Ixz * rd + (w[:, 1] * Ir - w[:, 2] * Iq)
        My = Iyy * qd + (w[:, 2] * Ip - w[:, 0] * Ir)
        Mz = Izz * rd - Ixz * pd + (w[:, 0] * Iq - w[:, 1] * Ip)
        qSc, qSb = qS * C_MAC, qS * B_SPAN
        de = (My / qSc - A['Cm']) / A['Cmde']
        ClReq = Mx / qSb - A['Cl']; CnReq = Mz / qSb - A['Cn']
        det = A['Clda'] * A['Cndr'] - A['Cldr'] * A['Cnda']
        da = (ClReq * A['Cndr'] - A['Cldr'] * CnReq) / det
        dr = (A['Clda'] * CnReq - A['Cnda'] * ClReq) / det
        de = np.clip(de, -DE_DOWN, DE_UP); da = np.clip(da, -DA_MAX, DA_MAX); dr = np.clip(dr, -DR_MAX, DR_MAX)
        sat = alphaLimited | (de >= DE_UP - 1e-3) | (de <= -DE_DOWN + 1e-3)
        nzErr = nzCmd - self.nz
        upd = (~sat) & (np.abs(nzErr) < 1.2)
        self.nzI = np.where(upd, np.clip(self.nzI + nzErr * 0.02 * dt, -0.02, 0.02), self.nzI)
        return de, da, dr
