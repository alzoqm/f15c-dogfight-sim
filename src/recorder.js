// 1:1 BFM 대결 기록기: 사람이 조종한 판만 0.1초 간격으로 양쪽 기체 상태와 플레이어 조종 입력을 저장하고,
// 판이 끝나면 로컬 개발 서버(server.py, POST /rec)로 보내 rl/data/human/에 JSON으로 남긴다. 외부로는 보내지 않음.
import { getPolicy } from './rlpolicy.js';

const DT = 0.1;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;

function acState(a) {
  const fm = a.fm, s = fm.s;
  // [위치 xyz, 속도 xyz, 자세 쿼터니언 xyzw, hp, 대기속도, 마하, 받음각(rad), nz, 추력 레버, 스피드브레이크, 방아쇠, 실제 사격]
  return [r1(fm.pos.x), r1(fm.pos.y), r1(fm.pos.z), r1(fm.vel.x), r1(fm.vel.y), r1(fm.vel.z),
    r3(fm.quat.x), r3(fm.quat.y), r3(fm.quat.z), r3(fm.quat.w),
    r1(fm.hp), r1(s.V || 0), r3(s.M || 0), r3(s.alpha || 0), r3(s.nz || 0), r3(fm.ctl.throttle),
    fm.sbCmd ? 1 : 0, a.trigger ? 1 : 0, a.gunFiring ? 1 : 0];
}

export class FightRecorder {
  constructor(game) {
    this.game = game;
    this.acc = 0; this.t = 0; this.frames = []; this.human = true; this.done = false; this.endT = -1;
    this.meta = {
      version: 1, date: new Date().toISOString(), difficulty: game.opts.difficulty, scheme: game.input.scheme, missiles: !!game.bfmMissiles,
      aimSettle: 0.3, fields: 'p/e: px py pz vx vy vz qx qy qz qw hp V M alpha nz throttle sb trigger firing; c: pitch roll yaw throttle (플레이어 조종 입력)',
    };
  }

  tick(dt) {
    if (this.done) return;
    const g = this.game, p = g.player, e = g.aircraft.find((a) => a.side === 'red');
    if (!e) return;
    if (p.ai) this.human = false;           // 시험 하네스 등 AI가 조종한 판은 저장하지 않음
    this.acc += dt; this.t += dt;
    if (this.acc >= DT - 1e-6) {
      this.acc -= DT;
      const c = p.fm.ctl;
      this.frames.push({ t: r3(this.t), ph: g.bfm?.phase === 'fight' ? 1 : 0, p: acState(p), e: acState(e),
        c: [r3(c.pitch), r3(c.roll), r3(c.yaw), r3(c.throttle)], m: e.ai?.maneuver || '' });
    }
    // 한쪽이 격추·추락하면 1.5초 더 기록한 뒤 저장
    const pd = !p.alive || p.fm.destroyed, ed = !e.alive || e.fm.destroyed;
    if ((pd || ed) && this.endT < 0) this.endT = this.t;
    if (this.endT >= 0 && this.t - this.endT > 1.5) this.flush(pd && ed ? 'both' : pd ? 'ai' : 'human');
  }

  // result: 'human'(사람 승) | 'ai' | 'both' | 'abort'(중간에 나감)
  flush(result = 'abort', beacon = false) {
    if (this.done) return;
    this.done = true;
    const fightT = this.frames.filter((f) => f.ph).length * DT;
    if (!this.human || fightT < 5) return;   // 머지 전에 나간 판은 버림
    const p = this.game.player, e = this.game.aircraft.find((a) => a.side === 'red');
    if (result === 'abort' && p && e) {   // 격추 직후 바로 재시작한 경우에도 결과를 남김
      const pd = !p.alive || p.fm.destroyed, ed = !e.alive || e.fm.destroyed;
      if (pd || ed) result = pd && ed ? 'both' : pd ? 'ai' : 'human';
    }
    const sk = e?.ai?.skill, pol = sk?.rl ? getPolicy(sk.rl) : null;   // 상대 AI 정책 판 (예: 'PPO self-play, iter 61')
    const body = JSON.stringify({ meta: { ...this.meta, result, aiPolicy: pol ? `${sk.rl}: ${pol.info}` : 'rule-based', fightT: r1(fightT), crash: { human: p.fm.crashReason || '', ai: e?.fm.crashReason || '' } }, frames: this.frames });
    const d = new Date(this.meta.date), z = (x) => String(x).padStart(2, '0');   // 파일 이름은 현지 시각
    const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
    const url = `/rec?name=bfm_${stamp}_${this.meta.difficulty}_${result}.json`;
    try {
      if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      else fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: body.length < 60000 }).catch(() => {});
    } catch { /* 기록 실패는 게임에 영향 없음 */ }
    if (this.game.msg) this.game.msg('대결 기록 저장', '170,210,255', 2);
  }
}
