"""진단: 작업자 1개를 오래 돌리며 반복당 시간과 비정상 상태(NaN·비정규 수·극단값)를 기록."""
import os
os.environ['OMP_NUM_THREADS'] = '1'
import threading, time, numpy as np, torch, multiprocessing as mp, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import train2
from model import torch_modules, RunNorm
import env as envmod

ck = torch.load(os.path.join(train2.CK, 'v2_latest.pt'), weights_only=False)
Actor, Critic = torch_modules(torch); a = Actor(); a.load_state_dict(ck['actor'])
n = RunNorm(); n.mean, n.var = ck['norm']['mean'], ck['norm']['var']
ps, po = ck['pool_states'], ck['pool_order']
pool_ids = [f'pool{k}' for k in po]; ids = ['self'] + pool_ids; p = np.array([0.25] + [0.75 / len(pool_ids)] * len(pool_ids))
sp = np.array([0.5, 0.1, 0.1, 0.1, 0.2])

# 작업자 안의 env를 들여다보려고 DuelEnv 생성을 가로챔
holder = {}
_orig = envmod.DuelEnv.__init__
def _init(self, *a_, **k_):
    _orig(self, *a_, **k_); holder['env'] = self
train2.DuelEnv.__init__ = _init

c1, c2 = mp.Pipe()
th = threading.Thread(target=train2.worker, args=(0, 256, 64, c2), daemon=True); th.start()
c1.send(dict(scen_probs=sp, opp_ids=ids, opp_p=p))
msg = dict(actor=a.np_state(n), new_pool={f'pool{k}': ps[k] for k in po}, pool_keep=pool_ids, scen_probs=sp, opp_ids=ids, opp_p=p)
tiny = np.finfo(np.float64).tiny
for i in range(60):
    t = time.time(); c1.send(msg); out = c1.recv(); msg['new_pool'] = {}
    e = holder['env']; f = e.f
    bad = []
    for name, obj in (('f', f), ('env', e)):
        for k, v in vars(obj).items():
            if isinstance(v, np.ndarray) and v.dtype.kind == 'f' and v.size:
                nan = np.isnan(v).sum(); den = ((v != 0) & (np.abs(v) < tiny)).sum(); big = (np.abs(v) > 1e12).sum()
                if nan or den or big:
                    bad.append(f'{name}.{k}: nan {nan} denorm {den} big {big}')
    print(f'iter {i} {time.time() - t:5.1f}s alt min {f.pos[:, 1].min():.0f} max {f.pos[:, 1].max():.0f} V max {f.V.max():.0f} | ' + '; '.join(bad[:6]), flush=True)
