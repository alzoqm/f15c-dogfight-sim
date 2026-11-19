"""종료 원인 분석: 정책 vs 봇/자기 자신"""
import sys, pickle, numpy as np
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy
np.seterr(all='ignore')
pol = Policy(OBS_DIM, ACT_DIM); pol.load(pickle.load(open(sys.argv[1] if len(sys.argv) > 1 else 'ckpt/latest.pkl', 'rb'))['pol'])
names = ['alive', 'midair', 'ground', 'overG', 'gunned']
for kind in [1, 0]:
    N = 128; env = DuelEnv(N, seed=7); env.scripted[N:] = kind
    rng = np.random.default_rng(0); obs = env.observe(); seen = np.zeros(N, bool)
    cA = np.zeros(5, int); cB = np.zeros(5, int); agl_g = []
    for _ in range(905):
        a, _, _ = pol.act(obs, rng, deterministic=True)
        obs, r, done, info = env.step(np.clip(a, -1, 1))
        for e in np.nonzero(done)[0]:
            if seen[e]: continue
            seen[e] = True
            cA[info['cause'][e]] += 1; cB[info['cause'][e + N]] += 1
        if seen.all(): break
    print('vs', 'bot1' if kind == 1 else 'self', ' policy:', dict(zip(names, cA)), ' opp:', dict(zip(names, cB)))
