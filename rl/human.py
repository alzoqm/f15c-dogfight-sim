"""사람 대결 기록 요약 (src/recorder.js가 rl/data/human/에 저장한 1:1 BFM 판).
실행: python rl/human.py
각 판: 난이도, 결과(human=사람 승 / ai / both / abort), 교전 시간, 사람 피해, AI 피해, 정면 대치 시간 비율."""
import glob, json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def load_all():
    out = []
    for f in sorted(glob.glob(os.path.join(HERE, 'data', 'human', '*.json'))):
        with open(f, encoding='utf-8') as fp:
            d = json.load(fp)
        d['file'] = os.path.basename(f)
        out.append(d)
    return out


def arrays(d):
    """프레임 목록 → numpy 배열 (p, e: [N,19], c: [N,4], t, fight 여부)."""
    F = d['frames']
    return dict(t=np.array([f['t'] for f in F]), ph=np.array([f['ph'] for f in F], bool),
                p=np.array([f['p'] for f in F]), e=np.array([f['e'] for f in F]), c=np.array([f['c'] for f in F]))


def head_on_share(a):
    """교전 중 서로 기수를 마주 본 시간 비율 (거리 1.5 km 이내, 양쪽 모두 상대가 기수 30° 이내)."""
    m = a['ph']
    if not m.any():
        return 0.0
    p, e = a['p'][m], a['e'][m]
    los = e[:, :3] - p[:, :3]; R = np.linalg.norm(los, axis=1) + 1e-9
    vp = p[:, 3:6] / (np.linalg.norm(p[:, 3:6], axis=1, keepdims=True) + 1e-9)
    ve = e[:, 3:6] / (np.linalg.norm(e[:, 3:6], axis=1, keepdims=True) + 1e-9)
    ata_p = np.arccos(np.clip((vp * los).sum(1) / R, -1, 1))
    ata_e = np.arccos(np.clip(-(ve * los).sum(1) / R, -1, 1))
    return float(((R < 1500) & (ata_p < 0.52) & (ata_e < 0.52)).mean())


if __name__ == '__main__':
    games = load_all()
    if not games:
        print('기록 없음: 게임에서 1:1 BFM을 플레이하면 rl/data/human/에 저장됩니다.')
    tally = {}
    for d in games:
        m, a = d['meta'], arrays(d)
        hp_dmg = 100 - a['p'][-1, 10]; ai_dmg = 100 - a['e'][-1, 10]
        print(f"{d['file']:52s} {m['difficulty']:8s} {m['result']:6s} 교전 {m['fightT']:5.1f}s "
              f"사람 피해 {hp_dmg:5.0f} AI 피해 {ai_dmg:5.0f} 정면 대치 {head_on_share(a):.0%}")
        k = tally.setdefault(m['difficulty'], [0, 0, 0])
        k[0 if m['result'] == 'human' else 1 if m['result'] in ('ai', 'both') else 2] += 1
    for k, (w, l, o) in tally.items():
        print(f'{k}: 사람 {w}승 {l}패, 중단 {o}')
