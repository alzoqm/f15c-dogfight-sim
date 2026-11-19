"""사람 모방 봇: 사람 대결 기록(rl/data/human/*.json)에서 플레이어의 기동을 모방 학습한 작은 MLP.
강화학습 정책의 관측 중 일부(각속도·엔진 상태)는 기록에 없으므로, 기록과 시뮬레이터 양쪽에서 똑같이 계산되는
기하·에너지 특징만 입력으로 쓴다. 출력은 정책과 같은 행동 공간(양력벡터 방향 cos·sin, G, 스로틀, 기총 추적).
학습: python rl/humanbot.py  → rl/ckpt/humanbot.pkl"""
import glob, json, os, pickle, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import body_axes
from sim import NZ_MAX
from nn import MLP, Adam

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT = os.path.join(HERE, 'ckpt', 'humanbot.pkl')
G0 = 9.80665
LEAD_S = 3          # 조종 지연 보정: 0.3초 뒤에 실현된 양력 방향·G를 이번 결정의 행동으로 본다


def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def _dot(a, b):
    return (a * b).sum(-1)


def feats(pos, vel, quat, alpha, nz, hp, posO, velO, quatO, nzO, hpO):
    """(N,3)… 배열 → (N, 30) 특징. 시뮬레이터와 기록 양쪽에서 같은 함수로 계산."""
    V = np.linalg.norm(vel, axis=1); VO = np.linalg.norm(velO, axis=1)
    u = _unit(vel); uo = _unit(velO)
    rt = np.cross(u, np.array([0, 1.0, 0])); rtn = np.linalg.norm(rt, axis=1, keepdims=True)
    rt = np.where(rtn > 1e-3, rt / np.maximum(rtn, 1e-9), np.array([1.0, 0, 0]))
    lu = np.cross(rt, u)
    fr = lambda v: np.stack([_dot(v, u), _dot(v, rt), _dot(v, lu)], -1)
    fwd, up, _ = body_axes(quat); fwdO, upO, _ = body_axes(quatO)
    los = posO - pos; R = np.linalg.norm(los, axis=1); lu_ = los / np.maximum(R, 1e-9)[:, None]
    ata = _dot(fwd, lu_); his_ata = _dot(fwdO, -lu_); aa = _dot(uo, lu_)   # aa: 상대 속도와 시선의 코사인(1 = 내가 꼬리 뒤)
    Vc = -_dot(velO - vel, lu_)
    gam = np.arcsin(np.clip(u[:, 1], -1, 1))
    E = pos[:, 1] + V ** 2 / (2 * G0); EO = posO[:, 1] + VO ** 2 / (2 * G0)
    return np.concatenate([
        (V / 250 - 1)[:, None], (pos[:, 1] / 4000 - 1)[:, None], np.sin(gam)[:, None],
        _dot(up, lu)[:, None], _dot(up, rt)[:, None], (alpha / 0.3)[:, None], (nz / 5 - 0.5)[:, None],
        fr(lu_), (np.log(np.maximum(R, 50)) - 7)[:, None], fr(velO - vel) / 200, (Vc / 200)[:, None],
        ata[:, None], aa[:, None], his_ata[:, None], fr(uo), fr(upO),
        (nzO / 5 - 0.5)[:, None], (VO / 250 - 1)[:, None], ((posO[:, 1] - pos[:, 1]) / 1000)[:, None], ((EO - E) / 1000)[:, None],
        (hp / 100)[:, None], (hpO / 100)[:, None],
    ], axis=1).astype(np.float32)


def actions(pos, vel, quat, nz, thr, sb, posO, velO):
    """기록된 상태 → 정책 행동 공간 (env.apply_actions의 역변환)."""
    u = _unit(vel); los = posO - pos; R = np.linalg.norm(los, axis=1)
    ref = los - u * _dot(los, u)[:, None]; refn = np.linalg.norm(ref, axis=1)
    upP = np.array([0, 1.0, 0]) - u * u[:, 1:2]
    ref = np.where((refn > 0.05)[:, None], ref / np.maximum(refn, 1e-9)[:, None], _unit(upP))
    side = np.cross(u, ref)
    fwd, up, _ = body_axes(quat)
    l = _unit(up - u * _dot(up, u)[:, None])
    ang = np.arctan2(_dot(l, side), _dot(l, ref))
    g = np.clip(2 * (nz + 1) / (NZ_MAX + 1) - 1, -1, 1)
    a3 = np.where(sb > 0.5, -1.0, np.clip(2 * thr - 1, -0.8, 1))
    ata = np.arccos(np.clip(_dot(fwd, los / np.maximum(R, 1e-9)[:, None]), -1, 1))
    track = np.where((R < 1200) & (ata < np.radians(8)), 1.0, -1.0)
    return np.stack([np.cos(ang), np.sin(ang), g, a3, track], 1).astype(np.float32)


def dataset():
    X, Y = [], []
    for f in sorted(glob.glob(os.path.join(HERE, 'data', 'human', '*.json'))):
        with open(f, encoding='utf-8') as fp:
            d = json.load(fp)
        F = d['frames']
        P = np.array([x['p'] for x in F], np.float64); E = np.array([x['e'] for x in F], np.float64)
        ph = np.array([x['ph'] for x in F], bool)
        alive = (P[:, 10] > 0) & (E[:, 10] > 0) & (P[:, 1] > 30)
        n = len(F) - LEAD_S
        i = np.arange(n); j = i + LEAD_S
        m = ph[:n] & alive[j]
        x = feats(P[i, :3], P[i, 3:6], P[i, 6:10], P[i, 13], P[i, 14], P[i, 10], E[i, :3], E[i, 3:6], E[i, 6:10], E[i, 14], E[i, 10])
        y = actions(P[j, :3], P[j, 3:6], P[j, 6:10], P[j, 14], P[i, 15], P[i, 16], E[j, :3], E[j, 3:6])
        X.append(x[m]); Y.append(y[m])
    return np.concatenate(X), np.concatenate(Y)


class HumanBot:
    def __init__(self, path=CKPT):
        st = pickle.load(open(path, 'rb'))
        self.net = MLP([st['mu'].shape[0], 64, 64, 5], np.random.default_rng(0)); self.net.params = st['params']
        self.mu, self.sd = st['mu'], st['sd']

    def act_xy(self, x):
        y = self.net.forward((x - self.mu) / self.sd)
        y[:, 4] = np.where(y[:, 4] > 0, 1.0, -1.0)
        return np.clip(y, -1, 1)

    def act(self, env, idx):
        """env: DuelEnv, idx: 사람 봇이 조종하는 기체 인덱스 배열 → (len(idx), 5) 행동."""
        f = env.f; o = env.opp[idx]
        x = feats(f.pos[idx], f.vel[idx], f.quat[idx], f.alpha[idx], f.nz[idx], env.hp[idx],
                  f.pos[o], f.vel[o], f.quat[o], f.nz[o], env.hp[o])
        return self.act_xy(x)


def train(epochs=400, seed=0):
    X, Y = dataset()
    rng = np.random.default_rng(seed)
    # 좌우 대칭 보강: 오른쪽 성분(특징의 rt 축, 행동의 sin)을 뒤집은 복사본
    Xm = X.copy(); Ym = Y.copy()
    for k in (4, 8, 12, 19, 22): Xm[:, k] *= -1   # bank_s, los·rt, rel_v·rt, uo·rt, upO·rt
    Ym[:, 1] *= -1
    X = np.concatenate([X, Xm]); Y = np.concatenate([Y, Ym])
    mu = X.mean(0); sd = X.std(0) + 1e-3
    Xn = (X - mu) / sd
    perm = rng.permutation(len(X)); nv = len(X) // 10
    va, tr = perm[:nv], perm[nv:]
    net = MLP([X.shape[1], 64, 64, 5], rng, out_scale=0.1); opt = Adam(net.params, lr=1e-3)
    w = np.array([1, 1, 1, 0.5, 0.3], np.float32)
    for ep in range(epochs):
        idx = rng.permutation(tr)
        for b in range(0, len(idx), 512):
            bi = idx[b:b + 512]
            out = net.forward(Xn[bi], cache=True)
            g = 2 * (out - Y[bi]) * w / len(bi)
            opt.step(net.params, net.backward(g), max_norm=5.0)
        if ep % 100 == 0 or ep == epochs - 1:
            lv = (((net.forward(Xn[va]) - Y[va]) ** 2) * w).mean(); lt = (((net.forward(Xn[tr[:5000]]) - Y[tr[:5000]]) ** 2) * w).mean()
            print(f'ep {ep} train {lt:.4f} val {lv:.4f}  (표본 {len(X)}, 기준 분산 {(Y[va].var(0) * w).mean():.4f})', flush=True)
    pickle.dump(dict(params=net.params, mu=mu.astype(np.float32), sd=sd.astype(np.float32), n=len(X)), open(CKPT, 'wb'))
    print('saved', CKPT)


if __name__ == '__main__':
    train()
