"""PPO 셀프플레이 학습 (numpy, 다중 프로세스).

실행: python rl/train.py [--workers 12] [--envs 256] [--iters 2000] [--resume]
각 작업 프로세스는 N개의 공중전을 계속 진행하며 T 결정 단계씩 경험을 모아 보낸다.
상대 구성 (환경 인덱스 비율로 고정):
  45% 셀프플레이(양쪽 모두 현재 정책, 양쪽 경험 사용) / 25% 과거 정책 풀 / 20% 사람식 추적 봇 / 10% 수평 선회 봇
"""
import argparse, os, pickle, time, sys
import multiprocessing as mp
if mp.parent_process() is not None:          # 작업 프로세스: BLAS 1스레드 (코어 과다 점유 방지)
    for k in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
        os.environ[k] = '1'
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy, Adam, ppo_update

HERE = os.path.dirname(os.path.abspath(__file__))
CK = os.path.join(HERE, 'ckpt')
GAMMA, LAM = 0.995, 0.95


HUMAN_FRAC = float(os.environ.get('HUMAN_FRAC', '0.2'))   # 사람 모방 봇 상대 비율 (rl/ckpt/humanbot.pkl이 있을 때)
FIXED = os.environ.get('FIXED_OPP')      # 고정 상대 정책(예: ckpt/elite.pkl) — 있으면 15% 환경에서 그 정책과 대결


def split(N):
    hb = HUMAN_FRAC if os.path.exists(os.path.join(HERE, 'ckpt', 'humanbot.pkl')) else 0.0
    fr = [0.30, 0.15, 0.10, 0.05, 0.10, 0.10, hb] if FIXED else [0.35, 0.20, 0.12, 0.05, 0.0, 0.13, hb]
    fr[0] += 1 - sum(fr)
    kinds = np.zeros(N, dtype=int)            # 0 셀프, 1 풀, 2 봇1(추적+정면 회피), 3 봇2(수평 선회), 4 고정 상대, 5 봇3(수직), 6 사람 모방 봇
    edges = np.cumsum([int(N * f) for f in fr[:-1]])
    for k, e0 in enumerate(edges):
        kinds[e0:] = k + 1
    return kinds


def worker(wid, N, T, conn, max_t):
    np.seterr(all='ignore')
    env = DuelEnv(N, seed=1000 + wid, max_t=max_t)
    kinds = split(N)
    # 청/적 어느 쪽이 학습 대상인지 무작위 (좌우 편향 방지): 봇·풀 상대는 적군 자리에 둔다
    env.scripted[N:] = np.select([kinds == 2, kinds == 3, kinds == 5, kinds == 6], [1, 2, 3, 4], 0)
    learn = np.concatenate([np.ones(N, bool), kinds == 0])        # 학습 데이터로 쓸 기체
    pool_side = np.concatenate([np.zeros(N, bool), kinds == 1])   # 과거 정책이 조종
    fixed_side = np.concatenate([np.zeros(N, bool), kinds == 4])  # 고정 상대가 조종
    pol = Policy(OBS_DIM, ACT_DIM); opp = Policy(OBS_DIM, ACT_DIM); fixed = Policy(OBS_DIM, ACT_DIM)
    if FIXED:
        fixed.load(pickle.load(open(FIXED, 'rb'))['pol'])
    rng = np.random.default_rng(wid + 7)
    obs = env.observe()
    while True:
        msg = conn.recv()
        if msg is None:
            break
        pol.load(msg['pol'])
        if msg['opp'] is not None:
            opp.load(msg['opp'])
        else:
            opp.load(msg['pol'])
        B = env.B
        O = np.zeros((T, B, OBS_DIM), np.float32); A = np.zeros((T, B, ACT_DIM), np.float32)
        LP = np.zeros((T, B), np.float32); V = np.zeros((T, B), np.float32); R = np.zeros((T, B), np.float32); D = np.zeros((T, B), np.float32)
        res = np.zeros((7, 3))   # 상대 종류별 [승, 패, 무] (청군 기준)
        crash = 0
        for t in range(T):
            a, lp, v = pol.act(obs, rng)
            if pool_side.any():
                ao, _, _ = opp.act(obs[pool_side], rng)
                a[pool_side] = ao
            if fixed_side.any():
                af, _, _ = fixed.act(obs[fixed_side], rng, deterministic=True)
                a[fixed_side] = af
            o2, r, done, info = env.step(np.clip(a, -1, 1))
            if info['trunc'].any():
                tm = info['trunc']
                r = r.copy(); r[tm] += GAMMA * pol.value(info['obs_pre'][tm])
            O[t], A[t], LP[t], V[t], R[t] = obs, a, lp, v, r
            dd = np.concatenate([done, done]).astype(np.float32)
            D[t] = dd
            for e, wa, wb, dr, ca in zip(info['envs'], info['winA'], info['winB'], info['draw'], info['crashA']):
                res[kinds[e], 0 if wa else (1 if wb else 2)] += 1
                crash += int(ca)
            obs = o2
        last_v = pol.value(obs).astype(np.float32)
        # GAE
        adv = np.zeros((T, B), np.float32); g = np.zeros(B, np.float32)
        for t in reversed(range(T)):
            nv = last_v if t == T - 1 else V[t + 1]
            nonterm = 1 - D[t]
            delta = R[t] + GAMMA * nv * nonterm - V[t]
            g = delta + GAMMA * LAM * nonterm * g
            adv[t] = g
        ret = adv + V
        m = learn
        conn.send(dict(obs=O[:, m].reshape(-1, OBS_DIM), act=A[:, m].reshape(-1, ACT_DIM), logp=LP[:, m].reshape(-1),
                       adv=adv[:, m].reshape(-1), ret=ret[:, m].reshape(-1), res=res, crash=crash,
                       rew=float(R[:, m].mean())))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=12)
    ap.add_argument('--envs', type=int, default=256)
    ap.add_argument('--T', type=int, default=64)
    ap.add_argument('--iters', type=int, default=3000)
    ap.add_argument('--max_t', type=float, default=90.0)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--init', default=None, help='초기 정책 (예: ckpt/bc.pkl)')
    args = ap.parse_args()
    os.makedirs(CK, exist_ok=True)
    np.seterr(all='ignore')
    pol = Policy(OBS_DIM, ACT_DIM, seed=0)
    opt_pi = Adam(pol.pi.params + [pol.log_std], lr=args.lr)
    opt_vf = Adam(pol.vf.params, lr=args.lr * 3)
    pool = []
    it0 = 0
    if args.init:
        pol.load(pickle.load(open(args.init, 'rb'))['pol'])
        opt_pi = Adam(pol.pi.params + [pol.log_std], lr=args.lr); opt_vf = Adam(pol.vf.params, lr=args.lr * 3)
        pool = [pol.state()]
        print(f'init from {args.init}', flush=True)
    if args.resume and os.path.exists(os.path.join(CK, 'latest.pkl')):
        st = pickle.load(open(os.path.join(CK, 'latest.pkl'), 'rb'))
        pol.load(st['pol']); pool = st['pool']; it0 = st['it']
        opt_pi = Adam(pol.pi.params + [pol.log_std], lr=args.lr); opt_vf = Adam(pol.vf.params, lr=args.lr * 3)
        print(f'resume from iter {it0}, pool {len(pool)}', flush=True)
    ctx = mp.get_context('spawn')
    conns, procs = [], []
    for w in range(args.workers):
        a, b = ctx.Pipe()
        p = ctx.Process(target=worker, args=(w, args.envs, args.T, b, args.max_t), daemon=True)
        p.start(); conns.append(a); procs.append(p)
    rng = np.random.default_rng(0)
    log = open(os.path.join(HERE, 'train_log.txt'), 'a', encoding='utf-8')
    t_start = time.time(); total = 0
    for it in range(it0, args.iters):
        t0 = time.time()
        st = pol.state()
        for c in conns:
            opp = pool[rng.integers(max(0, len(pool) - 30), len(pool))] if pool else None
            c.send(dict(pol=st, opp=opp))
        outs = [c.recv() for c in conns]
        t1 = time.time()
        batch = {k: np.concatenate([o[k] for o in outs]) for k in ['obs', 'act', 'logp', 'adv', 'ret']}
        pol.norm.update(batch['obs'][rng.choice(len(batch['obs']), min(200000, len(batch['obs'])), replace=False)])
        stats = ppo_update(pol, opt_pi, opt_vf, batch, epochs=3, mb=16384, rng=rng)
        t2 = time.time()
        total += len(batch['obs'])
        res = sum(o['res'] for o in outs); crash = sum(o['crash'] for o in outs)
        def wr(k):
            n = res[k].sum()
            return f'{res[k,0]:.0f}/{res[k,1]:.0f}/{res[k,2]:.0f}' if n else '-'
        line = (f'it {it} samples {total/1e6:.2f}M  env {t1-t0:.1f}s upd {t2-t1:.1f}s  rew {np.mean([o["rew"] for o in outs]):+.4f} '
                f'| W/L/D self {wr(0)} pool {wr(1)} bot1 {wr(2)} bot2 {wr(3)} bot3 {wr(5)} fixed {wr(4)} human {wr(6)} crash {crash} '
                f'| pl {stats["pl"]:+.4f} vl {stats["vl"]:.3f} kl {stats["kl"]:+.4f} cf {stats["cf"]:.3f} std {np.exp(pol.log_std).round(2).tolist()}')
        print(line, flush=True); log.write(line + '\n'); log.flush()
        if it % 10 == 0:
            pool.append(pol.state())
            pool = pool[-60:]
        if it % 5 == 0 or it == args.iters - 1:
            pickle.dump(dict(pol=pol.state(), pool=pool, it=it + 1), open(os.path.join(CK, 'latest.pkl.tmp'), 'wb'))
            os.replace(os.path.join(CK, 'latest.pkl.tmp'), os.path.join(CK, 'latest.pkl'))
        if it % 50 == 0:
            pickle.dump(dict(pol=pol.state(), it=it), open(os.path.join(CK, f'pol_{it:05d}.pkl'), 'wb'))
    for c in conns:
        c.send(None)


if __name__ == '__main__':
    main()
