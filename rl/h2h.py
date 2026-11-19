"""두 정책의 맞대결 (시뮬레이터, 결정적 행동). 양쪽 자리를 바꿔 두 번 돌려 자리 편향을 없앤다.
실행: python rl/h2h.py ckpt/v2_it01000.pt ckpt/legend_v2.pt [--n 64]
출력: 후보 기준 승/패/무와 점수 (승 + 0.5×무) / 판 수"""
import argparse, os, sys
for _k in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(_k, '2')   # 평가가 학습 작업자 CPU를 뺏지 않도록
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench import Agent
from env import DuelEnv
from model import Stacker

np.seterr(all='ignore')


def play(a, b, n, seed, game=False):
    env = DuelEnv(n, seed=seed, max_t=240)
    env.scen_probs = np.array([0.5, 0.1, 0.1, 0.1, 0.2])
    if game:   # 게임 조건: 정면 머지 출발, 양쪽 전설 성능(추력 +15%, G +1), 연료 가득
        env.scen_probs = np.eye(5)[3]; env.perf_fix = (1.15, 1.0)
    env.reset_all()
    rng = np.random.default_rng(seed); obs = env.observe(); st = Stacker(env.B); st.reset(np.arange(env.B), obs)
    seen = np.zeros(n, bool); res = np.zeros(3)
    for _ in range(2500):
        xs = st.get()
        act = a.act(obs, xs, rng)
        act[n:] = b.act(obs[n:], xs[n:], rng)
        obs, r, done, info = env.step(np.clip(act, -1, 1))
        st.push(obs)
        for k, e in enumerate(info['envs']):
            if not seen[e]:
                seen[e] = True; res[0 if info['winA'][k] else (1 if info['winB'][k] else 2)] += 1
        if done.any():
            e = np.nonzero(done)[0]; st.reset(np.concatenate([e, e + n]), obs)
        if seen.all():
            break
    return res


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('cand'); ap.add_argument('ref'); ap.add_argument('--n', type=int, default=64)
    ap.add_argument('--game', action='store_true', help='게임 조건(머지 출발, 양쪽 전설 성능)')
    x = ap.parse_args()
    A, B = Agent(x.cand), Agent(x.ref)
    r1 = play(A, B, x.n, 31, x.game); r2 = play(B, A, x.n, 32, x.game)
    w, l, d = r1[0] + r2[1], r1[1] + r2[0], r1[2] + r2[2]
    tot = w + l + d
    print(f'{"[게임조건] " if x.game else ""}{os.path.basename(x.cand)} vs {os.path.basename(x.ref)}: W/L/D {w:.0f}/{l:.0f}/{d:.0f}  점수 {(w + 0.5 * d) / tot:.3f}')
