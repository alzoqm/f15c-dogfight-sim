// 게임 관리: 항공기 엔티티, 1:1 공중전(메뉴 배경은 활주로), 무장 운용, 경고, G 효과, 카메라, 이펙트
import * as THREE from 'three';
import { FlightModel, aeroToLocal } from './flightmodel.js';
import { buildF15 } from './aircraftModel.js';
import { AIPilot, SKILL } from './ai.js';
import { MISSILES } from './weapons.js';
import { makeVaporCone } from './effects.js';
import { D2R, R2D, G0, MS2KT, M2FT, KG2LB, clamp, smoothstep, lerp } from './math.js';
import { BASE_ELEV, RUNWAY } from './world.js';
import { isa } from './atmosphere.js';
import { FightRecorder } from './recorder.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
// 레이더 거리 눈금 (NM). '=' 키로 AUTO → 2 → 5 → … → 80 → AUTO 순환
// AUTO: 가장 가까운 적(트랙/육안)이 스코프 안쪽 3/4에 들어오는 가장 작은 눈금
const RADAR_SCALES_NM = [2, 5, 10, 20, 40, 80];
const VISUAL_RANGE = 10000;   // 육안 식별 거리 (m): 레이더 범위 밖이어도 스코프에 표시
const NM = 1852;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const AIM9_ST = [[-0.4, -3.08, 0.75], [-0.4, 3.08, 0.75], [-0.4, -3.72, 0.75], [-0.4, 3.72, 0.75]];
const AIM120_ST = [[2.2, -1.42, 0.92], [2.2, 1.42, 0.92], [-2.6, -1.42, 0.92], [-2.6, 1.42, 0.92]];
const PH = 1 / 240;   // 물리 적분 간격
// 1:1 공중전에서 미사일을 쓰는 난이도 (엘리트·전설은 기총 학습 정책이라 기관포만)
export const MISSILE_DIFFS = new Set(['rookie', 'veteran', 'ace']);

// ============================================================================ 항공기 엔티티
export class Aircraft {
  constructor(game, { side = 'blue', isPlayer = false, paint = 'usaf', name = 'EAGLE', skill = 'veteran' }) {
    this.game = game;
    this.side = side; this.isPlayer = isPlayer; this.name = name;
    this.fm = new FlightModel({ fuelFrac: 1 });
    this.model = buildF15({ paint, cockpit: isPlayer });
    this.vapor = makeVaporCone();
    this.model.add(this.vapor);
    game.scene.add(this.model);
    this.alive = true; this.exploded = false; this.killCredited = false;
    this.prevPos = new THREE.Vector3();
    const sk = SKILL[skill];
    this.stores = isPlayer ? { aim9: 4, aim120: 4, srm: 0, mrm: 0 } : { aim9: sk.srm, aim120: sk.mrm, srm: sk.srm, mrm: sk.mrm };
    this.flares = 30; this.chaff = 30;
    this.weapon = 'GUN';
    this.lock = null;
    this.seeker = { target: null };
    this.gunSpin = 0; this.trigger = false; this.gunFiring = false;
    this.warnings = []; this.threatDirs = [];
    this.trailAcc = 0; this.fireT = 0; this.launchCd = 0;
    this.ai = isPlayer ? null : new AIPilot(this, skill);
    if (!isPlayer && sk.perf) { this.fm.thrustMul = sk.perf.thrust; this.fm.nzBonus = sk.perf.nz; }
    this.fm.smoothUnload = isPlayer;
    this.fm.rateCmd = isPlayer;        // 플레이어: 피치레이트 명령·자세 유지 (놓으면 기수 정지 → 조준 안정)   // 플레이어: 스틱을 놓을 때 하중을 천천히 풀어 기수 출렁임 방지
    this.updateStoresMass();
  }
  updateStoresMass() {
    const s = this.stores;
    this.fm.storesMass = s.aim9 * 85.3 + s.aim120 * 152 + 60; // 파일런/레일 포함
    this.fm.storesDrag = 0.0004 + 0.00055 * (s.aim9 + s.aim120);
  }
  nextStation(type) {
    if (type === 'AIM-9X' || type === 'R-73') return AIM9_ST[Math.max(0, this.stores.aim9 - 1)];
    return AIM120_ST[Math.max(0, this.stores.aim120 - 1)];
  }
  fireMissile(game, type, target) {
    const s = this.stores;
    if ((type === 'AIM-9X' || type === 'R-73') && s.aim9 <= 0) return null;
    if ((type === 'AIM-120C' || type === 'R-77') && s.aim120 <= 0) return null;
    const m = game.weapons.launch(this, type, target);
    if (type === 'AIM-9X' || type === 'R-73') { s.aim9--; if (s.srm > 0) s.srm--; }
    else { s.aim120--; if (s.mrm > 0) s.mrm--; }
    this.updateStoresMass();
    return m;
  }
  hitBy(attacker, dmg, kind) {
    if (!this.alive || this.fm.crashed) return;
    const wasDestroyed = this.fm.destroyed;
    this.fm.damage(dmg, kind === 'gun' ? `기관포 피격 (${attacker.name})` : `미사일 피격 (${attacker.name})`);
    this.lastHitBy = attacker;
    if (this.isPlayer) { this.game.flashDamage = 0.5; this.game.effects.shake = Math.min(1, this.game.effects.shake + dmg / 60); }
    if (this.fm.destroyed && !wasDestroyed) {
      this.game.onKill(this, attacker);
      if (kind === 'missile' && dmg >= 100 && Math.random() < 0.55) this.breakup();
    }
  }
  breakup() {
    // 공중 폭발 (기체 분해)
    this.game.effects.explosion(this.fm.pos, this.fm.vel, 1.3, true);
    this.game.audio.explosion(this.fm.pos, 1.3);
    this.model.visible = false;
    this.alive = false; this.exploded = true;
    this.fm.crashed = true;
  }
  weaponLabel() {
    if (this.gunAlways) return `GUN ${this.fm.ammo} · ${this.weapon === 'SRM' ? `SRM ${this.stores.aim9}` : `MRM ${this.stores.aim120}`}`;
    if (this.weapon === 'GUN') return `GUN ${this.fm.ammo}`;
    if (this.weapon === 'SRM') return `SRM ${this.stores.aim9} 9X`;
    return `MRM ${this.stores.aim120} 120`;
  }
  /** 발사 가능 구역 (Dynamic Launch Zone) — 고도/접근속도/방위 반영 근사 */
  dlz(wpn, tgt) {
    const fm = this.fm;
    const range = tgt.fm.pos.distanceTo(fm.pos);
    const los = _v.subVectors(tgt.fm.pos, fm.pos).normalize();
    const vc = -los.dot(_v2.subVectors(tgt.fm.vel, fm.vel));
    const altK = clamp((fm.pos.y + tgt.fm.pos.y) / 2 / 1000, 0, 15);
    let rMax, rMin;
    if (wpn === 'MRM') { rMax = (16000 + 2600 * altK) * clamp(1 + vc / 650, 0.45, 1.7) * (1 + fm.s.M * 0.25); rMin = 1500; }
    else { rMax = (5500 + 500 * altK) * clamp(1 + vc / 900, 0.5, 1.5); rMin = 450; }
    rMax = Math.min(rMax, wpn === 'MRM' ? 80000 : 18000);
    const rNe = Math.max(rMin * 1.5, rMax * (wpn === 'MRM' ? 0.4 : 0.55));
    return { rMax, rMin, rNe, range, inRange: range > rMin && range < rMax };
  }
}

// ============================================================================ 게임
export class Game {
  constructor({ scene, camera, renderer, world, hud, audio, input, effects, weapons }) {
    Object.assign(this, { scene, camera, renderer, world, hud, audio, input, effects, weapons });
    this.aircraft = [];
    this.player = null;
    this.messages = [];
    this.camMode = 'chase';
    this.paused = false;
    this.running = false;
    this.mode = 'air';
    this.opts = { difficulty: 'veteran', cas: true, infiniteFuel: false, infiniteAmmo: false, gEffects: true, sound: true };
    this.acc = 0;
    this.time = 0;
    this.gStrain = 0;
    this.gEffect = { black: 0, red: 0 };
    this.glocT = 0;
    this.hudOn = true;
    this.look = { yaw: 0, pitch: 0 };
    this.camDist = 1;
    this.chaseQ = new THREE.Quaternion();
    this.deathCam = null;   // 격추·추락 시 카메라 위치 (그 자리에서 잔해를 바라봄)
    this.padlock = false;
    this.kills = 0; this.wave = 0; this.waveTimer = 0;
    this.flashDamage = 0;
    this.endTimer = -1;
    this.wrecks = [];
    this.onEnd = null;
    this.modeLabel = '';
    this.statusLine = '';
    this.landed = false;
  }

  msg(text, color, t = 3.5) {
    this.messages.unshift({ text, color, t });
    if (this.messages.length > 5) this.messages.pop();
  }

  clearAll() {
    for (const a of this.aircraft) this.scene.remove(a.model);
    this.aircraft.length = 0;
    this.weapons.clear();
    this.messages.length = 0;
    this.player = null;
  }

  // ------------------------------------------------------------------ 시작
  start(mode, opts = {}) {
    this.rec?.flush('abort'); this.rec = null;   // 진행 중이던 대결 기록 저장
    Object.assign(this.opts, opts);
    this.cockpitOnly = !!this.opts.cockpitOnly;   // 1인칭 전용: 시점 전환(C) 불가, 시작 시 조종석 고정
    this.clearAll();
    this.mode = mode;
    this.kills = 0; this.wave = 0; this.waveTimer = 2; this.endTimer = -1; this.time = 0; this.landed = false; this.bfm = null;
    this.gStrain = 0; this.glocT = 0; this.gEffect.black = this.gEffect.red = 0;
    this.look.yaw = this.look.pitch = 0; this.deathCam = null;
    const p = new Aircraft(this, { side: 'blue', isPlayer: true, paint: 'usaf', name: 'EAGLE 1' });
    this.player = p;
    this.aircraft.push(p);
    const fm = p.fm;
    fm.casOn = this.opts.cas;
    fm.infiniteFuel = this.opts.infiniteFuel;
    if (mode === 'runway') {
      fm.reset({ pos: new THREE.Vector3(0, BASE_ELEV + 2.08, RUNWAY.length / 2 - 150), heading: 0, speed: 0, gear: true, onGround: true, throttle: 0 });
      fm.ctl.brake = 1;
      this.camMode = 'chase';
      this.modeLabel = 'FREE FLIGHT';
      this.msg('활주로 36 — 이륙 준비', '200,255,210');
      this.msg({
        bf: 'W: 추력 증가 · Shift 누름: 애프터버너 · ↓(140 kt): 기수 올림 · 이륙 후 G: 기어 업',
        bfmouse: 'W: 추력 증가 · Shift 누름: 애프터버너 · 마우스 위로(140 kt): 기수 올림 · G: 기어',
      }[this.input.scheme] || 'R: 추력 증가 (MIL에서 다시 R → 애프터버너) · N: 브레이크 · V: 플랩', '255,240,200', 7);
    } else {
      // 1:1 공중전: 같은 고도·속도로 정면 대향(측면 간격 300 m), 머지 전 사격·발사 금지. 에이스 이하는 미사일 사용
      mode = this.mode = 'bfm';
      const missiles = this.bfmMissiles = MISSILE_DIFFS.has(this.opts.difficulty);
      fm.reset({ pos: new THREE.Vector3(0, 5000, 14000), heading: 0, speed: 185, gear: false, throttle: 0.85 });
      fm.ctl.throttle = 0.85;
      if (!missiles) { p.stores.aim9 = p.stores.aim120 = 0; p.updateStoresMass(); }
      this.camMode = this.opts.cockpitOnly ? 'cockpit' : 'chase';
      this.modeLabel = '1v1 BFM';
      const e = new Aircraft(this, { side: 'red', paint: 'aggressor', name: 'BANDIT', skill: this.opts.difficulty });
      if (!missiles) { e.stores.aim9 = e.stores.aim120 = e.stores.srm = e.stores.mrm = 0; e.updateStoresMass(); }
      e.fm.reset({ pos: new THREE.Vector3(300, 5000, 14000 - 8000), heading: 180, speed: 185, gear: false, throttle: 0.85 });
      e.fm.infiniteFuel = true;
      e.prevPos.copy(e.fm.pos);
      e.ai.holdFire = true; e.ai.ingressAlt = 5000;
      this.aircraft.push(e);
      this.bfm = { phase: 'ingress', minR: 1e9, prevR: 1e9, t: 0, won: false, warnT: 0 };
      this.rec = new FightRecorder(this);   // 사람이 조종한 판만 rl/data/human/에 저장
      this.msg(missiles ? '1:1 공중전 — 정면 8 km에 적기, 미사일(AIM-9X·AIM-120) + 기관포' : '1:1 기총전 — 정면 8 km에 적기, 기관포만 사용', '255,200,160', 5);
      this.msg("서로 지나친 뒤(머지) FIGHT'S ON 신호부터 사격·발사 가능", '255,240,200', 6);
    }
    this.chaseQ.copy(fm.quat);
    this.input.setThrottle(fm.ctl.throttle);
    this.sbToggle = false;
    p.weapon = mode === 'bfm' && this.bfmMissiles && this.input.scheme !== 'classic' ? 'SRM' : 'GUN';
    // 레이더 초기화 (거리 눈금은 유지)
    const scale = this.radar ? this.radar.scale : -1;
    this.radar = { az: -60 * D2R, dir: 1, tracks: new Map(), scale, maskT: 0, visual: [], autoIdx: 3 };
    this.applyRadarScale();
    this.camTarget = null; this.camTQ = new THREE.Quaternion(); this.camTInit = false;
    this.input._tvOn = false; this._tvMsgPrev = false;   // 추적 토글 상태 초기화
    p.prevPos.copy(fm.pos);
    this.running = true;
    this.paused = false;
  }

  onKill(victim, attacker) {
    if (victim.killCredited) return;
    victim.killCredited = true;
    if (attacker === this.player && victim !== this.player) {
      this.kills++;
      this.msg(`SPLASH! ${victim.name} 격추`, '255,230,120', 4);
    } else if (victim === this.player) {
      this.msg(`피격 — ${victim.fm.crashReason}`, '255,120,100', 5);
    }
  }

  // ------------------------------------------------------------------ 입력 처리
  handleInput(dt) {
    const I = this.input, A = I.a, p = this.player, fm = p.fm;
    const bf = I.scheme !== 'classic';
    const gunsOnly = this.mode === 'bfm' && !this.bfmMissiles;
    const holdFire = this.mode === 'bfm' && this.bfm && this.bfm.phase !== 'fight';   // 머지 전: 사격·발사 잠금
    p.gunAlways = bf && !gunsOnly;
    if (A.camera) {
      if (this.cockpitOnly) {
        // 1인칭 전용: 3인칭·적 추적 시점으로 가지 않는다
        this.msg('1인칭 전용', '200,255,210', 1.2);
      } else {
        // 시점: 1인칭(조종석) → 3인칭(후방 추적) → 적 추적
        const modes = ['cockpit', 'chase', 'target'];
        this.camMode = modes[(modes.indexOf(this.camMode) + 1) % modes.length];
        this.look.yaw = this.look.pitch = 0;
        this.msg(`시점: ${{ cockpit: '1인칭 (조종석)', chase: '3인칭', target: '적 추적' }[this.camMode]}`, '200,255,210', 1.2);
      }
    }
    if (A.telemetry) this.hud.showTelemetry = !this.hud.showTelemetry;
    if (A.hud) this.hudOn = !this.hudOn;
    if (A.radarRange) {
      this.radar.scale = this.radar.scale + 1 >= RADAR_SCALES_NM.length ? -1 : this.radar.scale + 1;
      this.applyRadarScale();
      this.msg(`레이더 거리: ${this.radar.scale < 0 ? 'AUTO' : RADAR_SCALES_NM[this.radar.scale] + ' NM'}`, '200,255,210', 1.2);
    }
    if (A.padlock) { this.padlock = !this.padlock; if (!this.padlock) { this.look.yaw = this.look.pitch = 0; } }
    if (!p.alive) return;
    if (A.gear) { if (!(fm.wow && fm.gearCmd)) { fm.gearCmd = !fm.gearCmd; this.msg(fm.gearCmd ? '기어 다운' : '기어 업', '200,255,210', 1.5); } else this.msg('지상에서는 기어를 올릴 수 없습니다 (WOW)', '255,200,120', 2); }
    if (A.flaps) { fm.flapCmd = !fm.flapCmd; if (fm.flapCmd && fm.s.cas > fm.data.limits.flapSpeed) { fm.flapCmd = false; this.msg('플랩 제한속도(250 KCAS) 초과', '255,200,120', 2); } }
    if (A.speedbrake) this.sbToggle = !this.sbToggle;
    fm.sbCmd = !!this.sbToggle || (A.airbrake && !fm.wow);
    if (A.cas) { fm.casOn = !fm.casOn; this.msg(fm.casOn ? 'CAS ON — 하중배수/롤레이트 명령 (G 제한 9G)' : 'CAS OFF — 직결 기계식 조종 (G 제한 없음, 트림 [ ])', fm.casOn ? '200,255,210' : '255,200,120', 3); }
    if (A.trimDown) fm.ctl.trim = clamp(fm.ctl.trim - 0.05, -1, 1);
    if (A.trimUp) fm.ctl.trim = clamp(fm.ctl.trim + 0.05, -1, 1);
    if (gunsOnly) {
      p.weapon = 'GUN';
      if (A.missile || A.selSRM || A.selMRM || A.cycleWpn) this.msg('기총전 — 미사일 없음 (기관포만 사용)', '255,200,120', 1.5);
    } else {
      if (A.selGun) p.weapon = 'GUN';
      if (A.selSRM) p.weapon = 'SRM';
      if (A.selMRM) p.weapon = 'MRM';
      if (A.cycleWpn) p.weapon = bf ? (p.weapon === 'SRM' ? 'MRM' : 'SRM') : { GUN: 'SRM', SRM: 'MRM', MRM: 'GUN' }[p.weapon];
      if (bf && p.weapon === 'GUN') p.weapon = 'SRM';
      if (A.missile) {
        if (holdFire) { if (this.bfm.warnT <= 0) { this.msg("머지 전 발사 금지 — FIGHT'S ON 이후 발사", '255,200,120', 1.5); this.bfm.warnT = 2; } }
        else this.firePlayerMissile();
      }
    }
    if (A.lock) this.cycleLock();
    if (A.flares) this.weapons.dispense(p);
    // 조종 입력 (G-LOC 시 무력화)
    const conscious = this.glocT <= 0;
    const st = I.out || I.stick;
    fm.ctl.pitch = conscious ? st.pitch : 0;
    fm.ctl.roll = conscious ? st.roll : 0;
    fm.ctl.yaw = conscious ? st.yaw : 0;
    fm.ctl.throttle = I.throttle;
    fm.ctl.brake = A.wheelBrake ? 1 : (this.mode === 'runway' && this.time < 1 ? 1 : 0);
    // 지상 조향: 러더 + 롤 입력 (저속에서 큰 각)
    const steerMax = (fm.s.V < 25 ? 45 : 12) * D2R;
    fm.steer = fm.wow ? clamp(st.yaw + 0.6 * st.roll, -1, 1) * steerMax : 0;
    // 1:1: 머지 전에는 방아쇠 잠금
    if (holdFire && A.gun && this.bfm.warnT <= 0) { this.msg("머지 전 사격 금지 — FIGHT'S ON 이후 사격", '255,200,120', 1.5); this.bfm.warnT = 2; }
    p.trigger = conscious && A.gun && !holdFire && (bf || p.weapon === 'GUN');
  }

  /** 시선(LOS)이 지형에 가리지 않는지 (구간 샘플링) */
  losClear(a, b) {
    for (let i = 1; i < 12; i++) {
      const t = i / 12, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
      if (y < this.world.heightAt(x, z) + 15) return false;
    }
    return true;
  }

  /**
   * 공대공 레이더 (APG-63 단순화): 기수 기준 ±60° 방위, ±40° 고각을 좌우로 스캔.
   * 빔이 지나가는 순간 탐지 판정(거리·지형 차폐·저고도 클러터) → 트랙 파일(위치/속도/시각) 갱신.
   * 록(STT) 중에는 안테나가 표적을 계속 추적하고 다른 표적은 갱신되지 않는다. 트랙은 8초 후 소멸.
   */
  updateRadar(dt) {
    const R = this.radar, p = this.player, fm = p.fm;
    if (!R || !p.alive) return;
    const geom = (a) => {
      const dx = a.fm.pos.x - fm.pos.x, dy = a.fm.pos.y - fm.pos.y, dz = a.fm.pos.z - fm.pos.z;
      const hr = Math.hypot(dx, dz);
      return { r: Math.hypot(hr, dy), az: wrapPi(Math.atan2(dx, -dz) - fm.s.heading), el: Math.atan2(dy, hr) };
    };
    const LIM = 60 * D2R;
    const prev = R.az;
    if (p.lock) R.az = clamp(geom(p.lock).az, -LIM, LIM);
    else {
      R.az += R.dir * 75 * D2R * dt;  // 120°를 한 번 훑는 데 1.6초
      if (R.az > LIM) { R.az = LIM; R.dir = -1; } else if (R.az < -LIM) { R.az = -LIM; R.dir = 1; }
    }
    const lo = Math.min(prev, R.az) - 0.01, hi = Math.max(prev, R.az) + 0.01;
    const noseEl = Math.asin(clamp(_v.set(0, 0, -1).applyQuaternion(fm.quat).y, -1, 1));
    for (const a of this.aircraft) {
      if (a === p || !a.alive) continue;
      const locked = p.lock === a;
      if (p.lock && !locked) continue;
      const g = geom(a);
      if (!locked && (g.az < lo || g.az > hi)) continue;
      if (Math.abs(g.az) > LIM + 0.02 || Math.abs(g.el - noseEl) > 40 * D2R) continue;
      // 저고도 표적을 내려다보면 지면 클러터로 탐지거리 감소
      const lookDown = a.fm.pos.y < fm.pos.y && a.fm.pos.y - this.world.heightAt(a.fm.pos.x, a.fm.pos.z) < 1500;
      if (g.r > (lookDown ? 70000 : 100000)) continue;
      if (!locked && !this.losClear(fm.pos, a.fm.pos)) continue;
      let tr = R.tracks.get(a);
      if (!tr) { tr = { a, pos: new THREE.Vector3(), vel: new THREE.Vector3(), t: 0 }; R.tracks.set(a, tr); }
      tr.pos.copy(a.fm.pos); tr.vel.copy(a.fm.vel); tr.t = this.time;
    }
    for (const [a, tr] of R.tracks) if (!a.alive || this.time - tr.t > 8) R.tracks.delete(a);
    // 육안 접촉(탤리): 10 km 이내, 지형에 가리지 않은 적기는 레이더 빔과 무관하게 위치를 안다 (후방 포함)
    R.visual.length = 0;
    let nearest = 1e9;
    for (const a of this.aircraft) {
      if (a === p || !a.alive || a.side === p.side) continue;
      const r = a.fm.pos.distanceTo(fm.pos);
      if (r < VISUAL_RANGE && this.losClear(fm.pos, a.fm.pos)) { R.visual.push(a); nearest = Math.min(nearest, r); }
    }
    for (const tr of R.tracks.values()) if (tr.a.side !== p.side) nearest = Math.min(nearest, tr.pos.distanceTo(fm.pos));
    // AUTO: 가장 가까운 접촉이 반경 75% 안에 들도록 (히스테리시스로 눈금 깜빡임 방지)
    let want = RADAR_SCALES_NM.findIndex((n) => nearest < n * NM * 0.75);
    if (want < 0) want = nearest < 1e8 ? RADAR_SCALES_NM.length - 1 : 3;
    if (want > R.autoIdx || nearest < RADAR_SCALES_NM[R.autoIdx] * NM * 0.3 || nearest > 1e8) R.autoIdx = want;
    this.applyRadarScale();
  }

  applyRadarScale() {
    const R = this.radar;
    const idx = R.scale < 0 ? R.autoIdx : R.scale;
    this.hud.radarRange = RADAR_SCALES_NM[idx] * NM;
    this.hud.radarAuto = R.scale < 0;
  }

  /** 카메라/패드락이 볼 적: 록 표적 → 가장 가까운 적 (육안 거리 우선) */
  viewTarget() {
    const p = this.player;
    if (p.lock && p.lock.alive) return p.lock;
    let best = null, bd = 1e9;
    for (const a of this.aircraft) {
      if (a === p || !a.alive || a.side === p.side) continue;
      const d = a.fm.pos.distanceTo(p.fm.pos);
      if (d < bd) { bd = d; best = a; }
    }
    return bd < 60000 ? best : null;
  }

  cycleLock() {
    const p = this.player, fm = p.fm;
    const fwd = _v.set(0, 0, -1).applyQuaternion(fm.quat).clone();
    // 레이더가 최근(4초 이내) 탐지해 트랙 파일이 있는 적기 중, 지금도 스캔 범위 안에 있는 표적만 록 가능
    const cands = [];
    for (const tr of this.radar.tracks.values()) {
      const a = tr.a;
      if (!a.alive || a.side === p.side || this.time - tr.t > 4) continue;
      const los = _v2.subVectors(a.fm.pos, fm.pos);
      if (los.length() > 100000) continue;
      const ang = Math.acos(clamp(fwd.dot(los.normalize()), -1, 1));
      if (ang < 60 * D2R && this.losClear(fm.pos, a.fm.pos)) cands.push({ a, ang });
    }
    // ACM 모드(근접전 자동 획득): 트랙이 없어도 10 NM 이내, 기수 30° 안에 보이는 적은 록 가능
    for (const a of this.aircraft) {
      if (a === p || !a.alive || a.side === p.side || cands.some((c) => c.a === a)) continue;
      const los = _v2.subVectors(a.fm.pos, fm.pos);
      if (los.length() > 10 * NM) continue;
      const ang = Math.acos(clamp(fwd.dot(los.normalize()), -1, 1));
      if (ang < 30 * D2R && this.losClear(fm.pos, a.fm.pos)) cands.push({ a, ang });
    }
    cands.sort((x, y) => x.ang - y.ang);
    if (!cands.length) { p.lock = null; this.msg('레이더: 록 가능한 표적 없음 (기수 ±60° 스캔 범위 또는 근거리 기수 30° 안에 적이 있어야 함)', '255,200,120', 2); return; }
    const idx = p.lock ? (cands.findIndex(c => c.a === p.lock) + 1) % cands.length : 0;
    p.lock = cands[idx].a;
    this.audio.click();
  }

  firePlayerMissile() {
    const p = this.player;
    if (p.launchCd > 0) return;
    if (p.weapon === 'SRM' || (p.weapon === 'GUN' && p.stores.aim9 > 0 && p.seeker.target)) {
      if (p.stores.aim9 <= 0) { this.msg('AIM-9X 잔량 없음', '255,200,120', 1.5); return; }
      p.fireMissile(this, 'AIM-9X', p.seeker.target);
      this.msg(p.seeker.target ? 'FOX 2' : 'FOX 2 (탐색기 미포착 — 무유도)', '200,255,210', 1.5);
    } else if (p.weapon === 'MRM') {
      if (p.stores.aim120 <= 0) { this.msg('AIM-120 잔량 없음', '255,200,120', 1.5); return; }
      if (!p.lock) { this.msg(`레이더 록 필요 (${this.input.label('lock')})`, '255,200,120', 1.5); return; }
      p.fireMissile(this, 'AIM-120C', p.lock);
      this.msg('FOX 3', '200,255,210', 1.5);
    } else return;
    p.launchCd = 0.8;
  }

  // ------------------------------------------------------------------ 매 프레임
  update(dt) {
    if (!this.running) return;
    this.handleGlobal();
    if (this.paused) { this.audio.silence(); this.updateCamera(0); return; }
    this.time += dt;
    const p = this.player;
    this.handleInput(dt);
    for (const a of this.aircraft) if (a.ai && a.alive) a.ai.update(dt, this);
    for (const a of this.aircraft) a.prevPos.copy(a.fm.pos);

    // 물리 (고정 간격 서브스텝)
    this.acc += dt;
    let n = 0;
    while (this.acc >= PH && n < 24) {
      for (const a of this.aircraft) if (!a.fm.crashed) a.fm.step(PH, this.world);
      this.acc -= PH; n++;
    }
    if (n >= 24) this.acc = 0;
    // 공중 충돌
    for (let i = 0; i < this.aircraft.length; i++) for (let j = i + 1; j < this.aircraft.length; j++) {
      const A = this.aircraft[i], B = this.aircraft[j];
      if (!A.alive || !B.alive || A.fm.crashed || B.fm.crashed) continue;
      if (A.fm.pos.distanceToSquared(B.fm.pos) < 81) {
        for (const [X, Y] of [[A, B], [B, A]]) { X.fm.crashReason = `공중 충돌 (${Y.name})`; X.lastHitBy = X.lastHitBy || Y; X.fm.crash('공중 충돌'); }
      }
    }

    // 무장
    for (const a of this.aircraft) {
      a.launchCd -= dt;
      if (a.alive) this.weapons.updateGun(a, a.trigger, dt);
    }
    this.weapons.update(dt, this.aircraft, this.world);
    this.updatePlayerSystems(dt);
    this.updateAircraftState(dt);
    this.updateMode(dt);
    this.rec?.tick(dt);
    this.updateGEffects(dt);
    this.updateEffects(dt);
    this.updateCamera(dt);
    // 메시지 감쇠
    for (let i = this.messages.length - 1; i >= 0; i--) { this.messages[i].t -= dt; if (this.messages[i].t <= 0) this.messages.splice(i, 1); }
    // 사운드
    const fm = p.fm;
    this.audio.listener = this.camera.position;
    this.audio.update(dt, {
      rpm: (fm.engines[0].n + fm.engines[1].n) / 2, ab: (fm.engines[0].ab + fm.engines[1].ab) / 2,
      alive: p.alive && !fm.crashed, cockpit: this.camMode === 'cockpit', qbar: fm.s.qbar, buffet: fm.s.buffet,
      gun: p.gunFiring, tone: p.alive && p.weapon === 'SRM' && p.stores.aim9 > 0 ? (p.seeker.target ? 'lock' : 'search') : null,
      mws: p.threatDirs.length > 0, pullUp: p.warnings.some(w => w.key === 'pullup'), stall: p.warnings.some(w => w.key === 'aoa'),
      overG: p.warnings.some(w => w.key === 'overg'), radarLock: this.aircraft.some(a => a.side === 'red' && a.alive && a.lock === p),
    });
    this.flashDamage = Math.max(0, this.flashDamage - dt);
  }

  handleGlobal() {
    const I = this.input;
    // 포인터 록 해제 직후 들어오는 Esc는 무시 (해제 자체가 일시정지를 걸었으므로)
    const escFromLock = I.hit('Escape') && performance.now() - (I.lockLostAt || 0) < 500;
    if (I.a.pause || (I.hit('Escape') && !escFromLock)) {
      if (this.endTimer > 0 && this.endTimer < 99) return;
      this.paused = !this.paused;
      this.onPause?.(this.paused);
    }
    if (I.a.help) this.onHelp?.();
  }

  updatePlayerSystems(dt) {
    const p = this.player, fm = p.fm, s = fm.s;
    // 무한 탄약 옵션: 기관포·플레어·채프 보충, 미사일은 미사일 허용 난이도에서만 보충
    if (this.opts.infiniteAmmo && p.alive) {
      fm.ammo = 940; p.flares = 30; p.chaff = 30;
      if ((this.mode !== 'bfm' || this.bfmMissiles) && (p.stores.aim9 < 4 || p.stores.aim120 < 4)) { p.stores.aim9 = 4; p.stores.aim120 = 4; p.updateStoresMass(); }
    }
    // 레이더 록 유지 조건
    if (p.lock) {
      const t = p.lock;
      const fwd = _v.set(0, 0, -1).applyQuaternion(fm.quat);
      const los = _v2.subVectors(t.fm.pos, fm.pos);
      const r = los.length();
      // 지형에 1.5초 이상 가려지면 록 상실
      this.radar.maskT = this.losClear(fm.pos, t.fm.pos) ? 0 : this.radar.maskT + dt;
      if (!t.alive || r > 100000 || fwd.dot(los.normalize()) < Math.cos(65 * D2R) || this.radar.maskT > 1.5) { p.lock = null; this.radar.maskT = 0; this.msg('레이더 록 해제', '255,200,120', 1.2); }
    }
    this.updateRadar(dt);
    // AIM-9X 탐색기
    p.seeker.target = null;
    if (p.weapon === 'SRM' && p.stores.aim9 > 0 && p.alive) {
      const fwd = _v.set(0, 0, -1).applyQuaternion(fm.quat).clone();
      let best = null, bestAng = 1e9;
      for (const a of this.aircraft) {
        if (a === p || !a.alive || a.side === p.side) continue;
        const los = _v2.subVectors(a.fm.pos, fm.pos);
        const r = los.length();
        los.normalize();
        const ang = Math.acos(clamp(fwd.dot(los), -1, 1));
        const tailAspect = los.dot(a.fm.vel.clone().normalize()); // >0: 표적의 후방(꼬리) 방향
        const ab = a.fm.engines.some(e => e.ab > 0.1) ? 1.4 : 1;
        const irRange = (6000 + 6500 * Math.max(0, tailAspect)) * ab;
        const cone = p.lock === a ? 45 * D2R : 4 * D2R;
        if (r < irRange && ang < cone && ang < bestAng) { best = a; bestAng = ang; }
      }
      p.seeker.target = best;
    }
    // 위협 경보 (미사일 경보 체계 MWS)
    p.threatDirs = [];
    for (const m of this.weapons.threatsTo(p)) {
      if (m.owner === p) continue;
      _v.subVectors(m.pos, fm.pos);
      const brg = Math.atan2(_v.x, -_v.z) - s.heading;
      p.threatDirs.push(brg);
    }
    // 경고 목록
    const W = [];
    if (p.alive && !fm.wow) {
      // 지면 충돌 예측
      let tImpact = 1e9;
      for (const t of [1, 2, 3, 4, 5, 6]) {
        _v.copy(fm.pos).addScaledVector(fm.vel, t);
        if (_v.y < this.world.heightAt(_v.x, _v.z) + 15) { tImpact = t; break; }
      }
      const landingCfg = fm.gearPos > 0.99 && s.cas < 100 && s.vs > -9;
      if (tImpact < 6 && !landingCfg) W.push({ key: 'pullup', text: 'PULL UP', color: '#ff5040', blink: true });
      if (fm.gearPos < 0.5 && s.agl < 120 && s.cas < 110 && s.vs < -2) W.push({ key: 'gear', text: 'GEAR', color: '#ffc24a', blink: true });
    }
    if (p.alive) {
      if (s.alpha > 28 * D2R && s.V > 20) W.push({ key: 'aoa', text: 'AOA', color: '#ffc24a', blink: true });
      if (s.nz > 9.2 || s.nz < -3.2) W.push({ key: 'overg', text: 'OVER G', color: '#ff5040', blink: true });
      if (s.cas > fm.data.limits.vneCAS || s.M > 2.5) W.push({ key: 'ovs', text: 'OVERSPEED', color: '#ff5040', blink: true });
      if (fm.gearPos > 0.5 && s.cas > fm.data.limits.gearSpeed + 10) W.push({ key: 'gearspd', text: 'GEAR SPEED', color: '#ffc24a' });
      if (p.threatDirs.length) W.push({ key: 'mws', text: 'MISSILE', color: '#ff4040', blink: true });
      if (fm.engines.some(e => e.failed)) W.push({ key: 'eng', text: 'ENGINE FAIL', color: '#ff5040' });
      const lb = fm.fuel * KG2LB;
      if (!fm.infiniteFuel && lb < 2000) W.push({ key: 'bingo', text: lb <= 0 ? 'FUEL EMPTY' : 'BINGO FUEL', color: '#ffc24a', blink: lb < 800 });
      if (this.aircraft.some(a => a.side === 'red' && a.alive && a.lock === p) && !p.threatDirs.length) W.push({ key: 'spike', text: 'SPIKE', color: '#ffc24a' });
    }
    p.warnings = W;
  }

  updateAircraftState(dt) {
    for (const a of this.aircraft) {
      const fm = a.fm;
      // 지면 충돌 → 폭발
      if (fm.crashed && a.alive) {
        a.alive = false;
        a.exploded = true;
        a.model.visible = false;
        const nearGround = fm.pos.y - this.world.heightAt(fm.pos.x, fm.pos.z) < 30;
        const bigSplash = nearGround && this.world.isWater(fm.pos.x, fm.pos.z);
        this.effects.explosion(fm.pos, nearGround ? null : fm.vel, 1.6, true);
        if (nearGround && !bigSplash) this.effects.groundImpact(fm.pos, 1.2);
        else if (bigSplash) for (let i = 0; i < 80; i++) { _v.randomDirection().multiplyScalar(30); this.effects.smoke.spawn(fm.pos.x, fm.pos.y + 2, fm.pos.z, _v.x, Math.abs(_v.y) * 2.5, _v.z, 4, 6, 30, 0.95, 0.97, 1, 0.9, 1, -6); }
        this.audio.explosion(fm.pos, 1.5);
        if (nearGround && !bigSplash) this.wrecks.push({ pos: fm.pos.clone(), t: 25 });
        if (!a.killCredited) this.onKill(a, a.lastHitBy || a);
        if (a === this.player) { this.effects.shake = 1; }
      }
      if (a.isPlayer && !a.alive && this.endTimer < 0) {
        this.endTimer = 3.5;
      }
      // 모델 동기화
      if (a.model.visible) {
        a.model.position.copy(fm.pos);
        a.model.quaternion.copy(fm.quat);
        a.model.userData.update(fm, this.time, { stores: a.stores });
      }
    }
    // 잔해 화재
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.t -= dt;
      if (Math.random() < 0.7) this.effects.fire.spawn(w.pos.x + (Math.random() - 0.5) * 10, w.pos.y + 1, w.pos.z + (Math.random() - 0.5) * 10, 0, 8, 0, 0.8, 6, 3, 1, 0.6, 0.2, 0.8, 0.5, 2);
      if (Math.random() < 0.5) this.effects.smoke.spawn(w.pos.x, w.pos.y + 3, w.pos.z, 2, 12, 1, 9, 6, 40, 0.1, 0.1, 0.1, 0.7, 0.2, 1.5);
      if (w.t <= 0) this.wrecks.splice(i, 1);
    }
    // 종료 처리
    if (this.endTimer > 0) {
      this.endTimer -= dt;
      if (this.endTimer <= 0) { this.endTimer = 999; this.onEnd?.(this.endSummary()); }
    }
  }

  endSummary() {
    const p = this.player;
    return {
      title: this.landed ? '착륙 성공' : this.bfm?.won ? '승리' : (p.fm.crashReason ? '임무 실패' : '임무 종료'),
      reason: p.fm.crashReason || '',
      kills: this.kills, wave: this.wave, time: this.time, mode: this.mode, maxG: p.fm.maxG,
    };
  }

  updateMode(dt) {
    const p = this.player, fm = p.fm;
    if (this.mode === 'bfm' && this.bfm) {
      const B = this.bfm, e = this.aircraft.find(a => a.side === 'red');
      B.warnT -= dt;
      if (e && B.phase === 'ingress') {
        const r = e.fm.pos.distanceTo(fm.pos);
        B.minR = Math.min(B.minR, r); B.t += dt;
        const opening = r > B.prevR;
        B.prevR = r;
        // 머지 판정: 최근접(2.5 km 이내) 통과 후 거리가 벌어지기 시작하면 교전 개시 (75초 경과 시 강제 개시)
        if ((opening && B.minR < 2500) || B.t > 75) {
          B.phase = 'fight';
          e.ai.holdFire = false; e.ai.ingressAlt = null;
          this.msg(this.bfmMissiles ? "FIGHT'S ON! — 교전 개시" : "FIGHT'S ON! — 기총 교전 개시", '255,220,120', 4);
          this.audio.click();
        }
        this.statusLine = `BFM  머지 전 · 사격 금지  ${(r / NM).toFixed(1)} NM`;
      } else if (e) {
        if ((!e.alive || e.fm.destroyed) && !B.won && p.alive && !fm.destroyed) { B.won = true; this.msg('승리! 적기 격추', '160,255,180', 5); this.endTimer = 6; }
        this.statusLine = B.won ? 'BFM  승리' : `BFM  FIGHT'S ON  ${Math.round(e.fm.pos.distanceTo(fm.pos))} m  탄 ${fm.ammo}` + (this.bfmMissiles ? `  9X ${p.stores.aim9} · 120 ${p.stores.aim120}` : '');
      }
    } else this.statusLine = '';
  }

  // ------------------------------------------------------------------ G 효과 (G-LOC 모델)
  updateGEffects(dt) {
    const p = this.player, s = p.fm.s;
    if (!this.opts.gEffects || !p.alive) { this.gEffect.black = Math.max(0, this.gEffect.black - dt); this.gEffect.red = Math.max(0, this.gEffect.red - dt); return; }
    const nz = s.nz;
    // 내성: G-슈트 + AGSM 기준. 6G 초과분의 제곱에 비례해 누적, 5G 미만에서 회복
    if (nz > 6) this.gStrain += 0.02 * (nz - 6) ** 2 * dt;
    else if (nz < 5) this.gStrain -= (0.22 + 0.04 * (5 - nz)) * dt;
    this.gStrain = clamp(this.gStrain, 0, 1.3);
    // 즉시 시야 협착 (고 G 급격 진입)
    const instant = smoothstep(7.2, 10.5, nz) * 0.35;
    this.gEffect.black = clamp(Math.max(smoothstep(0.25, 1.0, this.gStrain), instant), 0, 1);
    if (this.gStrain > 1.12 && this.glocT <= 0) { this.glocT = 4; this.msg('G-LOC (의식 상실)', '255,120,100', 3); }
    if (this.glocT > 0) { this.glocT -= dt; this.gEffect.black = 1; if (this.glocT <= 0) this.gStrain = 0.6; }
    const red = nz < -2 ? smoothstep(-2, -4, nz) : 0;
    this.gEffect.red += (red - this.gEffect.red) * Math.min(1, dt * 2);
    this.gEffect.red = Math.max(this.gEffect.red, this.flashDamage * 0.4);
  }

  // ------------------------------------------------------------------ 파티클 이펙트
  updateEffects(dt) {
    const fx = this.effects, cam = this.camera.position;
    for (const a of this.aircraft) {
      const fm = a.fm, s = fm.s;
      if (!a.alive || !a.model.visible) continue;
      const dCam = fm.pos.distanceTo(cam);
      if (dCam > 25000) { a.vapor.visible = false; continue; }
      const toW = (x, y, z) => aeroToLocal(_v.set(x, y, z), _v2).applyQuaternion(fm.quat).add(fm.pos);
      const alt = fm.pos.y;
      const humid = smoothstep(7000, 1500, alt);
      // 베이퍼 콘
      const cone = smoothstep(0.93, 0.98, s.M) * (1 - smoothstep(1.01, 1.06, s.M)) * (0.3 + 0.7 * humid);
      a.vapor.visible = cone > 0.02;
      if (a.vapor.visible) { a.vapor.material.uniforms.uOpacity.value = cone * 0.75; a.vapor.material.uniforms.uTime.value = this.time; }
      // 비행운 (고고도)
      const contrail = smoothstep(8200, 9500, alt) * (1 - smoothstep(15000, 17000, alt));
      // 익단 와류 / 날개 상면 응결
      const vort = smoothstep(4.0, 7.0, s.nz) * (0.25 + 0.75 * humid) * (s.V > 100 ? 1 : 0);
      const step = Math.max(1, Math.floor(fm.vel.length() * dt / 6));
      for (let k = 0; k < step; k++) {
        const back = (k / step) * dt;
        if (contrail > 0.02) {
          for (const y of [-0.68, 0.68]) {
            const pp = toW(-9.5, y, 0.06).addScaledVector(fm.vel, -back);
            fx.smoke.spawn(pp.x, pp.y, pp.z, 0, 0, 0, 30, 2.5, 22, 1, 1, 1, 0.42 * contrail, 0.05, 0);
          }
        }
        if (vort > 0.03) {
          for (const y of [-6.6, 6.6]) {
            const pp = toW(-2.8, y, 0.35).addScaledVector(fm.vel, -back);
            fx.smoke.spawn(pp.x, pp.y, pp.z, 0, 0, 0, 0.7, 0.5, 2.2, 1, 1, 1, 0.55 * vort, 0.3, 0);
          }
        }
      }
      if (s.nz > 5.5 && humid > 0.3 && Math.random() < 0.8) {
        for (const y of [-3.2, 3.2]) {
          const pp = toW(-0.5 - Math.random() * 2, y + (Math.random() - 0.5) * 2.5, -0.6);
          fx.smoke.spawn(pp.x, pp.y, pp.z, fm.vel.x * 0.85, fm.vel.y * 0.85, fm.vel.z * 0.85, 0.22, 2.5, 4.5, 1, 1, 1, 0.3 * smoothstep(5.5, 8, s.nz) * humid, 4, 0);
        }
      }
      // 기관포 총구 화염 (우측 날개 뿌리)
      if (a.gunFiring) {
        const mz = toW(2.4, 1.95, -0.25);
        for (let i = 0; i < 2; i++) fx.fire.spawn(mz.x, mz.y, mz.z, fm.vel.x, fm.vel.y, fm.vel.z, 0.05, 2.2 + Math.random() * 1.6, 0.6, 1, 0.85, 0.5, 1, 0, 0);
      }
      // 저공 고속 먼지
      if (s.agl < 25 && s.V > 120 && !this.world.isWater(fm.pos.x, fm.pos.z) && Math.random() < 0.7) {
        const gp = fm.pos.clone(); gp.y = this.world.heightAt(gp.x, gp.z) + 1;
        fx.smoke.spawn(gp.x, gp.y, gp.z, fm.vel.x * 0.1 + (Math.random() - 0.5) * 20, 6, fm.vel.z * 0.1 + (Math.random() - 0.5) * 20, 3, 4, 18, 0.55, 0.5, 0.42, 0.5, 0.8, 0);
      }
      // 착지 타이어 연기
      if (fm.touchdownEvent > 0) {
        for (const g of fm.data.gear) {
          if (g.name === 'NOSE' && Math.random() < 0.5) continue;
          const pp = toW(g.r[0], g.r[1], -g.r[2] + 0.15);
          for (let i = 0; i < 10 * fm.touchdownEvent; i++) fx.smoke.spawn(pp.x, pp.y, pp.z, fm.vel.x * 0.3 + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, fm.vel.z * 0.3 + (Math.random() - 0.5) * 3, 2.5, 1.5, 9, 0.85, 0.85, 0.85, 0.6, 1.0, 0.3);
        }
        if (a === this.player) this.audio.thump(0.3 + fm.touchdownEvent * 0.5);
        fm.touchdownEvent = 0;
      }
      // 손상 연기 / 화재
      if (fm.hp < 60 || fm.destroyed) {
        a.fireT += dt;
        const sev = fm.destroyed ? 1 : (60 - fm.hp) / 60;
        const pp = toW(-6, 0, 0);
        if (Math.random() < 0.5 + sev * 0.5) { const gv = fm.destroyed ? 0.08 : 0.35; fx.smoke.spawn(pp.x, pp.y, pp.z, 0, 0, 0, 5 + sev * 5, 3, 16 + sev * 15, gv, gv, gv, 0.7, 0.2, 1); }
        if (fm.destroyed || fm.hp < 30) for (let i = 0; i < 2; i++) fx.fire.spawn(pp.x, pp.y, pp.z, fm.vel.x * 0.9, fm.vel.y * 0.9, fm.vel.z * 0.9, 0.25, 3, 1.2, 1, 0.45, 0.1, 0.45, 2.5, 0);
      }
    }
  }

  // ------------------------------------------------------------------ 카메라
  updateCamera(dt) {
    const cam = this.camera, p = this.player;
    if (!p) return;
    const fm = p.fm, I = this.input;
    const model = p.model;
    const parts = model.userData.parts;
    // 마우스 시점
    if (I.lookDX || I.lookDY) { this.look.yaw -= I.lookDX * 0.004; this.look.pitch -= I.lookDY * 0.004; this.padlock = false; }
    if (!I.a.freeLook && !this.padlock) { this.look.yaw *= Math.exp(-dt * 2.5); this.look.pitch *= Math.exp(-dt * 2.5); }
    if (I.wheel) {
      if (this.camMode === 'cockpit') cam.userData.fovBase = clamp((cam.userData.fovBase || 76) + I.wheel * 4, 30, 95);
      else this.camDist = clamp(this.camDist * (1 + I.wheel * 0.1), 0.5, 4);
    }
    const shakeAmp = (fm.s.buffet * 0.6 + this.effects.shake * 2 + (p.gunFiring ? 0.15 : 0)) * (this.camMode === 'cockpit' ? 0.012 : 0.05);
    const shake = () => (Math.random() - 0.5) * shakeAmp;
    const deadView = !p.alive || fm.crashed;
    // 적 추적 시점: C로 고정 선택하거나, 키를 누르고 있는 동안 일시 전환 (조종석에서는 패드락처럼 시선만 적에게)
    const tgt = (this.camMode === 'target' || I.a.targetView) && !deadView ? this.viewTarget() : null;
    if (this.camMode === 'target' && !tgt && !this._noTgtMsgT) { this.msg('추적할 적기 없음 — 추적 시점은 적이 있을 때만', '255,200,120', 2); this._noTgtMsgT = 4; }
    // 추적 토글 모드: 켜짐/꺼짐 알림 + 대상이 사라지면 자동 해제
    if (I.targetToggle && !deadView) {
      if (I._tvOn && !tgt) I._tvOn = false;
      if (I._tvOn !== this._tvMsgPrev) this.msg(I._tvOn ? '적 추적 켜짐' : '적 추적 꺼짐', '200,255,210', 1);
      this._tvMsgPrev = I._tvOn;
    }
    this._noTgtMsgT = Math.max(0, (this._noTgtMsgT || 0) - dt);
    const mode = tgt && this.camMode !== 'cockpit' ? 'target' : (this.camMode === 'target' ? 'chase' : this.camMode);
    const padlockNow = this.camMode === 'cockpit' && tgt && I.a.targetView;
    if (mode !== 'target') this.camTInit = false;
    parts.cockpitGroup.visible = mode === 'cockpit' && !deadView;
    parts.pilotGroup.visible = mode !== 'cockpit';
    let fov = 62;

    if (deadView) {
      // 격추·추락: 마지막 카메라 위치에서 잔해를 바라봄 (너무 멀어지면 150 m 거리로 따라감)
      if (!this.deathCam) this.deathCam = cam.position.clone();
      const off = _v.subVectors(this.deathCam, fm.pos);
      if (off.length() > 150) this.deathCam.copy(fm.pos).addScaledVector(off.normalize(), 150);
      this.deathCam.y = Math.max(this.deathCam.y, this.world.heightAt(this.deathCam.x, this.deathCam.z) + 20);
      cam.position.copy(this.deathCam);
      cam.up.set(0, 1, 0);
      cam.lookAt(fm.pos);
    } else if (mode === 'cockpit') {
      // 패드락: 록된 표적(또는 추적 키를 누른 동안 가장 가까운 적) 방향으로 시선
      const pl = padlockNow ? tgt : (this.padlock && p.lock && p.lock.alive ? p.lock : null);
      if (pl) {
        _q.copy(fm.quat).invert();
        _v.subVectors(pl.fm.pos, fm.pos).applyQuaternion(_q).normalize();
        const ty = Math.atan2(-_v.x, -_v.z), tp = Math.asin(clamp(_v.y, -1, 1));
        this.look.yaw += (clamp(ty, -2.8, 2.8) - this.look.yaw) * Math.min(1, dt * 6);
        this.look.pitch += (clamp(tp, -0.7, 1.5) - this.look.pitch) * Math.min(1, dt * 6);
      }
      this.look.yaw = clamp(this.look.yaw, -2.9, 2.9);
      this.look.pitch = clamp(this.look.pitch, -0.8, 1.55);
      // 조종사 눈 위치 (G에 의한 머리 처짐)
      const sag = clamp((fm.s.nz - 1) * 0.012, -0.05, 0.1);
      _v.set(0, 1.12 - sag, -4.75).applyQuaternion(fm.quat);
      cam.position.copy(fm.pos).add(_v);
      _e.set(this.look.pitch - 0.07 + shake(), this.look.yaw + shake(), 0, 'YXZ');   // 기본 시선 4° 아래
      _q.setFromEuler(_e);
      cam.quaternion.copy(fm.quat).multiply(_q);
      fov = cam.userData.fovBase || 76;
    } else if (mode === 'target') {
      // 내 기체 뒤-위에서 적 방향을 바라봄: 내 기체는 화면 아래, 적은 화면 중앙 부근 (거리에 따라 시야각 조절)
      const tp = tgt.fm.pos;
      const toT = _v2.subVectors(tp, fm.pos);
      const range = toT.length();
      toT.normalize();
      // 카메라 '위' 방향: 내 기체의 위쪽과 월드 위쪽을 섞어 안정적으로 (배면 비행 시에도 어지럽지 않게)
      const acUp = _v.set(0, 1, 0).applyQuaternion(fm.quat);
      const up = new THREE.Vector3(0, 1, 0).lerp(acUp, 0.35).normalize();
      if (Math.abs(up.dot(toT)) > 0.95) up.copy(acUp);
      const side = new THREE.Vector3().crossVectors(toT, up).normalize();
      const camUp = new THREE.Vector3().crossVectors(side, toT).normalize();
      const dist = 26 * this.camDist;
      const pos = fm.pos.clone().addScaledVector(toT, -dist).addScaledVector(camUp, 7 * this.camDist + 1.5);
      // 적과 내 기체의 중간을 약간 적 쪽으로 바라봄
      const look = fm.pos.clone().addScaledVector(toT, Math.min(range, 400));
      const m = new THREE.Matrix4().lookAt(pos, look, camUp);
      const qT = new THREE.Quaternion().setFromRotationMatrix(m);
      if (!this.camTInit) { this.camTQ.copy(qT); this.camTInit = true; }
      this.camTQ.slerp(qT, 1 - Math.exp(-dt * 6));   // 회전만 부드럽게 (위치는 기체에 고정 → 고속에서도 뒤처지지 않음)
      cam.position.copy(pos);
      cam.quaternion.copy(this.camTQ);
      cam.position.x += shake(); cam.position.y += shake();
      fov = clamp(62 + clamp(fm.s.V / 40, 0, 8) - clamp((range - 1500) / 400, 0, 12), 50, 70);
    } else if (mode === 'chase') {
      this.chaseQ.slerp(fm.quat, 1 - Math.exp(-dt * 7));
      const dist = 22 * this.camDist;
      _e.set(this.look.pitch - 0.09, this.look.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      const q = this.chaseQ.clone().multiply(_q);
      _v.set(0, 4.2 * this.camDist + 0.5, dist).applyQuaternion(q);
      cam.position.copy(fm.pos).add(_v);
      cam.quaternion.copy(q);
      cam.position.x += shake(); cam.position.y += shake();
      fov = 60 + clamp(fm.s.V / 40, 0, 10);
    }
    // 지형 아래로 카메라가 들어가지 않도록
    const gh = this.world.heightAt(cam.position.x, cam.position.z) + 1.5;
    if (cam.position.y < gh) cam.position.y = gh;
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 5 + (dt === 0 ? 1 : 0)); cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }
}
