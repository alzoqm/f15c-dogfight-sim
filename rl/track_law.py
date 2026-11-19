"""새 기총 추적 법칙 후보 (기수 직접 지향) — 시험용"""
import numpy as np
from env import DuelEnv, unit, dot, norm, cross, G0, body_axes
from sim import cl_basic, S, MASS_EMPTY, MASS_CREW, ROUND_MASS, D2R


class Point(DuelEnv):
    K_D, K_I, LEAD = 0.15, 1.0, 1.0

    def track_nose(self, aim, dt, mask):
        f = self.f
        u = unit(f.vel)
        fresh = mask & ~self.tracking
        ap = aim - u * dot(aim, u)[:, None]; apn = norm(ap)
        lU = np.where((apn > 1e-4)[:, None], ap / np.maximum(apn, 1e-9)[:, None], np.array([0, 1.0, 0]))
        th = np.arctan2(apn, dot(aim, u))
        if not hasattr(self, 'thPrev'):
            self.thPrev = np.zeros(self.B); self.thD = np.zeros(self.B); self.thI = np.zeros(self.B)
        d = np.where(fresh, 0.0, np.clip((th - self.thPrev) / dt, -1, 1))
        self.thD = np.where(fresh, 0.0, self.thD + (d - self.thD) * min(1.0, dt / 0.1))
        e = th - f.alpha
        self.thI = np.where(fresh, 0.0, np.where(np.abs(e) < 0.03, np.clip(self.thI + e * dt, -0.01, 0.01), self.thI * 0.95))
        self.thPrev = th
        aC = np.clip(th + self.K_D * self.thD + self.K_I * self.thI, -0.2, 30 * D2R)
        m = MASS_EMPTY + MASS_CREW + f.fuel + f.ammo * ROUND_MASS
        n = f.qbar * S * cl_basic(aC, f.M) / (m * G0)
        return self.fly_lift(lU, n, np.ones(self.B, bool))
