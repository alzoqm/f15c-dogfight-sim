"""JS 비행모델과 Python 이식의 궤적 비교"""
import json, numpy as np, sys
from sim import Fleet
from parity_ctl import ctl
js = json.load(open('data/parity_js.json'))
for name, (tm, nb) in {'base': (1, 0), 'legend': (1.15, 1)}.items():
    f = Fleet(1); f.thrust_mul[:] = tm; f.nz_bonus[:] = nb
    f.reset(np.array([0]), np.array([[0, 5000, 0.0]]), 30, 220, 0.85)
    PH = 1 / 240; rec = []
    for i in range(240 * 12 + 1):
        t = i * PH
        if i % 120 == 0:
            rec.append([t, *f.pos[0], *f.vel[0], *f.quat[0], *f.omega[0], f.nz[0], f.alpha[0]])
        p, r, y, th, sb = ctl(t)
        f.c_pitch[:] = p; f.c_roll[:] = r; f.c_yaw[:] = y; f.c_thr[:] = th; f.sb_cmd[:] = sb
        f.step(PH)
    a = np.array(rec); b = np.array(js[name])
    print(f'== {name}')
    for k in range(0, len(a), 4):
        dp = np.linalg.norm(a[k, 1:4] - b[k, 1:4]); dv = np.linalg.norm(a[k, 4:7] - b[k, 4:7])
        print(f't={a[k,0]:5.1f} dpos={dp:9.3f} m dvel={dv:7.3f}  py nz={a[k,14]:6.2f} js nz={b[k,14]:6.2f}  py a={np.degrees(a[k,15]):6.2f} js a={np.degrees(b[k,15]):6.2f} V py={np.linalg.norm(a[k,4:7]):6.1f} js={np.linalg.norm(b[k,4:7]):6.1f}')
