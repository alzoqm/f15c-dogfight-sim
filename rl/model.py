"""v2 모델: 관측 쌓기(최근 0.9초) + LayerNorm·SiLU MLP 정책, 상대 관측까지 보는 중앙 가치망.
- 작업 프로세스·평가·브라우저는 numpy(JS) 정책 순전파만 쓰고, 학습(GPU)은 torch 모듈을 쓴다.
- 정책 입력: [지금, 0.3초 전, 0.6초 전, 0.9초 전] 관측(각 45) = 180
- 가치망 입력: 정책 입력 180 + 상대의 현재 관측 45 = 225"""
import numpy as np

OBS1 = 45
STACK, GAP = 4, 3                 # 관측 4개, 결정 3번(0.3초) 간격
HIST = (STACK - 1) * GAP + 1      # 보관할 과거 관측 수 (10)
OBS_IN = OBS1 * STACK
CRIT_IN = OBS_IN + OBS1
ACT = 5
HID = (512, 512, 256)
LN_EPS = 1e-5


class Stacker:
    """기체별 관측 기록 (B, HIST, 45) → 쌓은 정책 입력 (B, 180). 판이 새로 시작된 기체는 현재 관측으로 채움."""

    def __init__(self, B):
        self.buf = np.zeros((B, HIST, OBS1), np.float32)

    def reset(self, idx, obs):
        self.buf[idx] = obs[idx][:, None, :]

    def push(self, obs):
        self.buf[:, :-1] = self.buf[:, 1:]
        self.buf[:, -1] = obs

    def get(self):
        # 최신이 앞: buf[-1], buf[-1-GAP], ...
        return np.concatenate([self.buf[:, HIST - 1 - k * GAP] for k in range(STACK)], axis=1)


def _ln(h, g, b):
    m = h.mean(-1, keepdims=True); v = h.var(-1, keepdims=True)
    return (h - m) / np.sqrt(v + LN_EPS) * g + b


def _silu(h):
    return h / (1 + np.exp(-np.clip(h, -30, 30)))


class NPActor:
    """numpy 정책 순전파. st: dict(W=[...], b=[...], g=[...], beta=[...], mean(45), var(45), log_std(5))"""

    def __init__(self, st):
        self.W = [np.asarray(w, np.float32) for w in st['W']]; self.b = [np.asarray(x, np.float32) for x in st['b']]
        self.g = [np.asarray(x, np.float32) for x in st['g']]; self.beta = [np.asarray(x, np.float32) for x in st['beta']]
        mean = np.asarray(st['mean'], np.float32); var = np.asarray(st['var'], np.float32)
        self.mean = np.tile(mean, STACK); self.isd = 1 / np.sqrt(np.tile(var, STACK) + 1e-8)
        self.log_std = np.asarray(st['log_std'], np.float32)

    def mu(self, x):
        h = np.clip((x - self.mean) * self.isd, -10, 10)
        for i in range(len(self.W) - 1):
            h = _silu(_ln(h @ self.W[i] + self.b[i], self.g[i], self.beta[i]))
        return h @ self.W[-1] + self.b[-1]

    def act(self, x, rng, deterministic=False):
        mu = self.mu(x)
        std = np.exp(self.log_std)
        a = mu if deterministic else mu + std * rng.standard_normal(mu.shape).astype(np.float32)
        logp = (-0.5 * ((a - mu) / std) ** 2 - self.log_std - 0.5 * np.log(2 * np.pi)).sum(-1)
        return a.astype(np.float32), logp.astype(np.float32)


class RunNorm:
    """관측 1프레임(45) 기준 이동 평균·분산 (쌓은 입력·가치망 입력에 같은 값을 반복 적용)."""

    def __init__(self):
        self.mean = np.zeros(OBS1, np.float64); self.var = np.ones(OBS1, np.float64); self.count = 1e-4

    def update(self, x):
        bm, bv, bc = x.mean(0), x.var(0), len(x)
        d = bm - self.mean; tot = self.count + bc
        self.mean = self.mean + d * bc / tot
        self.var = (self.var * self.count + bv * bc + d ** 2 * self.count * bc / tot) / tot
        self.count = tot


def torch_modules(torch):
    nn = torch.nn

    class Net(nn.Module):
        def __init__(self, din, dout, out_gain):
            super().__init__()
            dims = (din, *HID)
            self.lin = nn.ModuleList([nn.Linear(dims[i], dims[i + 1]) for i in range(len(HID))])
            self.ln = nn.ModuleList([nn.LayerNorm(d, eps=LN_EPS) for d in HID])
            self.out = nn.Linear(HID[-1], dout)
            for l in self.lin:
                nn.init.orthogonal_(l.weight, gain=np.sqrt(2)); nn.init.zeros_(l.bias)
            nn.init.orthogonal_(self.out.weight, gain=out_gain); nn.init.zeros_(self.out.bias)

        def forward(self, x):
            for l, n in zip(self.lin, self.ln):
                x = torch.nn.functional.silu(n(l(x)))
            return self.out(x)

    class Actor(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = Net(OBS_IN, ACT, 0.01)
            self.log_std = nn.Parameter(torch.full((ACT,), -1.0))

        def forward(self, x):
            return self.net(x)

        def np_state(self, norm):
            n = self.net
            return dict(W=[l.weight.detach().cpu().numpy().T.copy() for l in n.lin] + [n.out.weight.detach().cpu().numpy().T.copy()],
                        b=[l.bias.detach().cpu().numpy().copy() for l in n.lin] + [n.out.bias.detach().cpu().numpy().copy()],
                        g=[x.weight.detach().cpu().numpy().copy() for x in n.ln], beta=[x.bias.detach().cpu().numpy().copy() for x in n.ln],
                        mean=norm.mean.astype(np.float32), var=norm.var.astype(np.float32),
                        log_std=self.log_std.detach().cpu().numpy().copy())

    class Critic(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = Net(CRIT_IN, 1, 1.0)

        def forward(self, x):
            return self.net(x)[:, 0]

    return Actor, Critic


def norm_in(x, norm, k):
    """numpy 입력 정규화 (k = 반복 프레임 수: 정책 4, 가치망 5)"""
    m = np.tile(norm.mean, k).astype(np.float32); s = (1 / np.sqrt(np.tile(norm.var, k) + 1e-8)).astype(np.float32)
    return np.clip((x - m) * s, -10, 10)
