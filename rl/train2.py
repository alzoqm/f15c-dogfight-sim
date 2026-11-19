"""v2 학습: 큰 모델(쌓은 관측 + LayerNorm MLP, 중앙 가치망) + 단계별 커리큘럼 + 리그(PFSP).
- 작업 프로세스(CPU): 시뮬레이션·numpy 정책 추론. 상대는 판이 시작될 때마다 현재 분포에서 뽑음.
- 주 프로세스(GPU): 가치 계산·GAE·PPO 업데이트, 상대별 승률 추적, 시나리오 가중치·단계 전환.
단계:
  drills: 시나리오(0 전체 교전, 1 공세 마무리, 2 수세 탈출, 3 정면 머지, 4 저고도·저에너지)를 약한 것 위주로 가중해 연습.
          통과 기준을 넘거나 --drill_iters를 다 쓰면 league로.
  league: 전체 교전 위주. 상대는 셀프플레이 25% + 나머지는 PFSP(이기기 어려운 상대일수록 자주)로 과거 스냅숏·기존 정책·봇·사람 봇.
실행: python rl/train2.py --init ckpt/v2_distill.pt [--resume]"""
import argparse, os, pickle, sys, time
import multiprocessing as mp
if mp.parent_process() is not None:
    for k in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
        os.environ[k] = '1'
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import DuelEnv, OBS_DIM, ACT_DIM
from model import Stacker, NPActor, RunNorm, norm_in, OBS1, OBS_IN, CRIT_IN, STACK, GAP, HIST

HERE = os.path.dirname(os.path.abspath(__file__))
CK = os.path.join(HERE, 'ckpt')
GAMMA, LAM = 0.995, 0.95
LS_MIN = float(np.log(0.15))     # 행동 잡음 하한 (탐색이 사라져 학습이 멈추는 것 방지)
BOTS = {'bot1': 1, 'bot2': 2, 'bot3': 3, 'human': 4, 'bot5': 5, 'bot6': 6}
LEGACY = {'elite': 'ckpt/elite.pkl', 'legend61': 'ckpt/run7_it61.pkl', 'run8': 'ckpt/run8_last.pkl'}
SCEN_NAMES = ['full', 'off', 'def', 'merge', 'lowE']


# ------------------------------------------------------------------ 작업 프로세스
def _pin_working_set(min_mb=900, max_mb=2500):
    """Windows가 작업자 메모리를 계속 덜어내(작업 집합 약 140 MB) 상대 신경망 가중치를 쓸 때마다 페이지 폴트가 나서
    추론이 수십~수백 배 느려지는 문제 방지: 최소 작업 집합을 보장"""
    if os.name != 'nt':
        return
    try:
        import ctypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.SetProcessWorkingSetSizeEx.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_uint32]
        ok = k32.SetProcessWorkingSetSizeEx(k32.GetCurrentProcess(), min_mb << 20, max_mb << 20, 0x1 | 0x8)   # 최소 강제, 최대 해제
        if not ok:
            print('SetProcessWorkingSetSizeEx failed', ctypes.get_last_error(), flush=True)
    except Exception as e:
        print('working set pin failed', e, flush=True)


def worker(wid, N, T, conn):
    np.seterr(all='ignore')
    _pin_working_set()
    from nn import Policy
    env = DuelEnv(N, seed=5000 + wid, max_t=240)
    rng = np.random.default_rng(wid + 77)
    B = env.B
    legacy = {}
    for k, p in LEGACY.items():
        pol = Policy(OBS_DIM, ACT_DIM); pol.load(pickle.load(open(os.path.join(HERE, p), 'rb'))['pol']); legacy[k] = pol
    pool = {}
    opp_of = np.array(['self'] * N, dtype=object)
    msg = conn.recv()
    env.scen_probs = msg['scen_probs']

    def pick(e_idx, probs_ids, probs):
        for e in e_idx:
            o = probs_ids[rng.choice(len(probs), p=probs)]
            if env.scen[e] == 1 and rng.random() < 0.5:
                o = 'bot5'   # 공세 마무리 연습은 절반을 회피 기동 봇으로
            elif env.scen[e] == 4 and rng.random() < 0.2:
                o = 'bot6'   # 저고도 연습은 20%를 하강 유도 봇으로 (나머지는 자가 대결)
            opp_of[e] = o
            env.scripted[N + e] = BOTS.get(o, 0)

    env.reset_all()
    pick(np.arange(N), msg['opp_ids'], msg['opp_p'])
    obs = env.observe(); st = Stacker(B); st.reset(np.arange(B), obs)
    msg = conn.recv()
    while msg is not None:
        actor = NPActor(msg['actor'])
        for k, s in msg.get('new_pool', {}).items():
            pool[k] = NPActor(s)
        for k in list(pool):
            if k not in msg['pool_keep']:
                del pool[k]
        env.scen_probs = msg['scen_probs']
        ids, probs = msg['opp_ids'], msg['opp_p']
        XS = np.zeros((T, B, OBS_IN), np.float16); XO = np.zeros((T, B, OBS1), np.float16)
        A = np.zeros((T, B, ACT_DIM), np.float32); LP = np.zeros((T, B), np.float32)
        R = np.zeros((T, B), np.float32); D = np.zeros((T, B), np.float32); L = np.zeros((T, B), bool)
        tw0 = time.time(); topp = 0.0; tk = {}
        boot = []      # (t, 기체 인덱스, 가치망 입력) — 시간 제한 종료 시 마지막 상태 가치로 이어 붙임
        results = []   # (상대, 시나리오, 승, 패, 공세 획득, 지면 충돌)
        for t in range(T):
            xs = st.get()
            selfB = np.array([o == 'self' for o in opp_of])
            learn = np.concatenate([np.ones(N, bool), selfB])
            a, lp = actor.act(xs, rng)
            to0 = time.time()
            for k in set(opp_of):
                if k in legacy or k in pool:
                    tq = time.time()
                    m = np.zeros(B, bool); m[N:] = opp_of == k
                    if k in legacy:
                        a[m], _, _ = legacy[k].act(obs[m], rng, deterministic=True)
                    else:
                        a[m], _ = pool[k].act(xs[m], rng, deterministic=True)
                    e_ = tk.setdefault(k, [0.0, 0, 0]); e_[0] += time.time() - tq; e_[1] += 1; e_[2] += int(m.sum())
            topp += time.time() - to0
            XS[t] = xs; XO[t] = obs[env.opp]; A[t] = a; LP[t] = lp; L[t] = learn
            obs2, r, done, info = env.step(np.clip(a, -1, 1))
            R[t] = r
            if info['trunc'].any():
                tm = np.nonzero(info['trunc'])[0]
                buf = st.buf.copy(); buf[:, :-1] = buf[:, 1:]; buf[:, -1] = info['obs_pre']
                xpre = np.concatenate([buf[:, HIST - 1 - k * GAP] for k in range(STACK)], axis=1)
                boot.append((t, tm, np.concatenate([xpre[tm], info['obs_pre'][env.opp][tm]], 1).astype(np.float16)))
            dd = np.concatenate([done, done]); D[t] = dd
            st.push(obs2)
            if done.any():
                e = np.nonzero(done)[0]
                for k, ei in enumerate(e):
                    results.append((opp_of[ei], int(info['scen'][k]), bool(info['winA'][k]), bool(info['winB'][k]),
                                    bool(info['offA'][k]), bool(info['cause'][ei] == 2)))
                st.reset(np.concatenate([e, e + N]), obs2)
                pick(e, ids, probs)
            obs = obs2
        last = np.concatenate([st.get(), obs[env.opp]], 1).astype(np.float16)
        conn.send(dict(XS=XS, XO=XO, A=A, LP=LP, R=R, D=D, L=L, boot=boot, last=last, results=results,
                       wt=time.time() - tw0, wopp=topp, nopp=len(set(opp_of)), tk=tk))
        msg = conn.recv()


# ------------------------------------------------------------------ 주 프로세스
def main():
    import torch
    from model import torch_modules
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=12); ap.add_argument('--envs', type=int, default=256); ap.add_argument('--T', type=int, default=64)
    ap.add_argument('--iters', type=int, default=5000); ap.add_argument('--lr', type=float, default=1e-4)
    ap.add_argument('--warm', type=int, default=15, help='처음 몇 회는 가치망만 학습 (증류 정책 보존)')
    ap.add_argument('--std', type=float, default=0.0, help='>0이면 시작할 때 행동 잡음 표준편차를 이 값으로 재설정')
    ap.add_argument('--drill_iters', type=int, default=400); ap.add_argument('--init', default='ckpt/v2_distill.pt'); ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()
    dev = 'cuda'
    Actor, Critic = torch_modules(torch)
    actor, critic = Actor().to(dev), Critic().to(dev)
    norm = RunNorm()
    it0, stage, ret_scale = 0, 'drills', 1.0
    pool_states, pool_order = {}, []
    winrate = {}                # 상대별 EMA 승률(무승부 0.5)
    drill = np.full(5, 0.5)     # 시나리오별 성공률 EMA
    path_latest = os.path.join(CK, 'v2_latest.pt')
    if args.resume and os.path.exists(path_latest):
        ck = torch.load(path_latest, weights_only=False)
        actor.load_state_dict(ck['actor']); critic.load_state_dict(ck['critic'])
        norm.mean, norm.var, norm.count = ck['norm']['mean'], ck['norm']['var'], ck['norm']['count']
        it0, stage, ret_scale = ck['it'], ck['stage'], ck['ret_scale']
        pool_states, pool_order, winrate, drill = ck['pool_states'], ck['pool_order'], ck['winrate'], ck['drill']
        args.warm = 0
        print(f'resume it {it0} stage {stage} pool {len(pool_order)}', flush=True)
    else:
        ck = torch.load(os.path.join(HERE, args.init), weights_only=False)
        actor.load_state_dict(ck['actor'])
        norm.mean, norm.var, norm.count = ck['norm']['mean'], ck['norm']['var'], ck['norm']['count']
        print(f'init from {args.init}', flush=True)
    if args.std > 0:
        with torch.no_grad():
            actor.log_std.fill_(float(np.log(args.std)))
        print(f'action std reset to {args.std}', flush=True)
    opt_a = torch.optim.Adam(actor.parameters(), lr=args.lr, eps=1e-5)
    opt_c = torch.optim.Adam(critic.parameters(), lr=args.lr * 3, eps=1e-5)

    def opp_dist():
        """현재 단계의 상대 분포 (ids, probs)"""
        pool_ids = [f'pool{k}' for k in pool_order]
        if stage == 'drills':
            base = {'self': 0.35, 'elite': 0.08, 'legend61': 0.09, 'run8': 0.08, 'bot1': 0.08, 'bot3': 0.07, 'bot5': 0.10}
            if pool_ids:
                for k in pool_ids[-20:]:
                    base[k] = 0.15 / len(pool_ids[-20:])
            else:
                base['self'] += 0.15
        else:
            cands = pool_ids + list(LEGACY) + ['bot1', 'bot3', 'bot5', 'bot6']   # 사람 모방 봇은 제외 (자가 대결 중심)
            w = np.array([(1 - winrate.get(k, 0.5)) ** 2 + 0.02 for k in cands])
            base = {'self': 0.25}
            for k, x in zip(cands, w / w.sum() * 0.75):
                base[k] = x
        ids = list(base); p = np.array([base[k] for k in ids]); p = p / p.sum()
        return ids, p

    def scen_probs():
        if stage == 'drills':
            w = (1 - drill[1:]) + 0.15
            return np.concatenate([[0.3], 0.7 * w / w.sum()])
        return np.array([0.5, 0.1, 0.1, 0.1, 0.2])   # 저고도 비중 2배 (사람 상대 패배가 저고도에서 많음)

    ctx = mp.get_context('spawn')
    conns, procs = [], []
    for w in range(args.workers):
        a, b = ctx.Pipe()
        p = ctx.Process(target=worker, args=(w, args.envs, args.T, b), daemon=True)
        p.start(); conns.append(a); procs.append(p)
    sent_pool = set()
    wsub = [None] * args.workers      # 작업자별 과거 스냅숏 부분집합 (작업자당 상대 신경망 종류를 줄여 추론 비용 제한)

    def worker_dist(wi, ids, probs, it):
        pool_ids = [k for k in ids if k.startswith('pool')]
        if not pool_ids:
            return ids, probs
        pp = np.array([probs[ids.index(k)] for k in pool_ids])
        if wsub[wi] is None or it % 40 == (wi * 3) % 40 or any(k not in pool_ids for k in wsub[wi]):
            kk = min(6, len(pool_ids))
            wsub[wi] = list(np.random.default_rng(it * 100 + wi).choice(pool_ids, size=kk, replace=False, p=pp / pp.sum()))
        keep = [k for k in ids if not k.startswith('pool') or k in wsub[wi]]
        p2 = np.array([probs[ids.index(k)] for k in keep])
        sub = np.array([k.startswith('pool') for k in keep])
        if sub.any():
            p2[sub] *= pp.sum() / p2[sub].sum()   # 부분집합이 원래 과거 스냅숏 몫 전체를 나눠 가짐
        return keep, p2 / p2.sum()

    ids, probs = opp_dist()
    for wi, c in enumerate(conns):
        wids, wp = worker_dist(wi, ids, probs, it0)
        c.send(dict(scen_probs=scen_probs(), opp_ids=wids, opp_p=wp))
    log = open(os.path.join(HERE, 'train2_log.txt'), 'a', encoding='utf-8')
    total = 0
    for it in range(it0, args.iters):
        t0 = time.time()
        astate = actor.np_state(norm)
        ids, probs = opp_dist()
        newp = {f'pool{k}': pool_states[k] for k in pool_order if f'pool{k}' not in sent_pool}
        keep = [f'pool{k}' for k in pool_order]
        for wi, c in enumerate(conns):
            wids, wp = worker_dist(wi, ids, probs, it)
            c.send(dict(actor=astate, new_pool=newp, pool_keep=keep, scen_probs=scen_probs(), opp_ids=wids, opp_p=wp))
        sent_pool |= set(newp)
        outs = [c.recv() for c in conns]
        t1 = time.time()
        tkall = {}
        for o in outs:
            for k_, (tt, cc, nn_) in o['tk'].items():
                q = tkall.setdefault(k_, [0.0, 0, 0]); q[0] += tt; q[1] += cc; q[2] += nn_
        top = sorted(tkall.items(), key=lambda kv: -kv[1][0])[:4]
        with open(os.path.join(HERE, 'opp_timing.txt'), 'a', encoding='utf-8') as ft:
            ft.write(f'it {it} ' + ' | '.join(f'{k_} {v[0]:.1f}s calls {v[1]} avg_batch {v[2] / max(v[1], 1):.1f}' for k_, v in top) + chr(10))
        wt = [o['wt'] for o in outs]; wtxt = f' [작업자 {min(wt):.1f}~{max(wt):.1f}s, 상대추론 {max(o["wopp"] for o in outs):.1f}s, 상대종류 {max(o["nopp"] for o in outs)}]'
        # ---- 가치 계산 (GPU) + GAE
        allX, allA, allLP, allAdv, allRet = [], [], [], [], []
        with torch.no_grad():
            for o in outs:
                Tn, B = o['R'].shape
                xin = np.concatenate([o['XS'], o['XO']], 2).reshape(Tn * B, CRIT_IN).astype(np.float32)
                xin = torch.tensor(norm_in(xin, norm, STACK + 1), device=dev)
                V = (critic(xin) * ret_scale).reshape(Tn, B).cpu().numpy()
                lastv = (critic(torch.tensor(norm_in(o['last'].astype(np.float32), norm, STACK + 1), device=dev)) * ret_scale).cpu().numpy()
                R = o['R'].copy()
                for (t, tm, cin) in o['boot']:
                    vb = (critic(torch.tensor(norm_in(cin.astype(np.float32), norm, STACK + 1), device=dev)) * ret_scale).cpu().numpy()
                    R[t, tm] += GAMMA * vb
                adv = np.zeros_like(R); g = np.zeros(B, np.float32)
                for t in reversed(range(Tn)):
                    nv = lastv if t == Tn - 1 else V[t + 1]
                    nt = 1 - o['D'][t]
                    delta = R[t] + GAMMA * nv * nt - V[t]
                    g = delta + GAMMA * LAM * nt * g
                    adv[t] = g
                ret = adv + V
                m = o['L']
                allX.append(np.concatenate([o['XS'], o['XO']], 2)[m]); allA.append(o['A'][m]); allLP.append(o['LP'][m])
                allAdv.append(adv[m]); allRet.append(ret[m])
        X = np.concatenate(allX); Aa = np.concatenate(allA); LPo = np.concatenate(allLP); ADV = np.concatenate(allAdv); RET = np.concatenate(allRet)
        ret_scale = 0.99 * ret_scale + 0.01 * float(RET.std() + 1e-3) if it > it0 else float(RET.std() + 1e-3)
        Xg = torch.tensor(norm_in(X.astype(np.float32), norm, STACK + 1), device=dev)
        Ag = torch.tensor(Aa, device=dev); LPg = torch.tensor(LPo, device=dev)
        ADVg = torch.tensor((ADV - ADV.mean()) / (ADV.std() + 1e-8), device=dev); RETg = torch.tensor(RET / ret_scale, device=dev)
        n = len(Xg); mb = 16384; kl_sum = cf_sum = vl_sum = 0.0; nb = 0; stop = False
        train_actor = it - it0 >= args.warm or args.resume
        for ep in range(4):
            perm = torch.randperm(n, device=dev)
            for i in range(0, n, mb):
                idx = perm[i:i + mb]
                xa = Xg[idx, :OBS_IN]
                v = critic(Xg[idx]); vl = torch.nn.functional.huber_loss(v, RETg[idx], delta=5.0)   # 드문 격추·피격 큰 보상에 덜 휘둘림
                opt_c.zero_grad(); vl.backward(); torch.nn.utils.clip_grad_norm_(critic.parameters(), 1.0); opt_c.step()
                vl_sum += vl.item(); nb += 1
                if train_actor and not stop:
                    mu = actor(xa); ls = actor.log_std.clamp(LS_MIN, 0.0); std = ls.exp()
                    logp = (-0.5 * ((Ag[idx] - mu) / std) ** 2 - ls - 0.5 * np.log(2 * np.pi)).sum(-1)
                    ratio = (logp - LPg[idx]).clamp(-20, 20).exp()
                    A_ = ADVg[idx]
                    pl = -torch.min(ratio * A_, ratio.clamp(0.8, 1.2) * A_).mean()
                    opt_a.zero_grad(); pl.backward(); torch.nn.utils.clip_grad_norm_(actor.parameters(), 0.5); opt_a.step()
                    with torch.no_grad():
                        kl = (LPg[idx] - logp).mean().item(); kl_sum += kl; cf_sum += ((ratio - 1).abs() > 0.2).float().mean().item()
                    if kl > 0.03:
                        stop = True
            if stop:
                break
        with torch.no_grad():
            actor.log_std.clamp_(LS_MIN, 0.0)
        del Xg, Ag, LPg, ADVg, RETg
        t2 = time.time(); total += n
        # ---- 결과 집계: 상대별 승률, 시나리오별 성공률
        res = {}
        sc = np.zeros((5, 2))
        for o in outs:
            for (opp, s, w, l, off, gc) in o['results']:
                r = res.setdefault(opp, [0, 0, 0]); r[0 if w else (1 if l else 2)] += 1
                ok = ((not l) and (off or w)) if s == 2 else w     # 수세 탈출: 안 맞고 역전(공세 획득 또는 격추), 나머지: 승리
                sc[s] += [ok, 1]
        for k, (w, l, d) in res.items():
            if k == 'self':
                continue
            nn_ = w + l + d
            winrate[k] = 0.9 * winrate.get(k, 0.5) + 0.1 * ((w + 0.5 * d) / nn_) if nn_ else winrate.get(k, 0.5)
        for s in range(5):
            if sc[s, 1] > 0:
                drill[s] = 0.9 * drill[s] + 0.1 * sc[s, 0] / sc[s, 1]
        if stage == 'drills' and it - it0 > 30 and ((drill[1] > 0.8 and drill[2] > 0.6 and drill[3] > 0.55 and drill[4] > 0.55) or it >= args.drill_iters):
            stage = 'league'; print(f'*** stage → league at it {it}', flush=True)
        if it % 10 == 0:
            pool_order.append(it); pool_states[it] = actor.np_state(norm)
            if len(pool_order) > 40:
                old = pool_order.pop(0); pool_states.pop(old, None)
        def fmt(k):
            r = res.get(k)
            return f'{k} {r[0]}/{r[1]}/{r[2]}' if r else ''
        groups = ' '.join(x for x in [fmt(k) for k in ['self', 'elite', 'legend61', 'run8', 'bot1', 'bot3', 'bot5', 'bot6', 'human']] if x)
        poolr = np.sum([res[k] for k in res if k.startswith('pool')], axis=0) if any(k.startswith('pool') for k in res) else None
        line = (f'it {it} {stage} n {n/1e3:.0f}k env {t1-t0:.1f}s{wtxt} upd {t2-t1:.1f}s | drill ' + ' '.join(f'{SCEN_NAMES[s]} {drill[s]:.2f}' for s in range(5)) +
                f' | {groups}' + (f' pool {poolr[0]}/{poolr[1]}/{poolr[2]}' if poolr is not None else '') +
                f' | vl {vl_sum/max(nb,1):.3f} kl {kl_sum/max(nb,1):+.4f} cf {cf_sum/max(nb,1):.3f} std {actor.log_std.exp().detach().cpu().numpy().round(2).tolist()} rs {ret_scale:.2f}')
        print(line, flush=True); log.write(line + '\n'); log.flush()
        if it % 5 == 0 or it == args.iters - 1:
            ckd = dict(actor=actor.state_dict(), critic=critic.state_dict(), norm=dict(mean=norm.mean, var=norm.var, count=norm.count),
                       it=it + 1, stage=stage, ret_scale=ret_scale, pool_states=pool_states, pool_order=pool_order, winrate=winrate, drill=drill)
            torch.save(ckd, path_latest + '.tmp'); os.replace(path_latest + '.tmp', path_latest)
            if it % 50 == 0:
                torch.save(dict(actor=actor.state_dict(), norm=ckd['norm'], it=it, stage=stage), os.path.join(CK, f'v2_it{it:05d}.pt'))
    for c in conns:
        c.send(None)


if __name__ == '__main__':
    main()
