"""numpy 전용 MLP + Adam + PPO 손실의 수동 역전파 (외부 딥러닝 라이브러리 없이)"""
import numpy as np


class MLP:
    """tanh 은닉층 MLP. params: [W0, b0, W1, b1, ...]"""

    def __init__(self, sizes, rng, out_scale=1.0):
        self.params = []
        for i in range(len(sizes) - 1):
            fan_in = sizes[i]
            W = rng.standard_normal((sizes[i], sizes[i + 1])).astype(np.float32) * np.sqrt(1.0 / fan_in)
            if i == len(sizes) - 2:
                W *= out_scale
            self.params += [W, np.zeros(sizes[i + 1], np.float32)]

    def forward(self, x, cache=False):
        hs = [x]
        h = x
        n = len(self.params) // 2
        for i in range(n):
            W, b = self.params[2 * i], self.params[2 * i + 1]
            h = h @ W + b
            if i < n - 1:
                h = np.tanh(h)
            hs.append(h)
        if cache:
            self._hs = hs
        return h

    def backward(self, gout):
        """forward(cache=True) 직후 호출. 반환: params와 같은 순서의 기울기"""
        hs = self._hs
        n = len(self.params) // 2
        grads = [None] * len(self.params)
        g = gout
        for i in reversed(range(n)):
            W = self.params[2 * i]
            grads[2 * i] = hs[i].T @ g
            grads[2 * i + 1] = g.sum(axis=0)
            if i > 0:
                g = (g @ W.T) * (1 - hs[i] ** 2)
        return grads


class Adam:
    def __init__(self, params, lr=3e-4, b1=0.9, b2=0.999, eps=1e-8):
        self.lr, self.b1, self.b2, self.eps = lr, b1, b2, eps
        self.m = [np.zeros_like(p) for p in params]
        self.v = [np.zeros_like(p) for p in params]
        self.t = 0

    def step(self, params, grads, max_norm=0.5):
        gn = np.sqrt(sum(float((g.astype(np.float64) ** 2).sum()) for g in grads))
        sc = min(1.0, max_norm / (gn + 1e-8))
        self.t += 1
        for p, g, m, v in zip(params, grads, self.m, self.v):
            g = g * sc
            m *= self.b1; m += (1 - self.b1) * g
            v *= self.b2; v += (1 - self.b2) * g * g
            mh = m / (1 - self.b1 ** self.t)
            vh = v / (1 - self.b2 ** self.t)
            p -= (self.lr * mh / (np.sqrt(vh) + self.eps)).astype(p.dtype)
        return gn


class RunningNorm:
    def __init__(self, dim):
        self.mean = np.zeros(dim, np.float64)
        self.var = np.ones(dim, np.float64)
        self.count = 1e-4

    def update(self, x):
        bm, bv, bc = x.mean(0), x.var(0), x.shape[0]
        d = bm - self.mean
        tot = self.count + bc
        self.mean = self.mean + d * bc / tot
        self.var = (self.var * self.count + bv * bc + d * d * self.count * bc / tot) / tot
        self.count = tot

    def __call__(self, x):
        return np.clip((x - self.mean) / np.sqrt(self.var + 1e-8), -10, 10).astype(np.float32)


class Policy:
    """가우시안 정책 + 가치 함수 (분리된 MLP)"""

    def __init__(self, obs_dim, act_dim, hidden=(256, 256), seed=0):
        rng = np.random.default_rng(seed)
        self.pi = MLP([obs_dim, *hidden, act_dim], rng, out_scale=0.01)
        self.vf = MLP([obs_dim, *hidden, 1], rng, out_scale=1.0)
        self.log_std = np.full(act_dim, -0.5, np.float32)
        self.norm = RunningNorm(obs_dim)

    def state(self):
        return dict(pi=[p.copy() for p in self.pi.params], vf=[p.copy() for p in self.vf.params], log_std=self.log_std.copy(),
                    mean=self.norm.mean.copy(), var=self.norm.var.copy(), count=self.norm.count)

    def load(self, st):
        self.pi.params = [p.copy() for p in st['pi']]
        self.vf.params = [p.copy() for p in st['vf']]
        self.log_std = st['log_std'].copy()
        self.norm.mean, self.norm.var, self.norm.count = st['mean'].copy(), st['var'].copy(), st['count']

    def act(self, obs, rng, deterministic=False):
        x = self.norm(obs)
        mu = self.pi.forward(x)
        std = np.exp(self.log_std)
        a = mu if deterministic else mu + std * rng.standard_normal(mu.shape).astype(np.float32)
        logp = (-0.5 * ((a - mu) / std) ** 2 - self.log_std - 0.5 * np.log(2 * np.pi)).sum(-1)
        v = self.vf.forward(x)[:, 0]
        return a, logp.astype(np.float32), v.astype(np.float32)

    def value(self, obs):
        return self.vf.forward(self.norm(obs))[:, 0]


def ppo_update(pol, opt_pi, opt_vf, batch, epochs=4, mb=8192, clip=0.2, ent_coef=0.0005, rng=None):
    obs, act, logp_old, adv, ret = batch['obs'], batch['act'], batch['logp'], batch['adv'], batch['ret']
    x_all = pol.norm(obs)
    n = len(obs)
    adv = (adv - adv.mean()) / (adv.std() + 1e-8)
    stats = dict(pl=0, vl=0, kl=0, cf=0, ent=0, k=0)
    for ep in range(epochs):
        perm = rng.permutation(n)
        for s0 in range(0, n, mb):
            idx = perm[s0:s0 + mb]
            x, a, lo, A, R = x_all[idx], act[idx], logp_old[idx], adv[idx], ret[idx]
            m = len(idx)
            # --- 정책
            mu = pol.pi.forward(x, cache=True)
            ls = pol.log_std
            std = np.exp(ls)
            z = (a - mu) / std
            logp = (-0.5 * z ** 2 - ls - 0.5 * np.log(2 * np.pi)).sum(-1)
            ratio = np.exp(np.clip(logp - lo, -20, 20))
            s1 = ratio * A
            s2 = np.clip(ratio, 1 - clip, 1 + clip) * A
            use1 = s1 <= s2           # min이 s1인 곳에서만 기울기
            # L = -mean(min(s1, s2)) - ent*sum(ls)
            dL_dlogp = np.where(use1, -A * ratio, 0.0) / m
            dlogp_dmu = z / std
            g_mu = (dL_dlogp[:, None] * dlogp_dmu).astype(np.float32)
            g_ls = (dL_dlogp[:, None] * (z ** 2 - 1)).sum(0) - ent_coef
            grads = pol.pi.backward(g_mu)
            opt_pi.step(pol.pi.params + [pol.log_std], grads + [g_ls.astype(np.float32)])
            np.clip(pol.log_std, -2.5, 0.5, out=pol.log_std)
            # --- 가치
            v = pol.vf.forward(x, cache=True)[:, 0]
            gv = ((v - R) / m)[:, None].astype(np.float32)
            gvs = pol.vf.backward(gv)
            opt_vf.step(pol.vf.params, gvs, max_norm=5.0)
            stats['pl'] += float(-np.minimum(s1, s2).mean()); stats['vl'] += float(((v - R) ** 2).mean())
            stats['kl'] += float((lo - logp).mean()); stats['cf'] += float((np.abs(ratio - 1) > clip).mean())
            stats['k'] += 1
    k = max(stats.pop('k'), 1)
    return {kk: vv / k for kk, vv in stats.items()}
