"""1:1 기총 공중전 강화학습 환경 (벡터화).

N개의 공중전을 동시에 진행한다. 기체 인덱스 j < N 은 청군, j >= N 은 적군이며 상대는 (j + N) % 2N.
물리 240 Hz (sim.Fleet, JS와 동일), 저수준 조종 60 Hz (src/ai.js의 flyLiftP / trackNose 이식),
정책 결정 10 Hz.

행동 (기체당 5차원, [-1, 1]):
  a0, a1 : 양력벡터 방향 각 = atan2(a1, a0), 기준(0) = 상대 쪽 (속도에 수직인 상대 시선 성분)
  a2     : G 명령  -1 → -1 G, +1 → 최대 G
  a3     : 스로틀  -1 → 아이들(+ -0.8 미만이면 스피드브레이크), +1 → 최대 A/B
  a4     : > 0 이면 기총 추적 모드 (사거리·리드 오차 안일 때만 trackNose로 조준 → 사격은 자동)
"""
import numpy as np
from sim import FUEL_INT
from sim import Fleet, qrot, qconj, local_to_aero, aero_to_local, norm, isa, D2R, R2D, G0, NZ_MAX, cl_basic, S, MASS_EMPTY, MASS_CREW, ROUND_MASS

PH = 1 / 240
CTRL_DT = 1 / 60
SUB = 4            # 제어 1틱당 물리 단계
DECIDE = 6         # 결정 1회당 제어 틱 (10 Hz)
GUN = dict(rate=100.0, muzzle=1050.0, spinUp=0.4, disp=0.0028, life=2.4, k=0.00026)
PK = 72            # 기체당 탄 묶음 수 (1/30초마다 하나 → 2.4초)
HIT_AXES = np.array([9.7, 6.5, 2.0])   # 피탄 타원체 반축 (공력 기체축 x 기수, y 날개, z 상하) — src/weapons.js와 동일
OBS_DIM = 45
ACT_DIM = 5
LEGEND_PERF = (1.15, 1.0)
TRACK_KD = 0.7
_HUMAN = None      # 사람 모방 봇 (지연 로드)
import os as _os
AIM_SETTLE = float(_os.environ.get('AIM_SETTLE', '0.3'))   # 사격 전 조준 유지 시간 (s): 조준점이 표적 위에 이만큼 머물러야 발사


def unit(v):
    return v / np.maximum(norm(v), 1e-9)[..., None]


def dot(a, b):
    return np.sum(a * b, axis=-1)


def cross(a, b):
    return np.cross(a, b)


def body_axes(q):
    B = q.shape[0]
    fwd = qrot(q, np.broadcast_to(np.array([0, 0, -1.0]), (B, 3)))
    up = qrot(q, np.broadcast_to(np.array([0, 1.0, 0]), (B, 3)))
    right = qrot(q, np.broadcast_to(np.array([1.0, 0, 0]), (B, 3)))
    return fwd, up, right


class DuelEnv:
    def __init__(self, N, seed=0, max_t=90.0, legend_prob=0.5):
        self.N, self.B = N, 2 * N
        self.rng = np.random.default_rng(seed)
        self.f = Fleet(self.B)
        self.max_t = max_t
        self.legend_prob = legend_prob
        B = self.B
        self.opp = (np.arange(B) + N) % B
        self.hp = np.full(B, 100.0)
        self.t = np.zeros(N)
        # 저수준 조종 상태
        self.rollSign = np.ones(B)
        self.cmd_l = np.zeros((B, 3)); self.cmd_l[:, 1] = 1
        self.cmd_n = np.ones(B)
        self.cmd_thr = np.full(B, 0.85)
        self.cmd_sb = np.zeros(B, dtype=bool)
        self.cmd_track = np.zeros(B, dtype=bool)
        self.tracking = np.zeros(B, dtype=bool)
        self.aimPrev = np.zeros((B, 3)); self.aimRate = np.zeros((B, 3))
        self.thPrev = np.zeros(B); self.thD = np.zeros(B); self.yawCmd = np.zeros(B)
        self.tAcc = np.zeros((B, 3))
        # 기관포
        self.spin = np.zeros(B); self.trigger = np.zeros(B, dtype=bool); self.roundAcc = np.zeros(B)
        self.pk_p = np.zeros((B, PK, 3)); self.pk_v = np.zeros((B, PK, 3)); self.pk_n = np.zeros((B, PK))
        self.pk_age = np.zeros((B, PK)); self.pk_on = np.zeros((B, PK), dtype=bool); self.pk_i = np.zeros(B, dtype=int)
        self.tick = 0
        self.scripted = np.zeros(B, dtype=int)   # 0 = 정책, 1 = 사람식 추적 봇, 2 = 수평 선회 봇
        self.dmg_dealt = np.zeros(B); self.dmg_taken = np.zeros(B)
        self.midair = np.zeros(B, dtype=bool)
        self.recover = np.zeros(B, dtype=bool); self.trigger_block = np.zeros(B, dtype=bool); self.aim_t = np.zeros(B)
        self.dodger = np.zeros(B, dtype=bool); self.dodge_sgn = np.ones(B)
        self.prev_pot = np.zeros(B)
        # 커리큘럼 시나리오 (train2.py): None이면 기존 무작위 시작. 확률 벡터면 판마다 시나리오를 뽑고 시나리오별 시간 제한 적용
        self.scen_probs = None
        self.scen = np.zeros(N, dtype=int)
        self.tmax = np.full(N, float(max_t))
        self.off_gain = np.zeros(B, dtype=bool)      # 이번 판에 공세 위치(ATA<45°, AA<60°, 1.5 km 이내)를 잡은 적이 있나
        self.flip_t = np.zeros(B)                    # 수세 봇(5)의 재킹 방향 전환 타이머
        self.perf_fix = None                         # (추력 배수, G 보정) 고정 — 평가용(게임 조건 재현), None이면 무작위
        self.reset_all()

    # ------------------------------------------------------------ 초기 상태
    def reset_all(self):
        self._reset(np.arange(self.N))

    def _reset(self, envs):
        n = len(envs)
        if n == 0:
            return
        rng = self.rng
        f = self.f
        a, b = envs, envs + self.N
        # 시작 고도·속도·자세 다양화: 40%는 저고도(0.9~3 km), 30%는 저속(100~170 m/s) — 긴 저고도·저에너지 싸움을 겪게 함
        alt = np.where(rng.random(n) < 0.4, rng.uniform(900, 3000, n), rng.uniform(3000, 9000 if self.scen_probs is not None else 7000, n))
        kind = rng.choice(4, n, p=[0.35, 0.25, 0.2, 0.2])   # 머지 / 중립 / 청군 공세 / 청군 수세
        if self.scen_probs is not None:
            # 시나리오: 0 전체 교전(무작위 시작, 긴 시간) / 1 공세 마무리 / 2 수세 탈출 / 3 정면 머지 / 4 저고도·저에너지
            sc = rng.choice(len(self.scen_probs), n, p=self.scen_probs)
            self.scen[envs] = sc
            kind = np.select([sc == 1, sc == 2, sc == 3, sc == 4], [2, 3, 0, 1], kind)
            alt = np.where(sc == 4, np.where(rng.random(n) < 0.5, rng.uniform(400, 1200, n), rng.uniform(1200, 2500, n)), alt)   # 저고도: 절반은 1.2 km 아래에서 시작
            self.tmax[envs] = np.select([sc == 1, sc == 2], [60.0, 60.0], np.where(sc == 0, self.max_t, 150.0))
        else:
            self.tmax[envs] = self.max_t
        pa = np.zeros((n, 3)); pb = np.zeros((n, 3))
        ha = rng.uniform(0, 360, n); hb = np.zeros(n)
        spd = lambda: np.where(rng.random(n) < 0.3, rng.uniform(100, 170, n), rng.uniform(170, 270, n))
        sa = spd(); sb = spd()
        if self.scen_probs is not None:
            low = self.scen[envs] == 4
            sa = np.where(low, rng.uniform(100, 160, n), sa); sb = np.where(low, rng.uniform(100, 160, n), sb)
        pit = rng.uniform(-10, 10, 2 * n)
        for i in range(n):
            h = np.radians(ha[i]); fwd = np.array([np.sin(h), 0, -np.cos(h)]); rt = np.array([np.cos(h), 0, np.sin(h)])
            pa[i] = [0, alt[i], 0]
            k = kind[i]
            if k == 0:   # 정면 머지
                d = rng.uniform(4000, 8000); off = rng.choice([-1, 1]) * rng.uniform(150, 900)
                pb[i] = pa[i] + fwd * d + rt * off + np.array([0, rng.uniform(-500, 500), 0]); hb[i] = ha[i] + 180
            elif k == 1:  # 중립: 임의 위치·방향
                d = rng.uniform(1500, 4000); ang = rng.uniform(0, 2 * np.pi)
                pb[i] = pa[i] + d * (np.cos(ang) * fwd + np.sin(ang) * rt) + np.array([0, rng.uniform(-800, 800), 0]); hb[i] = rng.uniform(0, 360)
            else:         # 한쪽이 뒤
                d = rng.uniform(400, 1800); asp = rng.uniform(-60, 60); dh = rng.uniform(-45, 45)
                ang = np.radians(asp)
                rel = d * (np.cos(ang) * fwd + np.sin(ang) * rt)
                if k == 2:   # 청군(a)이 뒤 → b는 a 앞
                    pb[i] = pa[i] + rel; hb[i] = ha[i] + dh
                else:
                    pb[i] = pa[i] - rel; hb[i] = ha[i] + dh
                pb[i, 1] += rng.uniform(-300, 300)
        idx = np.concatenate([a, b])
        f.reset(idx, np.concatenate([pa, pb]), np.concatenate([ha, hb]), np.concatenate([sa, sb]), 0.85, pit)
        leg = (rng.random(2 * n) < self.legend_prob) & (self.scripted[idx] != 4)   # 사람 봇은 플레이어처럼 성능 보정 없음
        f.thrust_mul[idx] = np.where(leg, LEGEND_PERF[0], 1.0)
        f.nz_bonus[idx] = np.where(leg, LEGEND_PERF[1], 0.0)
        if self.scen_probs is not None:
            # 환경 무작위화 (train2 자가 대결): 양쪽 기체 성능을 따로 0(사람 플레이어와 같음)~1(전설 보정) 사이로 —
            #  30%는 보정 없음, 30%는 전설 보정, 나머지는 중간 — 그리고 연료(무게) 35~100%
            p = rng.random(2 * n)
            p = np.where(p < 0.3, 0.0, np.where(p > 0.7, 1.0, (p - 0.3) / 0.4))
            f.thrust_mul[idx] = 1 + (LEGEND_PERF[0] - 1) * p
            f.nz_bonus[idx] = LEGEND_PERF[1] * p
            f.fuel[idx] = FUEL_INT * rng.uniform(0.35, 1.0, 2 * n)
            if self.perf_fix is not None:
                f.thrust_mul[idx] = self.perf_fix[0]; f.nz_bonus[idx] = self.perf_fix[1]; f.fuel[idx] = FUEL_INT
        self.hp[idx] = 100.0
        self.t[envs] = 0
        self.rollSign[idx] = 1
        self.cmd_l[idx] = [0, 1, 0]; self.cmd_n[idx] = 1; self.cmd_thr[idx] = 0.85; self.cmd_sb[idx] = False; self.cmd_track[idx] = False
        self.tracking[idx] = False
        self.spin[idx] = 0; self.trigger[idx] = False; self.aim_t[idx] = 0; self.roundAcc[idx] = 0
        self.pk_on[idx] = False
        self.dmg_dealt[idx] = 0; self.dmg_taken[idx] = 0
        self.midair[idx] = False; self.recover[idx] = False
        self.off_gain[idx] = False; self.flip_t[idx] = rng.uniform(1.0, 2.5, 2 * n)
        self.dodger[idx] = rng.random(2 * n) < 0.7; self.dodge_sgn[idx] = np.where(rng.random(2 * n) < 0.5, 1.0, -1.0)
        self.prev_pot[idx] = self._potential()[idx]

    # ------------------------------------------------------------ 기하
    def geometry(self):
        f = self.f
        o = self.opp
        r = f.pos[o] - f.pos
        R = norm(r)
        los = r / np.maximum(R, 1e-6)[:, None]
        u = unit(f.vel)
        uo = unit(f.vel[o])
        ata = np.arccos(np.clip(dot(u, los), -1, 1))
        aa = np.arccos(np.clip(dot(uo, los), -1, 1))       # 상대 꼬리에서 본 각 (0 = 정확히 뒤)
        Vc = -dot(f.vel[o] - f.vel, los)
        return r, R, los, u, ata, aa, Vc

    def target_acc(self):
        f = self.f
        _, up, _ = body_axes(f.quat)
        acc = up * (np.maximum(f.nz, -3) * G0)[:, None]
        acc[:, 1] -= G0
        return acc[self.opp]

    def gun_lead(self, predict=1.0):
        """weapons.js gunLead — 기수 방향(단위벡터), 비행시간"""
        f = self.f; o = self.opp
        _, _, rho, _, _ = isa(f.pos[:, 1])
        c = GUN['k'] * (rho / 1.225)
        muzzle = f.pos
        tp0, tv = f.pos[o], f.vel[o]
        ta = self.target_acc()
        u = unit(tp0 - muzzle)
        M = GUN['muzzle']; V2 = dot(f.vel, f.vel)
        tof = np.full(self.B, 0.5); v0 = np.full(self.B, M)
        for _ in range(5):
            ud = dot(u, f.vel)
            v0 = ud + np.sqrt(np.maximum(1, ud * ud - V2 + M * M))
            tp = tp0 + tv * tof[:, None] + ta * (0.5 * tof * tof * predict)[:, None]
            tp[:, 1] += 0.5 * G0 * tof * tof
            Vr = tp - muzzle
            D = norm(Vr)
            u = Vr / np.maximum(D, 1)[:, None]
            tof = (np.exp(np.minimum(c * D, 20)) - 1) / (c * v0)
        d = u * v0[:, None] - f.vel
        return unit(d), tof

    # ------------------------------------------------------------ 저수준 조종 (ai.js 이식)
    def fly_lift(self, l, n, fine):
        f = self.f
        lb = local_to_aero(qrot(qconj(f.quat), l))
        al = np.clip(f.alpha, -0.3, 0.6); ca, sa = np.cos(al), np.sin(al)
        zs = -lb[:, 0] * sa + lb[:, 2] * ca
        clock = np.arctan2(lb[:, 1], -zs)
        nC = n.copy()
        flip = (np.abs(clock) > 1.95) & (n < 1.6)
        clock = np.where(flip, clock - np.sign(clock) * np.pi, clock)
        nC = np.where(flip, -n, nC)
        keep = (~flip) & (np.abs(clock) > 2.9)
        clock = np.where(keep, self.rollSign * np.abs(clock), clock)
        sg = np.sign(clock); self.rollSign = np.where(sg == 0, 1.0, sg)
        acl = np.abs(clock)
        ul = np.where(fine, 1.3, 0.5)
        red = (acl > ul) & (nC > 1)
        nC = np.where(red, 1 + (nC - 1) * np.clip((1.4 - acl) / (1.4 - ul + 0.001), 0.15, 1), nC)
        pEff = 4.0 * np.clip(1 - 1.4 * np.maximum(0, f.alpha - 0.25), 0.3, 1)
        roll = np.clip(np.where(fine, 3.0, 4.5) * clock / pEff - np.where(fine, 0.08, 0) * f.omega[:, 0], -1, 1)
        nzMax = NZ_MAX + f.nz_bonus
        pitch = np.where(nC >= 1, (nC - 1) / (nzMax - 1), (nC - 1) / 4)
        pitch = np.clip(pitch, -0.6, 1.0)
        return pitch, roll

    def track_nose(self, aim, dt, mask):
        """ai.js trackNose (기수 직접 지향 법칙) — 조준점을 양력면에 두도록 롤, 받음각 목표 α* = θ + K_D·θ̇ 를
        CL 표로 G 명령으로 바꿔 줌(FCS가 정확히 역산), 오차 2° 이내면 러더로 좌우 미세 수정. mask인 기체만 상태 갱신.
        반환: pitch, roll, yaw"""
        f = self.f
        u = unit(f.vel)
        fresh = mask & ~self.tracking
        ap = aim - u * dot(aim, u)[:, None]; apn = norm(ap)
        lU = np.where((apn > 1e-4)[:, None], ap / np.maximum(apn, 1e-9)[:, None], np.array([0, 1.0, 0]))
        th = np.arctan2(apn, dot(aim, u))
        d = np.clip((th - self.thPrev) / dt, -1, 1)
        thD = np.where(fresh, 0.0, self.thD + (d - self.thD) * min(1.0, dt / 0.1))
        self.thD = np.where(mask, thD, self.thD)
        self.thPrev = np.where(mask, th, self.thPrev)
        aC = np.clip(th + TRACK_KD * thD, -0.2, 30 * D2R)
        m = MASS_EMPTY + MASS_CREW + f.fuel + f.ammo * ROUND_MASS
        n = f.qbar * S * cl_basic(aC, f.M) / (m * G0)
        pitch, roll = self.fly_lift(lU, n, np.ones(self.B, dtype=bool))
        fwd, _, _ = body_axes(f.quat)
        err = np.arccos(np.clip(dot(fwd, aim), -1, 1))
        ab = local_to_aero(qrot(qconj(f.quat), aim))
        yaw = np.where(err < 2 * D2R, np.clip(np.arctan2(ab[:, 1], ab[:, 0]) * 12, -1, 1), 0.0)
        return pitch, roll, yaw

    # ------------------------------------------------------------ 행동 → 명령
    def apply_actions(self, act):
        """act: (B, 5). scripted 기체는 무시하고 봇 명령으로 덮어씀"""
        f = self.f
        r, R, los, u, ata, aa, Vc = self.geometry()
        ref = los - u * dot(los, u)[:, None]
        refn = norm(ref)
        upP = np.array([0, 1.0, 0]) - u * u[:, 1:2]
        ref = np.where((refn > 0.05)[:, None], ref / np.maximum(refn, 1e-9)[:, None], unit(upP))
        side = cross(u, ref)      # 속도 기준 오른쪽(상대 쪽 기준)
        ang = np.arctan2(act[:, 1], act[:, 0])
        l = ref * np.cos(ang)[:, None] + side * np.sin(ang)[:, None]
        # 저고도 하한 (규칙 기반 AI와 같음): 1500 m 아래에선 양력벡터의 아래 성분을 줄이고 600 m 아래에선 아래로 당기지 않음
        #  (저속에서 뒤집힌 채 아래로 당기면 롤로 되돌리는 데 2초 가까이 걸려 지형 회복이 늦음)
        low = (f.agl < 1500) & (l[:, 1] < 0)
        l[:, 1] = np.where(low, l[:, 1] * np.maximum(0, (f.agl - 600) / 900), l[:, 1])
        ln = norm(l)
        l = np.where((ln > 1e-3)[:, None], l / np.maximum(ln, 1e-9)[:, None], unit(upP))
        nzMax = NZ_MAX + f.nz_bonus
        n = -1 + (np.clip(act[:, 2], -1, 1) + 1) / 2 * (nzMax + 1)
        thr = (np.clip(act[:, 3], -1, 1) + 1) / 2
        self.cmd_l, self.cmd_n, self.cmd_thr = l, n, thr
        self.cmd_sb = act[:, 3] < -0.8
        self.cmd_track = act[:, 4] > 0
        if (self.scripted == 4).any():   # 4: 사람 모방 봇 (사람 대결 기록으로 모방 학습한 행동)
            self._human_act(act, l, n, thr)
        if (self.scripted > 0).any():
            self._scripted(r, R, los, u, ata, aa, Vc)

    def _human_act(self, act, l, n, thr):
        global _HUMAN
        if _HUMAN is None:
            from humanbot import HumanBot
            _HUMAN = HumanBot()
        idx = np.where(self.scripted == 4)[0]
        a = act.copy(); a[idx] = _HUMAN.act(self, idx)
        r, R, los, u, ata, aa, Vc = self.geometry()
        ref = los - u * dot(los, u)[:, None]; refn = norm(ref)
        upP = np.array([0, 1.0, 0]) - u * u[:, 1:2]
        ref = np.where((refn > 0.05)[:, None], ref / np.maximum(refn, 1e-9)[:, None], unit(upP))
        side = cross(u, ref)
        ang = np.arctan2(a[idx, 1], a[idx, 0])
        self.cmd_l[idx] = ref[idx] * np.cos(ang)[:, None] + side[idx] * np.sin(ang)[:, None]
        nzMax = NZ_MAX + self.f.nz_bonus[idx]
        self.cmd_n[idx] = -1 + (a[idx, 2] + 1) / 2 * (nzMax + 1)
        self.cmd_thr[idx] = (a[idx, 3] + 1) / 2
        self.cmd_sb[idx] = a[idx, 3] < -0.8
        self.cmd_track[idx] = a[idx, 4] > 0

    def _scripted(self, r, R, los, u, ata, aa, Vc):
        f = self.f; o = self.opp
        m1 = self.scripted == 1
        m2 = self.scripted == 2
        # 1: 사람식 — 상대 리드점(1.2초) 쪽 최대 G, 가까우면 기총 추적
        lead = f.pos[o] + f.vel[o] * 1.2 - f.pos
        lead = unit(lead)
        l1 = unit(lead - u * dot(lead, u)[:, None] + 1e-6)
        self.cmd_l = np.where(m1[:, None], l1, self.cmd_l)
        self.cmd_n = np.where(m1, 99.0, self.cmd_n)
        self.cmd_thr = np.where(m1, 1.0, self.cmd_thr)
        self.cmd_sb = np.where(m1, False, self.cmd_sb)
        self.cmd_track = np.where(m1, True, self.cmd_track)
        # 2: 수평 최대 선회 반복 (상대 쪽 방향)
        upP = unit(np.array([0, 1.0, 0]) - u * u[:, 1:2])
        rt = unit(cross(u, upP))
        sgn = np.where(dot(rt, los) >= 0, 1.0, -1.0)
        cphi = np.cos(np.radians(80))
        l2 = unit(upP * cphi + rt * (np.sqrt(1 - cphi ** 2) * sgn)[:, None])
        self.cmd_l = np.where(m2[:, None], l2, self.cmd_l)
        self.cmd_n = np.where(m2, 99.0, self.cmd_n)
        self.cmd_thr = np.where(m2, 1.0, self.cmd_thr)
        self.cmd_sb = np.where(m2, False, self.cmd_sb)
        self.cmd_track = np.where(m2, False, self.cmd_track)
        # 3: 수직 활용(에너지형) — 추적면을 위로 45° 기울여 최대 G (경사 루프·하이 요요로 각도를 고도로 바꿈), 1 km 안에서는 기총 추적
        m3 = self.scripted == 3
        l3 = unit(l1 + upP * np.where(R > 1000, 1.0, 0.0)[:, None])
        self.cmd_l = np.where(m3[:, None], l3, self.cmd_l)
        self.cmd_n = np.where(m3, 99.0, self.cmd_n)
        self.cmd_thr = np.where(m3, 1.0, self.cmd_thr)
        self.cmd_sb = np.where(m3, False, self.cmd_sb)
        self.cmd_track = np.where(m3, R < 1200, self.cmd_track)
        # 정면 사격 회피 (봇 1·3의 약 70%): 상대가 내게 사격 해(리드 오차 6°, 2 km)를 잡으면 기동면 밖으로 최대 G 이탈
        m13 = (m1 | m3) & self.dodger
        if m13.any():
            aim, _ = self.gun_lead(1.0)
            fwd, _, _ = body_axes(f.quat)
            le = np.arccos(np.clip(dot(fwd, aim), -1, 1))
            threat = m13 & (le[o] < 6 * D2R) & (R < 2000)
            if threat.any():
                ref = los - u * dot(los, u)[:, None]
                ref = np.where((norm(ref) > 0.05)[:, None], unit(ref + 1e-12), upP)
                ld = unit(cross(u, ref) * self.dodge_sgn[:, None] + upP * 0.3)
                self.cmd_l = np.where(threat[:, None], ld, self.cmd_l)
                self.cmd_n = np.where(threat, 99.0, self.cmd_n)
                self.cmd_track = np.where(threat, False, self.cmd_track)
        # 6: 하강 유도 봇 — 상대 쪽 최대 G 선회를 하되 양력벡터를 아래로 기울여 저고도(약 400 m)까지 끌고 내려간 뒤 거기서 싸움 (사람 대결 기록의 패턴)
        m6 = self.scripted == 6
        if m6.any():
            dn = np.clip((f.agl - 400) / 600, 0, 1)
            l6 = unit(l1 - upP * (0.7 * dn)[:, None] + 1e-9)
            self.cmd_l = np.where(m6[:, None], l6, self.cmd_l)
            self.cmd_n = np.where(m6, 99.0, self.cmd_n); self.cmd_thr = np.where(m6, 1.0, self.cmd_thr)
            self.cmd_sb = np.where(m6, False, self.cmd_sb); self.cmd_track = np.where(m6, R < 1200, self.cmd_track)
        # 5: 수세 봇 — 평소엔 봇 1처럼 추적, 상대가 뒤에 붙으면(2 km 이내, 상대 기수가 나를 40° 이내로 겨눔) 상대 쪽으로 최대 G 브레이크,
        #    상대 사격 해가 가까우면(리드 오차 10°, 1.5 km) 기동면 밖으로 재킹하며 1~2.5초마다 방향을 바꿈 (시저스 비슷한 수세 기동)
        m5 = self.scripted == 5
        if m5.any():
            self.cmd_l = np.where(m5[:, None], l1, self.cmd_l)
            self.cmd_n = np.where(m5, 99.0, self.cmd_n); self.cmd_thr = np.where(m5, 1.0, self.cmd_thr)
            self.cmd_sb = np.where(m5, False, self.cmd_sb); self.cmd_track = np.where(m5, R < 1200, self.cmd_track)
            fwd, _, _ = body_axes(f.quat)
            his_ata = np.arccos(np.clip(dot(fwd[o], -los), -1, 1))
            behind = m5 & (R < 2000) & (his_ata < 40 * D2R) & (ata > np.pi / 2)
            brk = unit(los - u * dot(los, u)[:, None] + upP * 0.15 + 1e-9)
            self.cmd_l = np.where(behind[:, None], brk, self.cmd_l); self.cmd_track = np.where(behind, False, self.cmd_track)
            aim, _ = self.gun_lead(1.0)
            le = np.arccos(np.clip(dot(fwd, aim), -1, 1))
            jink = m5 & (le[o] < 10 * D2R) & (R < 1500)
            self.flip_t -= DECIDE * CTRL_DT
            flip = m5 & (self.flip_t <= 0)
            self.dodge_sgn = np.where(flip, -self.dodge_sgn, self.dodge_sgn)
            self.flip_t = np.where(flip, self.rng.uniform(1.0, 2.5, self.B), self.flip_t)
            if jink.any():
                ref = los - u * dot(los, u)[:, None]
                ref = np.where((norm(ref) > 0.05)[:, None], unit(ref + 1e-12), upP)
                ld = unit(cross(u, ref) * self.dodge_sgn[:, None] + upP * 0.25)
                self.cmd_l = np.where(jink[:, None], ld, self.cmd_l); self.cmd_track = np.where(jink, False, self.cmd_track)

    def expert_action(self):
        """사람식 봇(상대 1.2초 리드점 쪽 최대 G + 기총 추적)을 행동 공간으로 표현 — 모방 사전학습용.
        저고도(1500 m 이하)에서는 아래로 당기지 않음"""
        f = self.f; o = self.opp
        r, R, los, u, ata, aa, Vc = self.geometry()
        ref = los - u * dot(los, u)[:, None]
        refn = norm(ref)
        upP = np.array([0, 1.0, 0]) - u * u[:, 1:2]
        ref = np.where((refn > 0.05)[:, None], ref / np.maximum(refn, 1e-9)[:, None], unit(upP))
        side = cross(u, ref)
        lead = unit(f.pos[o] + f.vel[o] * 1.2 - f.pos)
        l = lead - u * dot(lead, u)[:, None]
        l = np.where((norm(l) > 1e-4)[:, None], unit(l + 1e-9), ref)
        low = (f.agl < 1500) & (l[:, 1] < 0)
        l[:, 1] = np.where(low, l[:, 1] * np.maximum(0, (f.agl - 600) / 900), l[:, 1])
        l = unit(l)
        th = np.arctan2(dot(l, side), dot(l, ref))
        a = np.stack([np.cos(th), np.sin(th), np.ones(self.B), np.ones(self.B), np.ones(self.B)], axis=1)
        # 접근이 너무 빠르면 스로틀 줄임 (오버슛 방지 기본기)
        VcT = np.clip((R - 300) / 3, 30, 200)
        a[:, 3] = np.where(Vc > VcT + 40, -0.5, np.where(Vc > VcT + 10, 0.6, 1.0))
        return a.astype(np.float32)

    # ------------------------------------------------------------ 1 제어 틱
    def control_tick(self):
        f = self.f
        dt = CTRL_DT
        r, R, los, u, ata, aa, Vc = self.geometry()
        aim, tof = self.gun_lead(1.0)
        fwd, up, right = body_axes(f.quat)
        lead_err = np.arccos(np.clip(dot(fwd, aim), -1, 1))
        track = self.cmd_track & (R < 1500) & (lead_err < np.where(self.tracking, 15, 10) * D2R)
        # 기본: 양력벡터 명령
        pitch, roll = self.fly_lift(self.cmd_l, self.cmd_n, np.zeros(self.B, dtype=bool))
        yaw = np.zeros(self.B)
        if track.any():
            tp, tr, ty = self.track_nose(aim, dt, track)
            pitch = np.where(track, tp, pitch); roll = np.where(track, tr, roll); yaw = np.where(track, ty, 0.0)
        self.tracking = track
        # ---- 안전 계층 (게임 ai.js 전설과 동일): 지형 회복 > 공중 충돌 회피 — 정책 명령을 덮어씀
        safe, sp, sr = self._safety(R)
        pitch = np.where(safe, sp, pitch); roll = np.where(safe, sr, roll)
        self.tracking &= ~safe
        track = track & ~safe
        sm = np.where(track, 12.0, 6.0) * dt
        f.c_pitch += (pitch - f.c_pitch) * np.minimum(sm, 1)
        f.c_roll += (roll - f.c_roll) * np.minimum(np.where(track, 12.0, 8.0) * dt, 1)
        yaw = np.where(safe, 0.0, yaw)
        f.c_yaw += (yaw - f.c_yaw) * min(dt * 6, 1)
        f.c_thr += (self.cmd_thr - f.c_thr) * min(dt * 2, 1)
        f.sb_cmd = self.cmd_sb.copy()
        # 사격: 리드 오차가 표적 크기 + 0.5° 이내, 1000 m 이내
        tol = np.arctan(8 / np.maximum(R, 1)) + 0.5 * D2R
        sol = (R < 1000) & (lead_err < tol) & (self.hp > 0) & ~self.trigger_block
        self.aim_t = np.where(sol, self.aim_t + dt, 0.0)
        self.trigger = sol & (self.aim_t >= AIM_SETTLE - 1e-9)
        prev_pos = f.pos.copy()
        prev_vel = f.vel.copy()
        prev_quat = f.quat.copy()
        for _ in range(SUB):
            f.step(PH)
        self._guns(dt, prev_pos, prev_vel, prev_quat)
        self._collisions(prev_pos, prev_vel)
        self.tick += 1

    def _safety(self, R):
        """ai.js update()의 전설 지형 회복(당겨 올림 고도 + 1초 뒤 예측)과 공중 충돌 회피(1.8초·45 m)"""
        f = self.f; o = self.opp
        V = np.maximum(f.V, 1)
        gam = np.arcsin(np.clip(f.vel[:, 1] / V, -1, 1))
        nAv = np.clip(np.maximum(1, f.nz) * 27 * D2R / np.maximum(f.alpha, 4 * D2R), 2.5, 7)
        need = np.where(gam < 0, V * V / (G0 * (nAv - 1)) * (1 - np.cos(gam)) - f.vel[:, 1] * 0.6, 0)
        _, up, _ = body_axes(f.quat)
        A = up * (np.maximum(0, f.nz) * G0)[:, None]; A[:, 1] -= G0
        w1 = f.vel + A
        V1 = np.maximum(norm(w1), 1); g1 = np.arcsin(np.clip(w1[:, 1] / V1, -1, 1))
        agl1 = f.agl + f.vel[:, 1] + 0.5 * A[:, 1]
        need1 = np.where(g1 < 0, V1 * V1 / (G0 * (nAv - 1)) * (1 - np.cos(g1)) - w1[:, 1] * 0.6, 0)
        ahead = np.minimum(f.agl + f.vel[:, 1] * 1, f.agl + f.vel[:, 1] * 2)
        danger = (f.agl < need + 250) | (agl1 < need1 + 200) | (ahead < 200) | (f.agl < 150)
        danger |= self.recover & (f.agl < need + 300)
        self.recover = danger
        u = unit(f.vel)
        liftUp = np.array([0, 1.0, 0]) - u * u[:, 1:2]
        liftUp = np.where((norm(liftUp) > 0.05)[:, None], unit(liftUp + 1e-12), up)
        # 공중 충돌 회피
        rv = f.vel[o] - f.vel; p0 = f.pos[o] - f.pos
        tc = -dot(p0, rv) / np.maximum(dot(rv, rv), 1)
        c = p0 + rv * tc[:, None]; dc = norm(c)
        coll = (tc > 0) & (tc < 1.8) & (dc < 45) & ~danger
        away = -c / np.maximum(dc, 1e-6)[:, None]
        away = np.where((dc < 1)[:, None], np.array([0, -1.0, 0]), away)
        away = away - u * dot(away, u)[:, None]
        low = (f.agl < 1500) & (away[:, 1] < 0)
        away[:, 1] = np.where(low, away[:, 1] * np.maximum(0, (f.agl - 500) / 1000), away[:, 1])
        away = np.where((norm(away) > 1e-3)[:, None], unit(away + 1e-12), liftUp)
        l = np.where(danger[:, None], liftUp, away)
        safe = danger | coll
        n = np.full(self.B, 99.0)
        p, r = self.fly_lift(l, n, danger)
        self.cmd_thr = np.where(danger, 1.0, self.cmd_thr)
        self.cmd_sb = np.where(danger, False, self.cmd_sb)
        self.trigger_block = coll
        return safe, p, r

    def _guns(self, dt, tpos0, tvel0, tquat0):
        f = self.f
        self.spin = np.clip(self.spin + np.where(self.trigger, dt / GUN['spinUp'], -dt / 0.6), 0, 1)
        firing = self.trigger & (self.spin > 0.05)
        self.roundAcc = np.where(firing, self.roundAcc + GUN['rate'] * self.spin * dt, 0)
        # 1/30초마다 묶음 발사
        if self.tick % 2 == 1:
            emit = self.roundAcc > 0.5
            if emit.any():
                ii = np.nonzero(emit)[0]
                k = self.pk_i[ii]
                fwd, _, _ = body_axes(f.quat[ii])
                self.pk_p[ii, k] = f.pos[ii]
                self.pk_v[ii, k] = fwd * GUN['muzzle'] + f.vel[ii]
                self.pk_n[ii, k] = self.roundAcc[ii]
                self.pk_age[ii, k] = 0
                self.pk_on[ii, k] = True
                self.pk_i[ii] = (k + 1) % PK
                self.roundAcc[ii] = 0
        on = self.pk_on
        bi, ki = np.nonzero(on)
        if len(bi) == 0:
            return
        # 활성 탄 묶음만: 이동 (프레임 dt, 이차 항력 + 중력) 후 표적과의 최근접 판정 (표적의 틱 시작 위치·속도 기준)
        p0 = self.pk_p[bi, ki]
        v = self.pk_v[bi, ki]
        _, _, rho, _, _ = isa(p0[:, 1])
        kk = GUN['k'] * (rho / 1.225) * norm(v)
        v = v * np.maximum(0, 1 - kk * dt)[:, None]
        v[:, 1] -= G0 * dt
        age = self.pk_age[bi, ki] + dt
        self.pk_v[bi, ki] = v
        self.pk_p[bi, ki] = p0 + v * dt
        self.pk_age[bi, ki] = age
        o = self.opp[bi]
        rel0 = p0 - tpos0[o]
        relv = v - tvel0[o]
        ts = -dot(rel0, relv) / np.maximum(dot(relv, relv), 1e-6)
        inside = (ts >= 0) & (ts < dt)
        d = norm(rel0 + relv * np.clip(ts, 0, dt)[:, None])
        w = GUN['disp'] * GUN['muzzle'] * age
        near = norm(rel0) < 1500
        hitm = inside & near & (self.hp[o] > 0)
        # 피탄 형상: 표적 기체축 타원체 (weapons.js HIT_AXES). 탄 산포(경로에 수직인 면의 ±w 정사각형)를 4×4 격자로 표본해
        # 각 탄 경로가 타원체를 지나는 비율 = 명중 확률 (게임: 탄마다 같은 판정 후 60 %)
        P = np.zeros(len(bi))
        cand = np.nonzero(hitm & (d < 10 + 1.5 * w))[0]
        if cand.size:
            qi = qconj(tquat0[o[cand]])
            A0 = local_to_aero(qrot(qi, rel0[cand]))
            Bv = local_to_aero(qrot(qi, relv[cand]))
            ref = np.where((np.abs(Bv[:, 2]) < 0.9 * norm(Bv))[:, None], np.array([0, 0, 1.0]), np.array([0, 1.0, 0]))
            e1 = unit(cross(Bv, ref)); e2 = unit(cross(Bv, e1))
            g = (np.array([-0.75, -0.25, 0.25, 0.75])[:, None] * np.ones(4)[None, :])
            o1 = g.reshape(-1); o2 = g.T.reshape(-1)
            ww = w[cand][:, None, None]
            Ap = A0[:, None, :] + ww * (o1[None, :, None] * e1[:, None, :] + o2[None, :, None] * e2[:, None, :])
            Ap = Ap / HIT_AXES; Bs = (Bv / HIT_AXES)[:, None, :]
            tt = -np.sum(Ap * Bs, -1) / np.maximum(np.sum(Bs * Bs, -1), 1e-9)
            dist2 = np.sum((Ap + Bs * tt[..., None]) ** 2, -1)
            P[cand] = (dist2 < 1).mean(axis=1)
        dmg_k = np.where(hitm, self.pk_n[bi, ki] * 0.6 * P * 6.5, 0)
        dmg = np.bincount(bi, weights=dmg_k, minlength=self.B)
        self.dmg_dealt += dmg
        self.dmg_taken[self.opp] += dmg
        self.hp[self.opp] -= dmg
        self.pk_on[bi, ki] = ~(inside & near) & (age < GUN['life'])

    def _collisions(self, p0, v0):
        N = self.N
        a, b = np.arange(N), np.arange(N) + N
        rel0 = p0[b] - p0[a]; relv = v0[b] - v0[a]
        ts = np.clip(-dot(rel0, relv) / np.maximum(dot(relv, relv), 1e-6), 0, CTRL_DT)
        d = norm(rel0 + relv * ts[:, None])
        hit = d < 9
        if hit.any():
            self.f.crashed[a[hit]] = True; self.f.crashed[b[hit]] = True
            self.midair[a[hit]] = True; self.midair[b[hit]] = True

    # ------------------------------------------------------------ 관측
    def observe(self):
        f = self.f; o = self.opp
        r, R, los, u, ata, aa, Vc = self.geometry()
        upW = np.array([0, 1.0, 0])
        rt = cross(u, upW); rtn = norm(rt)
        rt = np.where((rtn > 1e-3)[:, None], rt / np.maximum(rtn, 1e-9)[:, None], np.array([1.0, 0, 0]))
        lu = cross(rt, u)

        def frame(v):   # 내 속도 프레임 (전방, 오른쪽, 위)
            return np.stack([dot(v, u), dot(v, rt), dot(v, lu)], axis=-1)
        fwd, up, right = body_axes(f.quat)
        aim, tof = self.gun_lead(1.0)
        lead_err = np.arccos(np.clip(dot(fwd, aim), -1, 1))
        his_lead = lead_err[o]
        hisfwd = fwd[o]
        his_ata = np.arccos(np.clip(dot(hisfwd, -los), -1, 1))
        gam = np.arcsin(np.clip(u[:, 1], -1, 1))
        bank_c = dot(up, lu); bank_s = dot(up, rt)
        rel_v = f.vel[o] - f.vel
        energy = f.pos[:, 1] + f.V ** 2 / (2 * G0)
        obs = np.concatenate([
            (f.V / 250 - 1)[:, None], (f.pos[:, 1] / 4000 - 1)[:, None], np.sin(gam)[:, None],
            bank_c[:, None], bank_s[:, None], (f.alpha / 0.3)[:, None], (f.nz / 5 - 0.5)[:, None],
            f.omega * np.array([0.5, 1.5, 2.0]), (f.eng_n - 0.8)[:, None] * 3, f.eng_ab[:, None], f.sb_pos[:, None],
            (self.hp / 100)[:, None], (f.thrust_mul - 1.07)[:, None] * 10,
            frame(los), (np.log(np.maximum(R, 50)) - 7)[:, None], frame(rel_v) / 200, (Vc / 200)[:, None],
            np.cos(ata)[:, None], np.cos(aa)[:, None], np.cos(his_ata)[:, None],
            frame(unit(f.vel[o])), frame(up[o]), (f.nz[o] / 5 - 0.5)[:, None], (f.V[o] / 250 - 1)[:, None],
            ((f.pos[o, 1] - f.pos[:, 1]) / 1000)[:, None], ((energy[o] - energy) / 1000)[:, None],
            (self.hp[o] / 100)[:, None], (f.thrust_mul[o] - 1.07)[:, None] * 10,
            np.minimum(lead_err / 0.3, 3)[:, None], np.minimum(his_lead / 0.3, 3)[:, None],
            frame(aim), self.tracking[:, None].astype(float), (f.agl / 1000)[:, None],
        ], axis=1)
        return obs.astype(np.float32)

    # ------------------------------------------------------------ 보상 (잠재함수 기반 형상화 + 피해/승패)
    def _potential(self):
        r, R, los, u, ata, aa, Vc = self.geometry()
        o = self.opp
        f = self.f
        fwd, _, _ = body_axes(f.quat)
        mine = (1 - ata / np.pi) * (1 - aa / np.pi)          # 내가 상대 꼬리 쪽을 겨눔
        his = mine[o]
        rng_w = np.exp(-np.maximum(R - 600, 0) / 2500)
        alt_pen = np.clip((600 - f.agl) / 600, 0, 1)
        return 1.0 * (mine - his) * rng_w - 0.5 * alt_pen

    def step(self, act):
        """act (B, ACT_DIM) → obs, rew (B), done (N), info"""
        N = self.N
        self.dmg_dealt[:] = 0; self.dmg_taken[:] = 0
        self.apply_actions(act)
        for _ in range(DECIDE):
            self.control_tick()
        self.t += DECIDE * CTRL_DT
        f = self.f
        dead = (self.hp <= 0) | f.crashed | f.overstress
        crash_self = f.crashed | f.overstress
        deadA, deadB = dead[:N], dead[N:]
        done = deadA | deadB | (self.t >= self.tmax)
        _, Rg, _, _, ata_g, aa_g, _ = self.geometry()
        self.off_gain |= (ata_g < 45 * D2R) & (aa_g < 60 * D2R) & (Rg < 1500) & ~dead[self.opp]
        pot = self._potential()
        rew = 0.995 * pot - self.prev_pot
        rew += (3.0 * self.dmg_dealt - 4.5 * self.dmg_taken) / 100   # 생존 우선: 맞바꾸기(정면 50:50 사격)는 손해
        o = self.opp
        win = np.concatenate([deadB & ~deadA, deadA & ~deadB])
        lose = np.concatenate([deadA & ~deadB, deadB & ~deadA])
        rew += np.where(win, 5.0, 0) - np.where(lose, 8.0, 0) - np.where(crash_self, 3.0, 0)   # 피격 −8 > 격추 +5: 실제 조종사처럼 '안 맞고 잡는' 기동을 고름
        # 사격 해(1000 m 이내, 리드 오차 3° 이내) 유지 보상 / 상대가 내게 사격 해를 잡으면 감점, 시간 비용(소극적 무승부 방지)
        _, R, _, _, _, _, _ = self.geometry()
        aim, _ = self.gun_lead(1.0)
        fwd, _, _ = body_axes(f.quat)
        le = np.arccos(np.clip(dot(fwd, aim), -1, 1))
        wez = ((R < 1000) & (le < 3 * D2R) & ~dead).astype(np.float32)
        rew += 0.03 * (wez - wez[o]) - 0.0005 - 0.004 * np.clip((R - 2000) / 3000, 0, 1)   # 2 km 넘게 벌어지면 양쪽 감점 (이탈 무승부 방지)
        self.prev_pot = pot
        info = dict(winA=(deadB & ~deadA)[done], winB=(deadA & ~deadB)[done], draw=(~deadA & ~deadB)[done] | (deadA & deadB)[done],
                    crashA=crash_self[:N][done], crashB=crash_self[N:][done], envs=np.nonzero(done)[0])
        info['cause'] = np.where(self.midair, 1, np.where(f.overstress, 3, np.where(f.crashed, 2, np.where(self.hp <= 0, 4, 0))))   # 0 생존 1 공중충돌 2 지면 3 과하중 4 피격
        info['agl'] = f.agl.copy()
        info['scen'] = self.scen[done].copy(); info['offA'] = self.off_gain[:N][done].copy(); info['offB'] = self.off_gain[N:][done].copy()
        # 시간 제한 종료(아무도 안 죽음)는 '진짜 끝'이 아니므로 학습 쪽에서 마지막 상태 가치로 이어 붙인다
        trunc = done & ~deadA & ~deadB
        info['trunc'] = np.concatenate([trunc, trunc])
        if trunc.any():
            info['obs_pre'] = self.observe()
        if done.any():
            envs = np.nonzero(done)[0]
            self._reset(envs)
        return self.observe(), rew.astype(np.float32), done, info
