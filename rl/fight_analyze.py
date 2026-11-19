"""사람 대결 기록 상세 분석 (rl/data/human/*.json).
실행: python rl/fight_analyze.py [파일 일부 이름] [--tl 5]
판마다: 공세/수세 시간, 에너지(속도·고도), G 사용, 피격 순간(거리·각도), AI 기동 모드 비율, 시간대별 흐름."""
import argparse, glob, json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
G0 = 9.80665


def nose(q):
    """three.js 쿼터니언(xyzw)으로 기수 방향(로컬 -Z) 계산."""
    x, y, z, w = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    return -np.stack([2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)], 1)


def geom(A, B):
    """A 기준: 거리, A 기수-표적 각(ATA), 표적 꼬리 기준 각(AA: 0=A가 B 꼬리 뒤, 180=정면)."""
    los = B[:, :3] - A[:, :3]; R = np.linalg.norm(los, axis=1) + 1e-9; u = los / R[:, None]
    na = nose(A[:, 6:10]); vb = B[:, 3:6] / (np.linalg.norm(B[:, 3:6], axis=1, keepdims=True) + 1e-9)
    ata = np.degrees(np.arccos(np.clip((na * u).sum(1), -1, 1)))
    aa = np.degrees(np.arccos(np.clip(-(vb * -u).sum(1), -1, 1)))   # B 속도 방향과 B→A 시선의 각의 보각
    aa = 180 - np.degrees(np.arccos(np.clip((vb * -u).sum(1), -1, 1)))
    return R, ata, aa


def analyse(d, tl):
    m = d['meta']; F = d['frames']
    t = np.array([f['t'] for f in F]); ph = np.array([f['ph'] for f in F], bool)
    P = np.array([f['p'] for f in F]); E = np.array([f['e'] for f in F]); C = np.array([f['c'] for f in F])
    mode = np.array([f['m'] for f in F])
    R, ata_p, aa_e = geom(P, E)            # 사람 기준
    _, ata_e, aa_p = geom(E, P)            # AI 기준
    i0 = np.argmax(ph) if ph.any() else 0
    sl = slice(i0, len(t))
    # 공세: 내 기수가 상대 쪽 45° 이내 & 상대 꼬리 쪽(AA<60) & 3 km 이내
    off_p = (ata_p < 45) & (aa_e < 60) & (R < 3000)
    off_e = (ata_e < 45) & (aa_p < 60) & (R < 3000)
    ho = (ata_p < 30) & (ata_e < 30) & (R < 2000)
    Eh = lambda X: X[:, 1] + X[:, 11] ** 2 / (2 * G0)
    out = []
    out.append(f"== {d['file']}  결과 {m['result']}  교전 {m['fightT']}s  사람 {m['crash']['human'] or '-'} / AI {m['crash']['ai'] or '-'}")
    n = max(1, len(t) - i0)
    out.append(f"  공세 시간: 사람 {off_p[sl].mean():.0%}  AI {off_e[sl].mean():.0%}  정면 대치 {ho[sl].mean():.0%}")
    out.append(f"  평균 속도 사람 {P[sl, 11].mean() * 1.944:.0f} kt / AI {E[sl, 11].mean() * 1.944:.0f} kt   평균 고도 사람 {P[sl, 1].mean():.0f} m / AI {E[sl, 1].mean():.0f} m   "
               f"최저 고도 사람 {P[sl, 1].min():.0f} / AI {E[sl, 1].min():.0f}")
    out.append(f"  G: 사람 평균 {np.abs(P[sl, 14]).mean():.1f} 최대 {P[sl, 14].max():.1f}   AI 평균 {np.abs(E[sl, 14]).mean():.1f} 최대 {E[sl, 14].max():.1f}   "
               f"사람 스로틀 평균 {C[sl, 3].mean():.2f}, 스피드브레이크 {P[sl, 16].mean():.0%}")
    modes, cnt = np.unique(mode[sl], return_counts=True)
    out.append('  AI 모드: ' + ', '.join(f'{a or "-"} {c / n:.0%}' for a, c in zip(modes, cnt)))
    # 피격 순간 (HP 감소 프레임)
    for who, X, ata_s, aa_s, Rr in (('사람→AI', E, ata_p, aa_e, R), ('AI→사람', P, ata_e, aa_p, R)):
        dh = -np.diff(X[:, 10], prepend=X[0, 10]); idx = np.where(dh > 0.5)[0]
        if len(idx):
            # 0.6초 이내 연속 피격은 한 번의 사격으로 묶음
            groups = np.split(idx, np.where(np.diff(t[idx]) > 0.6)[0] + 1)
            s = '; '.join(f"t={t[g[0]] - t[i0]:.0f}s {dh[g].sum():.0f}dmg R={Rr[g[0]]:.0f}m AA={aa_s[g[0]]:.0f}°" for g in groups)
            out.append(f'  피격 {who}: {s}')
    # 시간대별 흐름
    if tl:
        out.append('  시간  거리   사람ATA/AA   AI ATA/AA   사람 kt/고도/G    AI kt/고도/G     AI모드')
        for i in range(i0, len(t), int(tl * 10)):
            out.append(f"  {t[i] - t[i0]:4.0f} {R[i]:6.0f}  {ata_p[i]:4.0f}/{aa_e[i]:4.0f}   {ata_e[i]:4.0f}/{aa_p[i]:4.0f}   "
                       f"{P[i, 11] * 1.944:4.0f}/{P[i, 1]:5.0f}/{P[i, 14]:4.1f}   {E[i, 11] * 1.944:4.0f}/{E[i, 1]:5.0f}/{E[i, 14]:4.1f}   {mode[i]}")
        i = len(t) - 1
        out.append(f"  끝 {t[i] - t[i0]:4.0f} {R[i]:6.0f}  {ata_p[i]:4.0f}/{aa_e[i]:4.0f}   {ata_e[i]:4.0f}/{aa_p[i]:4.0f}   "
                   f"{P[i, 11] * 1.944:4.0f}/{P[i, 1]:5.0f}/{P[i, 14]:4.1f}   {E[i, 11] * 1.944:4.0f}/{E[i, 1]:5.0f}/{E[i, 14]:4.1f}   {mode[i]}")
    return '\n'.join(out), dict(off_p=off_p[sl].mean(), off_e=off_e[sl].mean(), ho=ho[sl].mean(),
                                Ep=(Eh(P)[sl]).mean(), Ee=(Eh(E)[sl]).mean(), win=m['result'] == 'human')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('pat', nargs='?', default=''); ap.add_argument('--tl', type=float, default=0)
    a = ap.parse_args()
    rows = []
    for f in sorted(glob.glob(os.path.join(HERE, 'data', 'human', f'*{a.pat}*.json'))):
        with open(f, encoding='utf-8') as fp:
            d = json.load(fp)
        d['file'] = os.path.basename(f)
        s, r = analyse(d, a.tl); print(s); rows.append(r)
    for k, lab in ((True, '사람 승'), (False, '사람 패')):
        rr = [r for r in rows if r['win'] == k]
        if rr:
            print(f"{lab} {len(rr)}판 평균: 사람 공세 {np.mean([r['off_p'] for r in rr]):.0%}, AI 공세 {np.mean([r['off_e'] for r in rr]):.0%}, "
                  f"정면 {np.mean([r['ho'] for r in rr]):.0%}, 에너지고도 사람 {np.mean([r['Ep'] for r in rr]):.0f} m / AI {np.mean([r['Ee'] for r in rr]):.0f} m")
