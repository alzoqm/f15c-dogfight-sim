"""고정 벤치마크: 정책(v1 .pkl 또는 v2 .pt)의 시나리오별 성공률과 주요 상대 전적 (결정적 행동, 고정 시드).
실행: python rl/bench.py ckpt/v2_latest.pt [--n 64]
  공세 마무리(회피 봇, 60초 안 격추율) / 수세 탈출(추적 봇·엘리트, 안 맞고 역전 비율) /
  머지·저고도(엘리트 상대 승률) / 전체 교전(엘리트·전설61·사람 봇·추적 봇 상대 승/패/무)"""
import argparse, os, pickle, sys
for _k in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(_k, '2')   # 평가가 학습 작업자 CPU를 뺏지 않도록
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy
from model import Stacker, NPActor

np.seterr(all='ignore')
HERE = os.path.dirname(os.path.abspath(__file__))


class Agent:
    """v1(.pkl, 관측 45)·v2(.pt, 쌓은 관측) 공통 인터페이스"""

    def __init__(self, path):
        p = path if os.path.isabs(path) else os.path.join(HERE, path)
        if p.endswith('.pt'):
            from export2 import load_np_state
            st, _ = load_np_state(p); self.a = NPActor(st); self.v2 = True
        else:
            self.a = Policy(OBS_DIM, ACT_DIM); self.a.load(pickle.load(open(p, 'rb'))['pol']); self.v2 = False

    def act(self, obs, xs, rng):
        if self.v2:
            return self.a.act(xs, rng, deterministic=True)[0]
        return self.a.act(obs, rng, deterministic=True)[0]


def duel(me, n, scen, opp=None, bot=0, seed=21):
    env = DuelEnv(n, seed=seed, max_t=240)
    env.scen_probs = np.eye(5)[scen]
    if bot: env.scripted[n:] = bot
    env.reset_all()
    rng = np.random.default_rng(0); obs = env.observe(); st = Stacker(env.B); st.reset(np.arange(env.B), obs)
    seen = np.zeros(n, bool); res = np.zeros(3); off = 0; ok = 0; gc = 0
    for _ in range(2500):
        xs = st.get()
        a = me.act(obs, xs, rng)
        if opp is not None:
            a[n:] = opp.act(obs[n:], xs[n:], rng)
        obs, r, done, info = env.step(np.clip(a, -1, 1))
        st.push(obs)
        for k, e in enumerate(info['envs']):
            if not seen[e]:
                seen[e] = True; w, l = info['winA'][k], info['winB'][k]
                res[0 if w else (1 if l else 2)] += 1; off += info['offA'][k]; gc += info['cause'][e] == 2
                ok += ((not l) and (info['offA'][k] or w)) if scen == 2 else w
        if done.any():
            e = np.nonzero(done)[0]; st.reset(np.concatenate([e, e + n]), obs)
        if seen.all():
            break
    return res, ok / n, gc


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('ckpt'); ap.add_argument('--n', type=int, default=64)
    a = ap.parse_args()
    me = Agent(a.ckpt); elite = Agent('ckpt/elite.pkl'); leg = Agent('ckpt/run7_it61.pkl')
    rows = [('공세 마무리 vs 회피봇', 1, None, 5), ('수세 탈출 vs 추적봇', 2, None, 1), ('수세 탈출 vs 엘리트', 2, elite, 0),
            ('머지 vs 엘리트', 3, elite, 0), ('저고도 vs 엘리트', 4, elite, 0), ('저고도 vs 하강봇', 4, None, 6), ('저고도 vs 사람봇', 4, None, 4),
            ('전체 vs 엘리트', 0, elite, 0), ('전체 vs 전설61', 0, leg, 0), ('전체 vs 사람봇', 0, None, 4), ('전체 vs 추적봇', 0, None, 1)]
    tot = 0
    for name, sc, opp, bot in rows:
        res, ok, gc = duel(me, a.n, sc, opp, bot)
        tot += ok
        print(f'{name:16s} 성공 {ok:5.0%}  W/L/D {res[0]:.0f}/{res[1]:.0f}/{res[2]:.0f}  지면충돌 {gc}', flush=True)
    print(f'평균 성공률 {tot / len(rows):.1%}')
