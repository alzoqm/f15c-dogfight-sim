// 브라우저 실게임 대결 하네스 (?debug 전용): 강화학습 정책(적군) vs 에이스 규칙 기반 AI(청군, 플레이어 기체를 AI가 조종)
// 사용: await import('/rl/harness.js'); await rlDuel(n, { red: 'elite' | 'legend' (또는 policy: 정책이름), blue: 'ace' | 'elite' | 'legend' | 'flat' | 정책이름 })
const THREE = await import('three');
const { AIPilot, SKILL } = await import('/src/ai.js');
const { getPolicy } = await import('/src/rlpolicy.js');

let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function flatPilot(p, e) {
  const h = new AIPilot(p, 'legend'); h.aoaNow = 30;
  return {
    holdFire: true, ingressAlt: null, k: { pitch: 0, roll: 0 },
    update(dt) {
      const fm = p.fm, u = fm.vel.clone().normalize();
      const upP = new THREE.Vector3(0, 1, 0).addScaledVector(u, -u.y).normalize();
      const rt = new THREE.Vector3().crossVectors(u, upP).normalize();
      const sgn = rt.dot(new THREE.Vector3().subVectors(e.fm.pos, fm.pos)) >= 0 ? 1 : -1;
      const c = Math.cos(80 * Math.PI / 180);
      const cmd = h.flyLiftP(upP.multiplyScalar(c).addScaledVector(rt, Math.sqrt(1 - c * c) * sgn), 99, false);
      this.k.pitch += (cmd.pitch - this.k.pitch) * Math.min(dt * 6, 1);
      this.k.roll += (cmd.roll - this.k.roll) * Math.min(dt * 8, 1);
      fm.ctl.pitch = this.k.pitch; fm.ctl.roll = this.k.roll; fm.ctl.yaw = 0;
      fm.ctl.throttle = 1; p.trigger = false;
    },
  };
}

window.rlDuel = async (n = 10, opt = {}) => {
  const d = window.__dbg;
  // opt.red / opt.blue: 난이도 이름(SKILL 키)이면 그 난이도 그대로(성능 보정 포함). red 기본 = legend + opt.policy
  const redSk = opt.red ? SKILL[opt.red] : { ...SKILL.legend, rl: opt.policy || 'cand' };
  const pol = redSk.rl;
  if (pol) while (!getPolicy(pol)) await new Promise((r) => setTimeout(r, 100));
  const blueSk = opt.blue && SKILL[opt.blue] ? SKILL[opt.blue] : null;
  const bluePol = blueSk ? blueSk.rl : (opt.blue && !['ace', 'flat'].includes(opt.blue) ? opt.blue : null);
  if (bluePol) while (!getPolicy(bluePol)) await new Promise((r) => setTimeout(r, 100));
  seed = opt.seed || 1;
  const res = { rlWin: 0, ruleWin: 0, draw: 0, rlCrash: 0, ruleCrash: 0, rows: [] };
  for (let i = 0; i < n; i++) {
    let g; d.start('bfm'); d.advance(0.02, (gg) => (g = gg));
    g.opts.gEffects = false;
    const p = g.player, e = g.aircraft.find((a) => a.side === 'red');
    // 무작위 머지 (정면 6~8 km, 옆 간격, 속도, 고도)
    const off = (rnd() < 0.5 ? -1 : 1) * (150 + rnd() * 700), alt = 4000 + rnd() * 2500;
    p.fm.reset({ pos: new THREE.Vector3(0, alt, 14000), heading: 0, speed: 180 + rnd() * 70, gear: false, throttle: 0.85 });
    e.fm.reset({ pos: new THREE.Vector3(off, alt + (rnd() - 0.5) * 600, 14000 - 6000 - rnd() * 2000), heading: 180, speed: 180 + rnd() * 70, gear: false, throttle: 0.85 });
    p.prevPos.copy(p.fm.pos); e.prevPos.copy(e.fm.pos);
    const perf = (sk) => (sk && sk.perf ? [sk.perf.thrust, sk.perf.nz] : [1.15, 1]);
    for (const [a, sk] of [[p, blueSk], [e, redSk]]) { a.fm.infiniteFuel = true; [a.fm.thrustMul, a.fm.nzBonus] = perf(sk); a.stores.aim9 = a.stores.aim120 = a.stores.srm = a.stores.mrm = 0; a.updateStoresMass(); }   // 기총전 비교 (미사일 없음)
    // 적군
    e.ai = new AIPilot(e, 'legend'); e.ai.skill = redSk; e.ai.holdFire = true; e.ai.ingressAlt = alt;
    // 청군: 규칙 기반 전설(새 조준 법칙) 또는 수평 선회 봇
    p.fm.rateCmd = false; p.fm.smoothUnload = false;
    if (opt.blue === 'flat') p.ai = flatPilot(p, e);
    else {
      // 청군 AI는 game.player(=자기 자신)를 표적으로 삼으므로, 표적이 적군이 되도록 game을 감싼다
      const inner = new AIPilot(p, 'ace'); if (blueSk) inner.skill = blueSk; else if (bluePol) inner.skill = { ...SKILL.legend, rl: bluePol };
      inner.holdFire = true; inner.ingressAlt = alt;
      const view = new Proxy(g, { get: (t, k) => (k === 'player' ? e : t[k]) });
      // 게임의 입력 처리가 매 프레임 플레이어 스틱을 키보드 값(0)으로 덮으므로, AI 자신의 스틱 상태를 보관했다가 복원
      const keep = { pitch: 0, roll: 0, yaw: 0, throttle: 0.85 };
      p.ai = {
        inner, get holdFire() { return inner.holdFire; }, set holdFire(v) { inner.holdFire = v; }, set ingressAlt(v) { inner.ingressAlt = v; },
        update: (dt) => { Object.assign(p.fm.ctl, keep); inner.update(dt, view); for (const k in keep) keep[k] = p.fm.ctl[k]; },
      };
    }
    let t = 0, end = '';
    const maxT = opt.maxT || 120;
    while (t < maxT) {
      d.advance(0.5); t += 0.5;
      if (g.bfm.phase === 'fight' && p.ai.holdFire) { p.ai.holdFire = false; p.ai.ingressAlt = null; }
      const pd = !p.alive || p.fm.destroyed, ed = !e.alive || e.fm.destroyed;
      if (pd || ed) { end = pd && ed ? 'both' : pd ? 'rl' : 'rule'; break; }
    }
    if (end === 'rl') res.rlWin++; else if (end === 'rule') res.ruleWin++; else res.draw++;
    if (/지면|해상/.test(e.fm.crashReason || '')) res.rlCrash++;
    if (/지면|해상/.test(p.fm.crashReason || '')) res.ruleCrash++;
    res.rows.push(`${i}: ${end || 'draw'} t=${t} hp rl=${e.fm.hp.toFixed(0)} rule=${p.fm.hp.toFixed(0)} ${e.fm.crashReason || ''}${p.fm.crashReason ? ' / ' + p.fm.crashReason : ''}`);
  }
  return res;
};
