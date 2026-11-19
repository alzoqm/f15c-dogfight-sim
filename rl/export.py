"""학습된 정책(ckpt/*.pkl)을 브라우저용 JSON(src/<이름>_policy.json)으로 내보내기.
실행: python rl/export.py [ckpt 파일] [이름: elite | legend | cand(시험용)] """
import base64, json, os, pickle, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'ckpt', 'latest.pkl')
st = pickle.load(open(src, 'rb'))
pol = st['pol']
pi = pol['pi']
layers = []
for i in range(0, len(pi), 2):
    W, b = pi[i].astype(np.float32), pi[i + 1].astype(np.float32)
    layers.append(dict(shape=list(W.shape), W=base64.b64encode(W.tobytes()).decode(), b=base64.b64encode(b.tobytes()).decode()))
out = dict(obs_dim=int(pi[0].shape[0]), act_dim=int(pi[-1].shape[0]), mean=pol['mean'].tolist(), var=pol['var'].tolist(), layers=layers,
           info=f'PPO self-play, iter {st.get("it")}')
name = sys.argv[2] if len(sys.argv) > 2 else 'legend'
dst = os.path.join(HERE, '..', 'src', f'{name}_policy.json')
json.dump(out, open(dst, 'w'))
print('wrote', os.path.normpath(dst), os.path.getsize(dst) // 1024, 'KB', out['info'])
