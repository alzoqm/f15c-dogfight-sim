"""에너지 관리 평가: 긴(240초)·다양한 시작 조건에서 정책이 속도를 얼마나 잃는지.
실행: python rl/energy.py ckpt/<정책>.pkl [--vs ckpt/<상대>.pkl] [--n 64]
지표: 승/패/무, 저속(150 kt 미만) 시간, 받음각 25° 초과 시간, 저고도(1 km 미만) 시간, 지면 충돌 수, 평균 속도."""
import argparse, os, pickle, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy

np.seterr(all='ignore')


def load(p):
    pol = Policy(OBS_DIM, ACT_DIM); pol.load(pickle.load(open(p, 'rb'))['pol']); return pol


def run(pol, n, opp=None, bot=0, max_t=240, seed=11):
    env = DuelEnv(n, seed=seed, max_t=max_t, legend_prob=1.0)
    if bot: env.scripted[n:] = bot
    env.reset_all()
    rng = np.random.default_rng(0); obs = env.observe()
    seen = np.zeros(n, bool); res = np.zeros(3); gcrash = 0
    slow = hiA = low = steps = 0; V = 0.0
    for _ in range(int(max_t * 10) + 5):
        a, _, _ = pol.act(obs, rng, deterministic=True)
        if opp is not None:
            a[n:], _, _ = opp.act(obs[n:], rng, deterministic=True)
        live = ~seen; f = env.f
        slow += (f.V[:n][live] < 77).sum(); hiA += (f.alpha[:n][live] > np.radians(25)).sum()
        low += (f.pos[:n, 1][live] < 1000).sum(); V += f.V[:n][live].sum(); steps += live.sum()
        obs, rw, done, info = env.step(np.clip(a, -1, 1))
        for k, e in enumerate(info['envs']):
            if not seen[e]:
                seen[e] = True; res[0 if info['winA'][k] else (1 if info['winB'][k] else 2)] += 1
                gcrash += int(info['cause'][e] == 2)
        if seen.all():
            break
    s = max(steps, 1)
    return (f'W/L/D {res[0]:.0f}/{res[1]:.0f}/{res[2]:.0f}  지면충돌 {gcrash}  평균 {V / s * 1.944:.0f} kt  '
            f'150kt 미만 {slow / s:.1%}  받음각>25° {hiA / s:.0%}  1km 미만 {low / s:.0%}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('ckpt'); ap.add_argument('--vs'); ap.add_argument('--n', type=int, default=64)
    a = ap.parse_args()
    pol = load(a.ckpt)
    print('vs self      ', run(pol, a.n, opp=pol), flush=True)
    if a.vs:
        print('vs', os.path.basename(a.vs).ljust(10), run(pol, a.n, opp=load(a.vs)), flush=True)
    print('vs 추적봇     ', run(pol, a.n, bot=1), flush=True)
    print('vs 사람 봇    ', run(pol, a.n, bot=4), flush=True)
