"""모방 사전학습: 사람식 봇의 행동을 정책 평균으로 회귀 (DAgger 방식 — 정책/잡음 섞인 행동으로 상태를 넓힘).
실행: python rl/bc.py → ckpt/bc.pkl"""
import os, pickle, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy, Adam

HERE = os.path.dirname(os.path.abspath(__file__))
np.seterr(all='ignore')
rng = np.random.default_rng(0)
pol = Policy(OBS_DIM, ACT_DIM, seed=0)
opt = Adam(pol.pi.params, lr=1e-3)
X, Y = [], []


def collect(rounds, beta, N=512, steps=300, seed=0):
    env = DuelEnv(N, seed=seed, max_t=90)
    obs = env.observe()
    for t in range(steps):
        ea = env.expert_action()
        X.append(obs); Y.append(ea)
        if beta >= 1:
            a = ea
        else:
            pa, _, _ = pol.act(obs, rng, deterministic=True)
            use = rng.random(env.B) < beta
            a = np.where(use[:, None], ea, pa)
        a = a + rng.normal(0, 0.15, a.shape)
        obs, _, _, _ = env.step(np.clip(a, -1, 1))


def fit(epochs):
    x = np.concatenate(X); y = np.concatenate(Y)
    pol.norm.update(x[rng.choice(len(x), min(300000, len(x)), replace=False)])
    xn = pol.norm(x)
    for ep in range(epochs):
        perm = rng.permutation(len(x)); tot = 0
        for s0 in range(0, len(x), 4096):
            i = perm[s0:s0 + 4096]
            mu = pol.pi.forward(xn[i], cache=True)
            g = (2 * (mu - y[i]) / len(i)).astype(np.float32)
            opt.step(pol.pi.params, pol.pi.backward(g), max_norm=5)
            tot += float(((mu - y[i]) ** 2).mean()) * len(i)
        print(f'  epoch {ep} mse {tot/len(x):.4f}', flush=True)


t0 = time.time()
for r, beta in enumerate([1.0, 0.5, 0.2, 0.0]):
    collect(r, beta, seed=r)
    print(f'round {r} beta {beta}: {sum(len(x) for x in X)} samples, {time.time()-t0:.0f}s', flush=True)
    fit(6 if r < 3 else 10)
pol.log_std[:] = np.log(0.25)
pickle.dump(dict(pol=pol.state(), it=0), open(os.path.join(HERE, 'ckpt', 'bc.pkl'), 'wb'))
print('saved ckpt/bc.pkl')
