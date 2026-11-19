"""학습된 정책 평가 (결정적 행동). 실행: python rl/eval.py [ckpt] [--n 256]
상대: 사람식 추적 봇(bot1), 수평 선회 봇(bot2), 이전 체크포인트(선택)."""
import argparse, os, pickle, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy

HERE = os.path.dirname(os.path.abspath(__file__))


def load(path):
    p = Policy(OBS_DIM, ACT_DIM)
    p.load(pickle.load(open(path, 'rb'))['pol'])
    return p


def run(pol, opp_kind, n, opp_pol=None, seed=123, legend_side=None):
    env = DuelEnv(n, seed=seed, max_t=90)
    N = n
    if opp_kind in (1, 2):
        env.scripted[N:] = opp_kind
    # 전설 성능(추력 +15 %, G +1)을 누구에게: None = 무작위(학습과 동일), 'me' = 정책만, 'both'/'none'
    if legend_side is not None:
        env.legend_prob = {'me': 0.0, 'both': 1.0, 'none': 0.0}[legend_side]
        env.reset_all()
        if legend_side == 'me':
            env.f.thrust_mul[:N] = 1.15; env.f.nz_bonus[:N] = 1.0
    rng = np.random.default_rng(seed)
    obs = env.observe()
    res = np.zeros(3); crash = 0; dmg = [0.0, 0.0]; done_env = np.zeros(N, bool)
    for _ in range(int(90 / 0.1) + 2):
        a, _, _ = pol.act(obs, rng, deterministic=True)
        if opp_pol is not None:
            ao, _, _ = opp_pol.act(obs[N:], rng, deterministic=True)
            a[N:] = ao
        obs, r, done, info = env.step(np.clip(a, -1, 1))
        dmg[0] += env.dmg_dealt[:N][~done_env].sum(); dmg[1] += env.dmg_dealt[N:][~done_env].sum()
        for e, wa, wb, ca in zip(info['envs'], info['winA'], info['winB'], info['crashA']):
            if done_env[e]:
                continue
            done_env[e] = True
            res[0 if wa else (1 if wb else 2)] += 1
            crash += int(ca)
        if done_env.all():
            break
        if legend_side == 'me' and info['envs'].size:   # 재시작된 판은 집계 제외라 성능 재설정 불필요
            pass
    return res, crash, dmg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt', nargs='?', default=os.path.join(HERE, 'ckpt', 'latest.pkl'))
    ap.add_argument('--n', type=int, default=256)
    ap.add_argument('--vs', default=None, help='상대 체크포인트')
    args = ap.parse_args()
    np.seterr(all='ignore')
    pol = load(args.ckpt)
    for name, kind in [('bot1 (pursuit)', 1), ('bot2 (flat turn)', 2)]:
        for side in ['none', 'me']:
            res, crash, dmg = run(pol, kind, args.n, legend_side=side)
            print(f'vs {name:17s} perf={side:4s}: W {res[0]:.0f} / L {res[1]:.0f} / D {res[2]:.0f}  self-crash {crash}  dmg dealt {dmg[0]/args.n:.0f} taken {dmg[1]/args.n:.0f}', flush=True)
    if args.vs:
        res, crash, dmg = run(pol, 0, args.n, opp_pol=load(args.vs), legend_side='none')
        print(f'vs {os.path.basename(args.vs)}: W {res[0]:.0f} / L {res[1]:.0f} / D {res[2]:.0f}', flush=True)


if __name__ == '__main__':
    main()
