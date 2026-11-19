// F-15C 6자유도(6-DOF) 강체 비행역학 모델
// - 위치/속도: three.js 월드 좌표 (X 동, Y 위, -Z 북)
// - 각속도/힘/모멘트: 공력 기체좌표 (x 기수, y 우측, z 아래)
// - 구성: ISA 대기, 공력계수, 2x F100 엔진(스풀/애프터버너/연료), CAS(NDI 제어법칙),
//         랜딩기어 스프링-댐퍼, 지면효과, 오일러 강체 방정식, 쿼터니언 적분
import * as THREE from 'three';
import { isa, casFromMach, totalPressure, P0 } from './atmosphere.js';
import { F15C, aeroCoeffs, alphaForCL, clBasic } from './f15.js';
import { G0, D2R, clamp, lerp, moveToward } from './math.js';

// 좌표 변환: three 로컬(기수 -Z, 위 +Y, 우측 +X) ↔ 공력 좌표
export const localToAero = (v, out) => out.set(-v.z, v.x, -v.y);
export const aeroToLocal = (a, out) => out.set(a.y, -a.z, -a.x);

const _qInv = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _wWorld = new THREE.Vector3();
const _rw = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _F = new THREE.Vector3();
const _Fw = new THREE.Vector3();     // 월드 좌표 합력 (지면 접촉)
const _Mw = new THREE.Vector3();     // 월드 좌표 합모멘트 (지면 접촉)
const _Fb = new THREE.Vector3();     // 기체 좌표 합력
const _Mb = new THREE.Vector3();     // 기체 좌표 합모멘트
const _tmp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// 엔진: P&W F100-PW-220 (코어 스풀 지연, A/B 점화 지연, 추력 감률, 연료 소모)
// ---------------------------------------------------------------------------
export class Engine {
  constructor(d) {
    this.d = d;
    this.n = d.idleN;      // 코어 회전수 비율 (1.0 = MIL)
    this.ab = 0;           // 애프터버너 단계 (0..1)
    this.abTimer = 0;
    this.thrust = 0;
    this.ff = 0;           // 연료유량 kg/s
    this.failed = false;
    this.nozzle = 0;       // 노즐 개도 0..1 (시각효과)
  }
  update(dt, throttle, atm, M, fuelOk) {
    const d = this.d;
    const alive = !this.failed && fuelOk;
    const dry = clamp(throttle / 0.8, 0, 1);
    const nCmd = alive ? d.idleN + (1 - d.idleN) * dry : 0.12 * Math.min(M, 1); // 정지 시 풍차회전
    const up = nCmd > this.n;
    const maxRate = up ? (this.n < 0.85 ? 0.11 : 0.17) : 0.3;
    this.n += clamp((nCmd - this.n) * (up ? 1.6 : 2.2), -maxRate, maxRate) * dt;

    const wantAB = alive && throttle > 0.802 && this.n > 0.965;
    if (wantAB) {
      this.abTimer += dt;
      if (this.abTimer > 0.4) {               // 점화 지연
        const abCmd = 0.12 + 0.88 * clamp((throttle - 0.8) / 0.2, 0, 1);
        this.ab = moveToward(this.ab, abCmd, 1.1 * dt);
      }
    } else {
      this.abTimer = 0;
      this.ab = moveToward(this.ab, 0, 3 * dt);
    }

    // 추력 감률 (밀도비, 램 효과, 압축기 입구 온도/연소실 압력 제한)
    const lapse = Math.pow(atm.sigma, 0.8);
    const fMil = Math.max(0.2, 1 + 0.1 * M - 0.2 * M * M);
    const fAB = 1 + 0.2 * M + 0.08 * M * M;
    const t2 = atm.T * (1 + 0.2 * M * M);
    let lim = t2 > 470 ? Math.max(0, 1 - (t2 - 470) / 55) : 1;
    const ptRatio = totalPressure(M, atm.p) / P0;
    if (ptRatio > 2.2) lim *= 1 / (1 + ((ptRatio - 2.2) / 0.5) ** 2);
    const nf = clamp((this.n - d.idleN) / (1 - d.idleN), 0, 1);
    const dryT = this.n < d.idleN * 0.9 ? 0 : d.milSL * lapse * fMil * (0.05 + 0.95 * Math.pow(nf, 1.7)) * lim;
    const abT = Math.max(0, d.abSL * fAB - d.milSL * fMil) * lapse * this.ab * lim;
    this.thrust = dryT + abT;
    this.ff = alive ? Math.max(0.055, dryT * d.tsfcDry * (1 + 0.2 * M) + abT * d.tsfcAB) : 0;
    this.nozzle = lerp(this.nozzle, this.ab > 0 ? 0.4 + 0.6 * this.ab : (nf < 0.3 ? 0.55 : 0.1), Math.min(1, dt * 2));
    return this.thrust;
  }
}

// ---------------------------------------------------------------------------
// 비행조종계통: CAS(Control Augmentation System) — 비선형 동적역변환(NDI)
// 피치: 스틱 → 하중배수(G) 명령, 받음각 제한 / 롤: 안정축 롤레이트 명령 / 요: 선회 협조 + 옆미끄럼 제어
// ---------------------------------------------------------------------------
class FCS {
  constructor() {
    this.nzI = 0;
    this.nzF = 1;
    this.alphaDot = 0;
    this.prevAlpha = 0;
    this.qDot = 0;
    this.prevQ = 0;
    this.blend = 0;
    this.out = { de: 0, da: 0, dr: 0 };
    this.alphaLimited = false;
  }
  reset() { this.nzI = 0; this.nzF = 1; this.blend = 0; }

  compute(ac, s, A, dt) {
    const d = ac.data, c = ac.ctl, L = d.surf;
    // 직결(DIRECT) 명령 — 기계식 조종
    const deD = (c.pitch >= 0 ? c.pitch * L.deUp : c.pitch * L.deDown) + c.trim * 10 * D2R;
    const daD = c.roll * L.daMax;
    const drD = c.yaw * L.drMax;
    const o = this.out;

    this.blend = ac.wow ? 0 : Math.min(1, this.blend + dt / 1.2);
    // 받음각 변화율 (저역 필터)
    this.alphaDot += ((s.alpha - this.prevAlpha) / dt - this.alphaDot) * Math.min(1, dt / 0.04);
    this.prevAlpha = s.alpha;
    if (!ac.casOn || s.qbar < 300 || this.blend <= 0 || ac.destroyed) {
      o.de = deD; o.da = daD; o.dr = drD;
      this.nzI = 0;
      this.nzF = Math.max(-1, Math.min(3, s.nz || 1));
      this.alphaLimited = false;
      return o;
    }

    const W = ac.mass * G0;
    const V = Math.max(s.V, 40);
    const lim = d.limits;
    const nzMax = (ac.mass < 23000 ? lim.nzMax : lerp(lim.nzMax, 7.33, clamp((ac.mass - 23000) / 7000, 0, 1))) + (ac.nzBonus || 0);
    const nzMin = lim.nzMin;
    const nzRaw = c.pitch >= 0 ? 1 + c.pitch * (nzMax - 1) : 1 + c.pitch * (1 - nzMin);
    // 명령 전치필터 (급격한 G 오버슈트 방지). 하중을 풀 때(언로드)는 더 천천히 → 스틱을 놓아도 기수가 툭 떨어지지 않음
    const tauNz = ac.smoothUnload && Math.abs(nzRaw - 1) < Math.abs(this.nzF - 1) ? 0.4 : 0.22;   // 플레이어 기체만 (AI는 빠른 응답 유지)
    this.nzF += (nzRaw - this.nzF) * Math.min(1, dt / tauNz);
    const nzCmd = this.nzF;

    // 요구 하중배수 → 요구 받음각 (공력모델 역산)
    const qS = Math.max(s.qbar * d.S, 1);
    const aMax = lim.alphaCAS, aMin = lim.alphaCASneg;
    let aCmd = alphaForCL((nzCmd * W) / qS, s.M, ac.flapPos, aMin, aMax) + this.nzI;
    const aClamped = clamp(aCmd, aMin, aMax);
    this.alphaLimited = aClamped !== aCmd || aCmd >= aMax - 1e-4;
    aCmd = aClamped;
    const nzAch = ((clBasic(aCmd, s.M) + 0.2 * ac.flapPos) * qS) / W;
    const nzFF = clamp(Math.min(nzCmd, nzAch), nzMin, nzMax);
    const qFF = (G0 * (nzFF - Math.cos(s.theta) * Math.cos(s.phi))) / V;
    // G 제한기: 한계 초과 시 피치레이트 감소
    const over = Math.max(0, s.nz - nzMax) - Math.max(0, nzMin - s.nz);
    // 받음각 변화율 예측(감쇠) 포함
    const aPred = s.alpha + 0.2 * this.alphaDot;   // 받음각 변화율 예측을 키워 피치 진동(출렁임) 감쇠
    let qCmd = qFF + 2.8 * (aCmd - aPred) - (1.5 * G0 * over) / V;
    if (ac.rateCmd) {
      // 플레이어: 피치레이트 명령 + 자세 유지(RCAH). 스틱 = 기수 회전 속도, 놓으면 기수가 그 자리에 멈춤
      // (G 명령 방식은 스틱을 놓아도 비행경로가 따라오는 동안 기수가 더 올라갔다가 받음각이 풀리며 떨어짐 → 조준이 출렁임)
      // G·받음각 한계는 그대로: 최대 G 법칙이 내는 피치레이트를 상한/하한으로 사용
      const lawQ = (nz) => {
        const a = clamp(alphaForCL((nz * W) / qS, s.M, ac.flapPos, aMin, aMax), aMin, aMax);
        const nA = ((clBasic(a, s.M) + 0.2 * ac.flapPos) * qS) / W;
        const nF = clamp(nz > 1 ? Math.min(nz, nA) : Math.max(nz, nA), nzMin, nzMax);
        return (G0 * (nF - Math.cos(s.theta) * Math.cos(s.phi))) / V + 2.8 * (a - aPred) - (1.5 * G0 * over) / V;
      };
      const cg = Math.cos(s.theta) * Math.cos(s.phi);
      const qUp = Math.min(0.75, (1.5 * G0 * (nzMax - cg)) / V), qDn = Math.min(0.4, (1.3 * G0 * (cg - nzMin)) / V);   // 최대 G 정상 선회율의 1.5배까지 → G 제한기가 9G에서 잡음 (빠른 G 온셋)
      const qR = c.pitch >= 0 ? c.pitch * qUp : c.pitch * qDn;
      // 받음각 증가 속도 제한: 기수가 비행경로보다 너무 앞서 돌면(받음각 급증) 놓았을 때 멈출 수 없음
      //  → 스틱 방향으로는 '현재 비행경로 회전율 + 받음각 변화 14°/s'까지만 명령. 스틱을 놓을 때(0)는 제한 없이 기수 정지
      const qPath = (G0 * (s.nz - cg)) / V, aDotLim = 0.25;
      let qL = qR;
      if (c.pitch > 0) qL = Math.min(qR, Math.max(qPath + aDotLim, 0.05));
      else if (c.pitch < 0) qL = Math.max(qR, Math.min(qPath - aDotLim, -0.05));
      // 스틱 중립 = 비행경로 유지: 기수를 즉시 멈추고(자세 유지), 0.3초 뒤 그 기수 자세가 만드는 비행경로각을 목표로 잡는다
      //  (수평 ±2° 이내면 수평). 이후 목표 자세 = 목표 경로 + 지금 속도의 트림 받음각 → 기수는 놓은 자리에 머물고,
      //  감속하면 받음각만큼 기수가 천천히 들려 경로(고도)를 지킨다. 순수 자세 유지는 감속할수록 받음각이 커져 경로가 내려가
      //  고도를 속도로 바꿔 버린다 (스로틀을 줄여도 계기 속도가 거의 안 줄어듦)
      if (Math.abs(c.pitch) < 0.02 && Math.abs(s.phi) < 60 * D2R && Math.abs(s.theta) < 60 * D2R) {
        this.relT = (this.relT || 0) + dt;
        const cphi = Math.cos(s.phi);
        const gam = Math.asin(clamp(s.vs / Math.max(s.V, 1), -1, 1));
        const aTrim = clamp(alphaForCL((W * Math.cos(gam)) / (qS * cphi), s.M, ac.flapPos, aMin, aMax), aMin, aMax) * cphi;
        if (this.gHold == null && this.relT > 0.3) { const gh = s.theta - aTrim; this.gHold = Math.abs(gh) < 2 * D2R ? 0 : gh; }
        if (this.gHold != null) {
          const thT = this.gHold + aTrim + clamp(0.5 * (this.gHold - gam), -0.035, 0.035);
          qL = clamp((1.2 * (thT - s.theta)) / cphi, -0.06, 0.06);
        }
      } else if (Math.abs(c.pitch) >= 0.02) { this.relT = 0; this.gHold = null; }
      qCmd = clamp(qL, Math.min(0, lawQ(nzMin)), Math.max(0, lawQ(nzMax)));
      this.nzF = s.nz; this.nzI = 0;
    }

    // 롤/요
    const aEff = clamp(s.alpha, -0.3, 0.6);
    const pMax = 4.0 * clamp(1 - 1.4 * Math.max(0, s.alpha - 0.25), 0.3, 1);
    const ps = c.roll * pMax;
    const betaCmd = -c.yaw * 0.12;
    const pCmd = ps * Math.cos(aEff);
    const rCmd = ps * Math.sin(aEff) + (G0 * Math.sin(s.phi) * Math.cos(s.theta)) / V + 2.5 * (s.beta - betaCmd);

    // NDI: 요구 각가속도 → 요구 모멘트 → 조종면
    const w = ac.omega, I = ac.I;
    const pd = 7 * (pCmd - w.x), rd = 4 * (rCmd - w.z);
    // 피치 각가속도 추정 (저역 필터) — 플레이어 피치레이트 명령에서 조종면 작동 지연을 앞질러 보상
    this.qDot += ((w.y - this.prevQ) / dt - this.qDot) * Math.min(1, dt / 0.03);
    this.prevQ = w.y;
    let qd = ac.rateCmd ? 16 * (qCmd - (w.y + 0.05 * this.qDot)) : 11 * (qCmd - w.y);
    if (ac.rateCmd) {
      // 피치 각가속도 제한: 스태빌레이터를 약 ±5° 이상 쓰지 않을 만큼만 → 놓았을 때 반대로 꺾는 시간(작동 속도 40°/s)이 짧아 기수가 즉시 멈춤
      const qdMax = clamp((0.08 * qS * d.c * Math.abs(A.Cmde)) / I.yy, 0.6, 6);
      qd = clamp(qd, -qdMax, qdMax);
    }
    const Ip = I.xx * w.x - I.xz * w.z, Iq = I.yy * w.y, Ir = I.zz * w.z - I.xz * w.x;
    const Mx = I.xx * pd - I.xz * rd + (w.y * Ir - w.z * Iq);
    const My = I.yy * qd + (w.z * Ip - w.x * Ir);
    const Mz = I.zz * rd - I.xz * pd + (w.x * Iq - w.y * Ip);
    const qSc = qS * d.c, qSb = qS * d.b;

    let de = (My / qSc - A.Cm) / A.Cmde;
    const ClReq = Mx / qSb - A.Cl, CnReq = Mz / qSb - A.Cn;
    const det = A.Clda * A.Cndr - A.Cldr * A.Cnda;
    let da = (ClReq * A.Cndr - A.Cldr * CnReq) / det;
    let dr = (A.Clda * CnReq - A.Cnda * ClReq) / det;

    de = clamp(de, -L.deDown, L.deUp);
    da = clamp(da, -L.daMax, L.daMax);
    dr = clamp(dr, -L.drMax, L.drMax);

    // 적분기 (G 추종 오차 보정, 포화 시 정지 → 와인드업 방지)
    const sat = this.alphaLimited || de >= L.deUp - 1e-3 || de <= -L.deDown + 1e-3;
    const nzErr = nzCmd - s.nz;
    if (!sat && Math.abs(nzErr) < 1.2) this.nzI = clamp(this.nzI + nzErr * 0.02 * dt, -0.02, 0.02);

    const bl = this.blend;
    o.de = lerp(deD, de, bl);
    o.da = lerp(daD, da, bl);
    o.dr = lerp(drD, dr, bl);
    return o;
  }
}

// ---------------------------------------------------------------------------
// 비행 모델 본체
// ---------------------------------------------------------------------------
export class FlightModel {
  constructor(opts = {}) {
    this.data = F15C;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.omega = new THREE.Vector3(); // p, q, r (rad/s)
    this.fuel = F15C.fuelInternal * (opts.fuelFrac ?? 1);
    this.infiniteFuel = false;
    this.thrustMul = 1;   // 추력 배율 (난이도 보정용)
    this.nzBonus = 0;     // CAS G 한계 가산 (난이도 보정용)
    this.storesMass = 0;
    this.storesDrag = 0;
    this.ammo = F15C.gunAmmo;

    this.ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, trim: 0 };
    this.gearCmd = true; this.flapCmd = false; this.sbCmd = false;
    this.gearPos = 1; this.flapPos = 0; this.sbPos = 0;
    this.surf = { de: 0, da: 0, dr: 0 };
    this.steer = 0;
    this.engines = [new Engine(F15C.engine), new Engine(F15C.engine)];
    this.fcs = new FCS();
    this.casOn = true;

    this.hp = 100;
    this.destroyed = false;   // 피격 파괴 (추락 중)
    this.crashed = false;     // 지면 충돌
    this.crashReason = '';
    this.wow = false;
    this.gearContact = [0, 0, 0];   // 압축량 (시각효과용)
    this.touchdownEvent = 0;        // 바퀴 접지 충격 이벤트 (타이어 연기)
    this.time = 0;
    this.overG = 0;
    this.maxG = 1;
    this.I = { xx: 0, yy: 0, zz: 0, xz: 0 };

    this.A = {};       // 공력 계수 작업 공간
    // 표시/분석용 출력
    this.s = {
      alpha: 0, beta: 0, V: 0, M: 0, qbar: 0, cas: 0, rho: 1.225, T: 288, a: 340,
      nz: 1, ny: 0, nx: 0, phi: 0, theta: 0, psi: 0, gamma: 0, track: 0,
      thrust: 0, drag: 0, lift: 0, ff: 0, agl: 0, vs: 0, ps: 0, buffet: 0,
      CL: 0, CD: 0, heading: 0,
    };
    this._prevPos = new THREE.Vector3();
    this.aeroIn = { alpha: 0, beta: 0, M: 0, phat: 0, qhat: 0, rhat: 0, flaps: 0, sb: 0, gear: 0, agl: 100, stores: 0, t: 0 };
    this._wasOnGround = [false, false, false];
  }

  get mass() {
    return F15C.massEmpty + F15C.massCrew + this.fuel + this.storesMass + this.ammo * F15C.roundMass;
  }

  updateInertia() {
    const r = F15C.inertiaRef, k = 0.55 + 0.45 * (this.mass / r.mass);
    this.I.xx = r.Ixx * k; this.I.yy = r.Iyy * k; this.I.zz = r.Izz * k; this.I.xz = r.Ixz * k;
  }

  /** 초기 상태 설정. heading: 도(0=북), speed: m/s */
  reset({ pos, heading = 0, pitch = 0, speed = 0, gear = true, onGround = false, throttle = 0 }) {
    this.pos.copy(pos);
    const e = new THREE.Euler(pitch * D2R, -heading * D2R, 0, 'YXZ');
    this.quat.setFromEuler(e);
    this.vel.set(0, 0, -speed).applyQuaternion(this.quat);
    this.omega.set(0, 0, 0);
    this.gearCmd = gear; this.gearPos = gear ? 1 : 0;
    this.flapCmd = false; this.flapPos = 0; this.sbCmd = false; this.sbPos = 0;
    this.ctl.throttle = throttle; this.ctl.pitch = this.ctl.roll = this.ctl.yaw = 0; this.ctl.trim = 0;
    for (const en of this.engines) {
      en.failed = false;
      en.n = throttle > 0 ? F15C.engine.idleN + (1 - F15C.engine.idleN) * Math.min(throttle / 0.8, 1) : F15C.engine.idleN;
      en.ab = 0;
    }
    this.hp = 100; this.destroyed = false; this.crashed = false; this.crashReason = '';
    this.wow = onGround;
    this.fcs.reset();
    if (!onGround) this.fcs.blend = 1;
    this.fcs.gHold = onGround ? null : Math.abs(pitch) < 2 ? 0 : pitch * D2R; this.fcs.relT = onGround ? 0 : 1;   // 공중 시작: 처음부터 그 경로(수평) 유지
    this.maxG = 1; this.overG = 0;
    this.surf.de = this.surf.da = this.surf.dr = 0;
    this._wasOnGround = [onGround, onGround, onGround];
  }

  damage(amount, cause = '') {
    if (this.crashed) return;
    this.hp -= amount;
    if (this.hp < 45 && Math.random() < 0.3 * Math.min(1, amount / 10)) this.engines[Math.random() < 0.5 ? 0 : 1].failed = true;
    if (this.hp <= 0 && !this.destroyed) {
      this.destroyed = true;
      this.crashReason = cause || '격추됨';
      for (const en of this.engines) en.failed = true;
    }
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.destroyed = true;
    this.crashReason = this.crashReason || reason;
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
  }

  /** 한 적분 단계 (dt는 1/240 s 정도) */
  step(dt, world) {
    if (this.crashed) return;
    this.time += dt;
    const d = F15C, s = this.s, A = this.A, ai = this.aeroIn;
    this.updateInertia();
    const m = this.mass;

    // ---- 대기 및 대기속도
    const atm = isa(this.pos.y);
    _qInv.copy(this.quat).invert();
    const vb = localToAero(_v.copy(this.vel).applyQuaternion(_qInv), _v2);
    const V = vb.length();
    const alpha = V > 0.5 ? Math.atan2(vb.z, vb.x) : 0;
    const beta = V > 0.5 ? Math.asin(clamp(vb.y / V, -1, 1)) : 0;
    const qbar = 0.5 * atm.rho * V * V;
    const M = V / atm.a;
    const groundH = world.heightAt(this.pos.x, this.pos.z);
    const agl = this.pos.y - groundH - 2.1;

    // 자세각 (오일러)
    _fwd.set(0, 0, -1).applyQuaternion(this.quat);
    const theta = Math.asin(clamp(_fwd.y, -1, 1));
    _side.set(1, 0, 0).applyQuaternion(this.quat);
    const upB = _v3.set(0, 1, 0).applyQuaternion(this.quat);
    const phi = Math.atan2(-_side.y, upB.y);

    s.alpha = alpha; s.beta = beta; s.V = V; s.M = M; s.qbar = qbar;
    s.rho = atm.rho; s.T = atm.T; s.a = atm.a; s.theta = theta; s.phi = phi; s.agl = agl;

    // ---- 기계 계통 (기어/플랩/스피드브레이크 작동)
    const cas = casFromMach(M, atm.p);
    s.cas = cas;
    if (this.flapCmd && cas > d.limits.flapSpeed + 8) this.flapCmd = false;   // 플랩 자동 수납
    this.gearPos = moveToward(this.gearPos, this.gearCmd ? 1 : 0, dt / 4.5);
    this.flapPos = moveToward(this.flapPos, this.flapCmd ? 1 : 0, dt / 3);
    const sbTarget = this.sbCmd && alpha < 25 * D2R ? 1 : 0;
    this.sbPos = moveToward(this.sbPos, sbTarget, dt / 2);

    // ---- 기본 공력계수 (조종면 0)
    const Vd = Math.max(V, 15);
    ai.alpha = alpha; ai.beta = beta; ai.M = M;
    ai.phat = (this.omega.x * d.b) / (2 * Vd);
    ai.qhat = (this.omega.y * d.c) / (2 * Vd);
    ai.rhat = (this.omega.z * d.b) / (2 * Vd);
    ai.flaps = this.flapPos; ai.sb = this.sbPos; ai.gear = this.gearPos; ai.agl = agl;
    ai.stores = this.storesDrag; ai.t = this.time;
    aeroCoeffs(ai, A);

    // ---- 조종계통 → 구동기 (속도 제한)
    const cmd = this.fcs.compute(this, s, A, dt);
    const L = d.surf;
    const dmgCtl = this.destroyed ? 0 : 1;
    this.surf.de = moveToward(this.surf.de, clamp(cmd.de * dmgCtl, -L.deDown, L.deUp), L.deRate * dt);
    this.surf.da = moveToward(this.surf.da, clamp(cmd.da * dmgCtl, -L.daMax, L.daMax), L.daRate * dt);
    this.surf.dr = moveToward(this.surf.dr, clamp(cmd.dr * dmgCtl, -L.drMax, L.drMax), L.drRate * dt);
    const de = this.surf.de, da = this.surf.da, dr = this.surf.dr;

    const CL = A.CL + A.CLde * de;
    const CD = A.CD + A.CDde * de * de + 0.02 * (da * da + dr * dr);
    const CY = A.CY + A.CYdr * dr;
    let Cl = A.Cl + A.Clda * da + A.Cldr * dr;
    const Cm = A.Cm + A.Cmde * de;
    let Cn = A.Cn + A.Cnda * da + A.Cndr * dr;
    if (this.destroyed && !this.crashed) { Cl += 0.02; Cn += 0.006; } // 손상 기체의 비대칭

    // ---- 공력 (기체 좌표)
    _Fb.set(0, 0, 0);
    _Mb.set(0, 0, 0);
    if (V > 0.5) {
      const ux = vb.x / V, uy = vb.y / V, uz = vb.z / V;
      // 양력 방향 = ŷ × V̂ (정규화)
      let lx = uz, lz = -ux;
      const ln = Math.hypot(lx, lz) || 1;
      lx /= ln; lz /= ln;
      const qS = qbar * d.S;
      const Lf = CL * qS, Df = CD * qS, Yf = CY * qS;
      _Fb.x += -Df * ux + Lf * lx;
      _Fb.y += -Df * uy + Yf;
      _Fb.z += -Df * uz + Lf * lz;
      _Mb.x += Cl * qS * d.b;
      _Mb.y += Cm * qS * d.c;
      _Mb.z += Cn * qS * d.b;
      s.lift = Lf; s.drag = Df; s.CL = CL; s.CD = CD;
    }
    s.buffet = A.buffet;

    // ---- 엔진 추력
    const fuelOk = this.fuel > 0 || this.infiniteFuel;
    let thrust = 0, ff = 0;
    const e = this.engines;
    for (let i = 0; i < e.length; i++) {
      const T = e[i].update(dt, this.ctl.throttle, atm, M, fuelOk);
      thrust += T; ff += e[i].ff;
      _Mb.z += (i === 0 ? 1 : -1) * T * d.engine.yOffset; // 좌측(i=0) 엔진 추력 → 기수 우측
    }
    thrust *= this.thrustMul;   // 기체 성능 보정 (기본 1, '전설' 난이도 적기는 추력 우위)
    _Fb.x += thrust;
    if (!this.infiniteFuel) this.fuel = Math.max(0, this.fuel - ff * dt);
    s.thrust = thrust; s.ff = ff;

    // ---- 지면 접촉 (랜딩기어 + 동체)
    _Fw.set(0, 0, 0);
    _Mw.set(0, 0, 0);
    aeroToLocal(this.omega, _wWorld).applyQuaternion(this.quat);
    this.wow = false;
    if (this.pos.y - groundH < 25) this.groundContact(dt, world, s);
    // 월드 힘/모멘트 → 기체 좌표로 합산
    if (_Fw.lengthSq() > 0) {
      localToAero(_tmp.copy(_Fw).applyQuaternion(_qInv), _F);
      _Fb.add(_F);
      localToAero(_tmp.copy(_Mw).applyQuaternion(_qInv), _F);
      _Mb.add(_F);
    }

    // ---- 하중배수 (조종사가 느끼는 G)
    s.nz = -_Fb.z / (m * G0);
    s.ny = _Fb.y / (m * G0);
    s.nx = _Fb.x / (m * G0);
    if (!this.wow) this.maxG = Math.max(this.maxG, s.nz);
    if (s.nz > d.limits.nzMax + 0.3 || s.nz < d.limits.nzMin - 0.3) this.overG += dt; else this.overG = Math.max(0, this.overG - dt * 0.5);
    if (!this.destroyed && (s.nz > d.limits.nzStructural || s.nz < d.limits.nzStructuralNeg)) {
      this.damage(200, '구조 파손 (과하중 ' + s.nz.toFixed(1) + 'G)');
    }
    if (!this.destroyed && cas > d.limits.vneCAS * 1.12) this.damage(60 * dt, '과속으로 인한 구조 파손');

    // ---- 병진 운동 적분 (반암시적 오일러)
    aeroToLocal(_Fb, _F).applyQuaternion(this.quat); // 월드 힘
    this.vel.x += (_F.x / m) * dt;
    this.vel.y += (_F.y / m - G0) * dt;
    this.vel.z += (_F.z / m) * dt;
    this._prevPos.copy(this.pos);
    this.pos.addScaledVector(this.vel, dt);

    // ---- 회전 운동: I·ω̇ = M − ω × (I·ω)
    const I = this.I, w = this.omega;
    const Ip = I.xx * w.x - I.xz * w.z, Iq = I.yy * w.y, Ir = I.zz * w.z - I.xz * w.x;
    const rx = _Mb.x - (w.y * Ir - w.z * Iq);
    const ry = _Mb.y - (w.z * Ip - w.x * Ir);
    const rz = _Mb.z - (w.x * Iq - w.y * Ip);
    // [Ixx -Ixz; -Ixz Izz] 역행렬
    const det = I.xx * I.zz - I.xz * I.xz;
    const pd = (I.zz * rx + I.xz * rz) / det;
    const rd = (I.xz * rx + I.xx * rz) / det;
    const qd = ry / I.yy;
    w.x += pd * dt; w.y += qd * dt; w.z += rd * dt;
    // 수치 안전장치
    const wl = w.length();
    if (wl > 12) w.multiplyScalar(12 / wl);

    // ---- 자세 적분 (기체 좌표 회전 → 쿼터니언 후곱)
    aeroToLocal(w, _tmp);
    const ang = _tmp.length() * dt;
    if (ang > 1e-9) {
      _dq.setFromAxisAngle(_tmp.normalize(), ang);
      this.quat.multiply(_dq).normalize();
    }

    // ---- 파생 출력
    s.vs = this.vel.y;
    s.gamma = Math.atan2(this.vel.y, Math.hypot(this.vel.x, this.vel.z));
    s.track = Math.atan2(this.vel.x, -this.vel.z);
    s.heading = Math.atan2(_fwd.x, -_fwd.z);
    s.ps = V > 1 ? ((thrust - s.drag) * V) / (m * G0) : 0;

    // ---- 충돌 판정
    this.checkCrash(world, groundH);
  }

  groundContact(dt, world, s) {
    const d = F15C;
    // 랜딩기어
    if (this.gearPos > 0.97) {
      for (let i = 0; i < d.gear.length; i++) {
        const g = d.gear[i];
        aeroToLocal(_tmp.set(g.r[0], g.r[1], g.r[2]), _rw).applyQuaternion(this.quat);
        const px = this.pos.x + _rw.x, py = this.pos.y + _rw.y, pz = this.pos.z + _rw.z;
        const hg = world.heightAt(px, pz);
        const pen = hg - py;
        if (pen <= 0) { this.gearContact[i] = 0; this._wasOnGround[i] = false; continue; }
        // 접촉점 속도
        _vp.crossVectors(_wWorld, _rw).add(this.vel);
        const vn = _vp.y;
        if (!this._wasOnGround[i]) {
          if (vn < -5.2) { this.crash('착륙 충격으로 기어 파손 (침하율 ' + (-vn * 196.85).toFixed(0) + ' fpm)'); return; }
          if (vn < -0.8 || s.V > 40) this.touchdownEvent = Math.max(this.touchdownEvent, Math.min(1, s.V / 70));
        }
        this._wasOnGround[i] = true;
        this.wow = true;
        const comp = Math.min(pen, g.stroke);
        let Fn = g.k * comp - g.c * vn;
        if (pen > g.stroke) Fn += 4e6 * (pen - g.stroke);
        Fn = Math.max(0, Fn);
        this.gearContact[i] = comp;
        // 바퀴 방향 (기수 방향의 수평 투영)
        _fwd.set(0, 0, -1).applyQuaternion(this.quat);
        _fwd.y = 0; _fwd.normalize();
        if (g.steer) _fwd.applyAxisAngle(UP, -this.steer);
        _side.crossVectors(_fwd, UP).normalize(); // 오른쪽
        const vr = _vp.dot(_fwd), vs = _vp.dot(_side);
        const mu = 0.022 + (g.brake ? this.ctl.brake * 0.5 : 0);
        const Fr = -mu * Fn * Math.tanh(vr / 0.4);
        const Fs = -0.85 * Fn * clamp(vs / 0.35, -1, 1);
        _F.set(0, Fn, 0).addScaledVector(_fwd, Fr).addScaledVector(_side, Fs);
        _Fw.add(_F);
        _Mw.add(_tmp.crossVectors(_rw, _F));
      }
    } else {
      this.gearContact[0] = this.gearContact[1] = this.gearContact[2] = 0;
    }
  }

  checkCrash(world, groundH) {
    if (this.crashed) return;
    // 해수면/지형 충돌 (동체 하드포인트)
    const hp = F15C.hardpoints;
    for (let i = 0; i < hp.length; i++) {
      aeroToLocal(_tmp.set(hp[i][0], hp[i][1], hp[i][2]), _rw).applyQuaternion(this.quat);
      const px = this.pos.x + _rw.x, py = this.pos.y + _rw.y, pz = this.pos.z + _rw.z;
      const hg = world.heightAt(px, pz);
      if (py < hg) {
        const spd = this.vel.length();
        const isTail = i >= 8 && i <= 9;
        if (isTail && spd < 110 && this.vel.y > -2 && this.gearPos > 0.97) {
          // 꼬리 긁힘(테일 스트라이크) — 손상만
          this.tailStrike = 1;
          this.pos.y += hg - py;
          if (this.vel.y < 0) this.vel.y = 0;
          this.damage(6 / 240, '테일 스트라이크');   // 긁히는 동안 초당 약 6
          continue;
        }
        const reason = hg <= 0.5 && world.isWater?.(px, pz)
          ? '해상 추락'
          : (this.gearPos < 0.97 && Math.abs(this.s.phi) < 0.3 && this.vel.y > -4 ? '동체 착륙 실패 (기어 미전개)' : '지면 충돌');
        this.crash(reason);
        return;
      }
    }
  }

  /** 시각화용: 공력좌표 벡터를 월드로 */
  aeroToWorld(a, out) {
    return aeroToLocal(a, out).applyQuaternion(this.quat);
  }
}
