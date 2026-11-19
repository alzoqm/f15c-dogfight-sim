"""브라우저(src/rlpolicy.js) 관측·정책 출력과 Python(env.py, nn.py) 비교 — data/obs_js.json 필요"""
import json, pickle, numpy as np
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy
j = json.load(open('data/obs_js.json'))
env = DuelEnv(1, seed=0); f = env.f
for i, k in enumerate(['A', 'B']):
    d = j[k]
    f.pos[i] = d['pos']; f.vel[i] = d['vel']; f.quat[i] = d['quat']; f.omega[i] = d['omega']; f.nz[i] = d['nz']; f.alpha[i] = d['alpha']; f.V[i] = d['V']
    f.eng_n[i] = d['n']; f.eng_ab[i] = d['ab']; f.sb_pos[i] = d['sb']; env.hp[i] = d['hp']; f.thrust_mul[i] = d['tm']; f.nz_bonus[i] = d['nb']; f.agl[i] = d['agl']
env.tracking[:] = [False, True]
o = env.observe()
for side, key in [(0, 'oa'), (1, 'ob')]:
    print(key, 'obs max |diff|', np.abs(o[side] - np.array(j[key])).max())
import base64
P = json.load(open('../src/legend_policy.json'))
x = np.clip((np.array([j['oa'], j['ob']]) - np.array(P['mean'])) / np.sqrt(np.array(P['var']) + 1e-8), -10, 10)
for li, L in enumerate(P['layers']):
    W = np.frombuffer(base64.b64decode(L['W']), np.float32).reshape(L['shape']); b = np.frombuffer(base64.b64decode(L['b']), np.float32)
    x = x @ W + b
    if li < len(P['layers']) - 1: x = np.tanh(x)
print('act max diff', np.abs(np.clip(x, -1, 1) - np.array([j['acta'], j['actb']])).max())
