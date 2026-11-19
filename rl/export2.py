"""v2 정책(torch 체크포인트)을 브라우저용 JSON(src/<이름>_policy.json, arch 'v2')으로 내보내기.
실행: python rl/export2.py ckpt/v2_latest.pt [legend | elite | cand]"""
import base64, json, os, sys
import numpy as np
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import torch_modules, RunNorm, STACK, GAP, ACT

HERE = os.path.dirname(os.path.abspath(__file__))


def load_np_state(path):
    Actor, _ = torch_modules(torch)
    ck = torch.load(path, weights_only=False, map_location='cpu')
    a = Actor(); a.load_state_dict(ck['actor'])
    n = RunNorm(); n.mean, n.var = ck['norm']['mean'], ck['norm']['var']
    return a.np_state(n), ck


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'ckpt', 'v2_latest.pt')
    name = sys.argv[2] if len(sys.argv) > 2 else 'cand'
    st, ck = load_np_state(src)
    enc = lambda x: base64.b64encode(np.asarray(x, np.float32).tobytes()).decode()
    layers = []
    for i, (W, b) in enumerate(zip(st['W'], st['b'])):
        L = dict(shape=list(W.shape), W=enc(W), b=enc(b))
        if i < len(st['g']):
            L['g'] = enc(st['g'][i]); L['beta'] = enc(st['beta'][i])
        layers.append(L)
    out = dict(arch='v2', stack=STACK, gap=GAP, act_dim=ACT, mean=st['mean'].tolist(), var=st['var'].tolist(), layers=layers,
               info=f"v2 {ck.get('stage', 'distill')} it {ck.get('it', 0)}")
    dst = os.path.join(HERE, '..', 'src', f'{name}_policy.json')
    json.dump(out, open(dst, 'w'))
    print('wrote', os.path.normpath(dst), os.path.getsize(dst) // 1024, 'KB', out['info'])
