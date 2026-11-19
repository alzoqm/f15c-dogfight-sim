"""전술 분석: 정책이 어떤 방식으로 피해를 주는지 (상대 꼬리 기준 각별 피해 비율), 정면 대치 빈도, 승패.
실행: python rl/tactics.py ckpt/latest.pkl [--vs ckpt/elite.pkl] [--n 128]"""
import argparse, os, pickle, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy

np.seterr(all='ignore')


def load(p):
    pol = Policy(OBS_DIM, ACT_DIM); pol.load(pickle.load(open(p, 'rb'))['pol']); return pol


def analyse(pol, n, opp=None, bot=0, seed=5):
    env = DuelEnv(n, seed=seed, legend_prob=1.0); env.reset_all()
    if bot:
        env.scripted[n:] = bot
    r, R, los, u, ata, aa, Vc = env.geometry()
    merge = (ata[:n] < 0.6) & (aa[:n] > 2.5)          # 머지(정면 대향) 출발 판
    rng = np.random.default_rng(0); obs = env.observe()
    mb = np.zeros(3); t = 0.0
    bins = np.zeros(3); ho = 0; steps = 0; res = np.zeros(3); seen = np.zeros(n, bool)
    for _ in range(905):
        a, _, _ = pol.act(obs, rng, deterministic=True)
        if opp is not None:
            a[n:], _, _ = opp.act(obs[n:], rng, deterministic=True)
        r, R, los, u, ata, aa, Vc = env.geometry()
        live = ~seen
        ho += ((R < 1500) & (ata < 30 * np.pi / 180) & (aa > 150 * np.pi / 180))[:n][live].sum(); steps += live.sum()
        obs, rw, done, info = env.step(np.clip(a, -1, 1))
        d = env.dmg_dealt[:n] * live; aad = np.degrees(aa[:n])
        bins += [d[aad < 60].sum(), d[(aad >= 60) & (aad < 120)].sum(), d[aad >= 120].sum()]
        t += 0.1
        if t > 25:   # 머지 출발 판의 첫 교차 이후 (반복 정면 교차 여부)
            dm = d * merge
            mb += [dm[aad < 60].sum(), dm[(aad >= 60) & (aad < 120)].sum(), dm[aad >= 120].sum()]
        for e, wa, wb in zip(info['envs'], info['winA'], info['winB']):
            if not seen[e]:
                seen[e] = True; res[0 if wa else (1 if wb else 2)] += 1
        if seen.all():
            break
    tot = max(bins.sum(), 1e-9)
    return (f'W/L/D {res[0]:.0f}/{res[1]:.0f}/{res[2]:.0f} | 피해 비율 꼬리(<60°) {bins[0]/tot:.0%} 옆 {bins[1]/tot:.0%} 정면(>120°) {bins[2]/tot:.0%} '
            f'| 정면 대치 시간 {ho/max(steps,1):.1%} | 머지 출발 25초 이후 정면 비율 {mb[2]/max(mb.sum(),1e-9):.0%}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt'); ap.add_argument('--vs', default=None); ap.add_argument('--n', type=int, default=128)
    a = ap.parse_args()
    pol = load(a.ckpt)
    print('vs self       ', analyse(pol, a.n, opp=pol), flush=True)
    if a.vs:
        print('vs', os.path.basename(a.vs).ljust(10), analyse(pol, a.n, opp=load(a.vs)), flush=True)
    print('vs 추적+회피봇 ', analyse(pol, a.n, bot=1), flush=True)
    print('vs 수직봇      ', analyse(pol, a.n, bot=3), flush=True)
