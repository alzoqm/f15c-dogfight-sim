"""0단계: 증류 — 기존 정책(교사, 관측 45)을 v2 큰 모델(쌓은 관측 180)로 옮긴다 (DAgger).
1회차는 교사가 조종하며 데이터를 모으고, 이후 회차는 학생이 조종한 상태에서 교사의 행동을 정답으로 모아 다시 학습.
실행: python rl/distill.py --teacher ckpt/run7_it61.pkl --out ckpt/v2_distill.pt"""
import argparse, os, pickle, sys, time
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import DuelEnv, OBS_DIM, ACT_DIM
from nn import Policy
from model import Stacker, NPActor, RunNorm, torch_modules, norm_in, OBS_IN, STACK

np.seterr(all='ignore')
HERE = os.path.dirname(os.path.abspath(__file__))


def load_legacy(p):
    pol = Policy(OBS_DIM, ACT_DIM); pol.load(pickle.load(open(os.path.join(HERE, p) if not os.path.isabs(p) else p, 'rb'))['pol']); return pol


def rollout_human(hb, vs, student, n, steps, seed, use_student):
    """사람 모방 봇(교사) 증류용: 청군(A)은 교사/학생, 적군(B)은 강화학습 정책(vs, v2) 70% + 봇 30% — 실제 상대(AI)와 싸우는 상태 분포"""
    env = DuelEnv(n, seed=seed, max_t=240)
    env.scen_probs = np.array([0.5, 0.1, 0.1, 0.1, 0.2])
    rng = np.random.default_rng(seed)
    bots = rng.choice([0] * 7 + [1, 3, 5], n)
    env.scripted[n:] = bots
    env.reset_all()
    obs = env.observe(); st = Stacker(env.B); st.reset(np.arange(env.B), obs)
    X, Y = [], []
    A = np.arange(n); vsm = np.concatenate([np.zeros(n, bool), bots == 0])
    for s in range(steps):
        xs = st.get()
        ta = hb.act(env, A)
        a = np.zeros((env.B, 5), np.float32)
        a[:n] = student.act(xs[:n], rng, deterministic=True)[0] if use_student else ta
        a[vsm] = vs.act(xs[vsm], rng, deterministic=True)[0]
        X.append(xs[:n].astype(np.float16)); Y.append(ta.astype(np.float32))
        obs, r, done, info = env.step(np.clip(a, -1, 1))
        st.push(obs)
        if done.any():
            e = np.nonzero(done)[0]; st.reset(np.concatenate([e, e + n]), obs)
    return np.concatenate(X), np.concatenate(Y)


def rollout(teacher, student, n, steps, seed, use_student):
    """정책이 조종하는 기체의 (쌓은 관측, 교사 행동)을 모음. 상대: 절반 교사/학생 셀프플레이, 절반 봇."""
    env = DuelEnv(n, seed=seed, max_t=240)
    env.scen_probs = np.array([0.4, 0.15, 0.15, 0.15, 0.15])
    rng = np.random.default_rng(seed)
    bots = rng.choice([0, 0, 0, 1, 3, 5, 4], n)          # 0 = 정책 셀프플레이
    env.scripted[n:] = bots
    env.reset_all()
    ctrl = np.concatenate([np.ones(n, bool), bots == 0])
    obs = env.observe(); st = Stacker(env.B); st.reset(np.arange(env.B), obs)
    X, Y = [], []
    for s in range(steps):
        xs = st.get()
        ta, _, _ = teacher.act(obs, rng, deterministic=True)
        if use_student:
            a, _ = student.act(xs, rng, deterministic=True)
        else:
            a = ta
        X.append(xs[ctrl].astype(np.float16)); Y.append(ta[ctrl].astype(np.float32))
        obs, r, done, info = env.step(np.clip(a, -1, 1))
        st.push(obs)
        if done.any():
            e = np.nonzero(done)[0]; st.reset(np.concatenate([e, e + n]), obs)
    return np.concatenate(X), np.concatenate(Y)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--teacher', default='ckpt/run7_it61.pkl'); ap.add_argument('--out', default='ckpt/v2_distill.pt')
    ap.add_argument('--vs', default='ckpt/legend_v2.pt', help='teacher=humanbot일 때 상대 정책(v2)')
    ap.add_argument('--rounds', type=int, default=4); ap.add_argument('--n', type=int, default=512); ap.add_argument('--steps', type=int, default=800)
    a = ap.parse_args()
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    Actor, Critic = torch_modules(torch)
    human = a.teacher == 'humanbot'
    if human:
        from humanbot import HumanBot
        from export2 import load_np_state
        teacher = HumanBot(); vs = NPActor(load_np_state(os.path.join(HERE, a.vs))[0])
    else:
        teacher = load_legacy(a.teacher)
    actor = Actor().to(dev)
    with torch.no_grad():
        actor.log_std.copy_(torch.full((5,), float(np.log(0.2))) if human else torch.tensor(teacher.log_std))
    norm = RunNorm()
    Xall, Yall = [], []
    for r in range(a.rounds):
        t0 = time.time()
        student = NPActor(actor.np_state(norm)) if r > 0 else None
        if human:
            X, Y = rollout_human(teacher, vs, student, a.n, a.steps, seed=200 + r, use_student=r > 0)
        else:
            X, Y = rollout(teacher, student, a.n, a.steps, seed=100 + r, use_student=r > 0)
        if r == 0:   # 관측 정규화 통계는 첫 회차(교사 조종) 데이터로 고정
            norm.update(X[:, :45].astype(np.float64))
        Xall.append(X); Yall.append(Y)
        Xc = np.concatenate(Xall); Yc = np.concatenate(Yall)
        Xt = torch.tensor(norm_in(Xc.astype(np.float32), norm, STACK), device=dev); Yt = torch.tensor(Yc, device=dev)
        opt = torch.optim.Adam(actor.parameters(), lr=1e-3)
        nb = len(Xt); bs = 4096; epochs = 6 if r < a.rounds - 1 else 12
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs * (nb // bs + 1))
        w = torch.tensor([1, 1, 1, 0.5, 0.5], device=dev)
        for ep in range(epochs):
            perm = torch.randperm(nb, device=dev); tot = 0.0
            for i in range(0, nb, bs):
                idx = perm[i:i + bs]
                loss = (((actor(Xt[idx]) - Yt[idx]) ** 2) * w).mean()
                opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(actor.parameters(), 1.0); opt.step(); sched.step()
                tot += loss.item() * len(idx)
            print(f'round {r} epoch {ep} loss {tot / nb:.5f}  samples {nb}', flush=True)
        del Xt, Yt
        print(f'round {r} done in {time.time() - t0:.0f}s', flush=True)
        torch.save(dict(actor=actor.state_dict(), norm=dict(mean=norm.mean, var=norm.var, count=norm.count), teacher=a.teacher),
                   os.path.join(HERE, a.out))
    print('saved', a.out)


if __name__ == '__main__':
    main()
