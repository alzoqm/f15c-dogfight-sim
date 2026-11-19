"""기총 추적 법칙 시험: 4G로 선회를 시작하는 표적을 600 m 뒤에서 추적 (JS 동일 시나리오)"""
import numpy as np, sys
from env import DuelEnv, body_axes, dot, unit, cross, D2R
np.seterr(all='ignore')


def run(bank=75, n_t=4.0, R0=600, V=200, ticks=300, verbose=True, env_cls=DuelEnv, rev=None):
    env = env_cls(1, seed=0); f = env.f
    f.reset(np.array([0, 1]), np.array([[0, 5000, 0.0], [0, 5000, -R0]]), 0, V, 0.85)
    f.agl[:] = f.pos[:, 1]
    les = []
    for k in range(ticks):
        u = unit(f.vel[1:2]); upP = unit(np.array([[0, 1.0, 0]]) - u * u[:, 1:2]); rt = unit(cross(u, upP))
        bk = -bank if (rev is not None and k >= rev) else bank
        l = unit(upP * np.cos(np.radians(bk)) + rt * np.sin(np.radians(bk)))
        aim, _ = env.gun_lead(1.0)
        fwd, _, _ = body_axes(f.quat); le = np.degrees(np.arccos(np.clip(dot(fwd, aim), -1, 1)))[0]
        les.append(le)
        pt, rt_ = env.fly_lift(np.repeat(l, 2, 0), np.array([n_t, n_t]), np.zeros(2, bool))
        pa, ra, ya = env.track_nose(aim, 1 / 60, np.array([True, False]))
        env.tracking[:] = [True, False]
        pitch = np.array([pa[0], pt[1]]); roll = np.array([ra[0], rt_[1]])
        f.c_pitch += (pitch - f.c_pitch) * np.array([12, 6]) / 60
        f.c_roll += (roll - f.c_roll) * np.array([12, 8]) / 60
        f.c_yaw += (np.array([ya[0], 0.0]) - f.c_yaw) * 0.1
        f.c_thr += (1 - f.c_thr) * 2 / 60
        for _ in range(4):
            f.step(1 / 240)
        if verbose and k % 20 == 0:
            print(f'{k} le={le:.2f} nz={f.nz[0]:.1f}/{f.nz[1]:.1f} roll={f.c_roll[0]:.2f}')
    return np.array(les)


if __name__ == '__main__':
    run()
