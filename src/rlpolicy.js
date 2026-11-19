// 강화학습(PPO 셀프플레이)으로 학습한 전설 AI 기동 정책 — 브라우저 추론
// 학습 환경(rl/env.py)의 관측·행동 정의를 그대로 옮긴 것. 정책은 0.1초마다 양력벡터 방향·G·스로틀·기총 추적 여부를 고르고,
// 실제 조종은 ai.js의 정밀 조종 법칙(flyLiftP / trackNose)이 맡는다.
import * as THREE from 'three';
import { G0, D2R, clamp } from './math.js';
import { isa } from './atmosphere.js';

const GUN_K = 0.00026, MUZZLE = 1050;
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

function b64f32(s) {
  const bin = atob(s), buf = new ArrayBuffer(bin.length), u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(buf);
}

export class RLPolicy {
  constructor(j) {
    this.mean = Float32Array.from(j.mean); this.std = Float32Array.from(j.var.map((v) => Math.sqrt(v + 1e-8)));
    this.layers = j.layers.map((L) => ({ W: b64f32(L.W), b: b64f32(L.b), nin: L.shape[0], nout: L.shape[1] }));
    this.obsDim = j.obs_dim; this.actDim = j.act_dim; this.info = j.info || '';
  }
  act(obs) {
    let x = new Float32Array(this.obsDim);
    for (let i = 0; i < this.obsDim; i++) x[i] = clamp((obs[i] - this.mean[i]) / this.std[i], -10, 10);
    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li], y = new Float32Array(L.nout);
      y.set(L.b);
      for (let i = 0; i < L.nin; i++) {
        const xi = x[i]; if (xi === 0) continue;
        const row = i * L.nout;
        for (let j = 0; j < L.nout; j++) y[j] += xi * L.W[row + j];
      }
      if (li < this.layers.length - 1) for (let j = 0; j < L.nout; j++) y[j] = Math.tanh(y[j]);
      x = y;
    }
    return Array.from(x, (v) => clamp(v, -1, 1));
  }
}

// v2 정책 (rl/model.py): 최근 관측 4개(0.3초 간격)를 쌓은 입력 + LayerNorm·SiLU 은닉층
export class RLPolicyV2 {
  constructor(j) {
    this.v2 = true; this.stack = j.stack; this.gap = j.gap; this.hist = (j.stack - 1) * j.gap + 1;
    const m = j.mean, v = j.var, n1 = m.length;
    this.obs1 = n1; this.obsDim = n1 * j.stack; this.actDim = j.act_dim; this.info = j.info || '';
    this.mean = new Float32Array(this.obsDim); this.isd = new Float32Array(this.obsDim);
    for (let k = 0; k < j.stack; k++) for (let i = 0; i < n1; i++) { this.mean[k * n1 + i] = m[i]; this.isd[k * n1 + i] = 1 / Math.sqrt(v[i] + 1e-8); }
    this.layers = j.layers.map((L) => ({ W: b64f32(L.W), b: b64f32(L.b), g: L.g ? b64f32(L.g) : null, beta: L.beta ? b64f32(L.beta) : null, nin: L.shape[0], nout: L.shape[1] }));
  }
  /** hist: 최근 관측 배열(오래된 것 → 최신, 길이 this.hist) */
  act(hist) {
    let x = new Float32Array(this.obsDim);
    const H = hist.length;
    for (let k = 0; k < this.stack; k++) {
      const o = hist[Math.max(0, H - 1 - k * this.gap)];
      for (let i = 0; i < this.obs1; i++) { const q = k * this.obs1 + i; x[q] = clamp((o[i] - this.mean[q]) * this.isd[q], -10, 10); }
    }
    for (const L of this.layers) {
      const y = new Float32Array(L.nout); y.set(L.b);
      for (let i = 0; i < L.nin; i++) {
        const xi = x[i]; if (xi === 0) continue;
        const row = i * L.nout;
        for (let j = 0; j < L.nout; j++) y[j] += xi * L.W[row + j];
      }
      if (L.g) {   // LayerNorm + SiLU
        let mu = 0; for (let j = 0; j < L.nout; j++) mu += y[j]; mu /= L.nout;
        let va = 0; for (let j = 0; j < L.nout; j++) va += (y[j] - mu) ** 2; va /= L.nout;
        const is = 1 / Math.sqrt(va + 1e-5);
        for (let j = 0; j < L.nout; j++) { const h = (y[j] - mu) * is * L.g[j] + L.beta[j]; y[j] = h / (1 + Math.exp(-clamp(h, -30, 30))); }
      }
      x = y;
    }
    return Array.from(x, (v) => clamp(v, -1, 1));
  }
}

// 정책 파일: src/<name>_policy.json (legend = 최종 정책; 엘리트 난이도도 legend 정책에 핸디캡을 걸어 씀 — ai.js SKILL.elite)
const _policies = {}, _loading = {};
export function getPolicy(name) {
  if (!_loading[name]) {
    _loading[name] = fetch(`src/${name}_policy.json`).then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) _policies[name] = j.arch === 'v2' ? new RLPolicyV2(j) : new RLPolicy(j); }).catch(() => {});
  }
  return _policies[name] || null;
}

// ---------------------------------------------------------------- 학습 환경과 같은 기하·관측
const axes = (q) => ({
  fwd: new THREE.Vector3(0, 0, -1).applyQuaternion(q),
  up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
});
/** 표적 자세로 본 순간 가속도 (양력 방향 × G + 중력) */
export function attAcc(fm, out = new THREE.Vector3()) {
  out.set(0, 1, 0).applyQuaternion(fm.quat).multiplyScalar(Math.max(fm.s.nz, -3) * G0);
  out.y -= G0;
  return out;
}
/** rl/env.py gun_lead (총구 = 기체 중심) → 기수 방향 단위벡터 */
export function gunLeadEnv(fm, tf, tAcc, out = new THREE.Vector3()) {
  const c = GUN_K * (isa(fm.pos.y).rho / 1.225);
  const u = _v.subVectors(tf.pos, fm.pos).normalize();
  const V2 = fm.vel.lengthSq();
  let tof = 0.5, v0 = MUZZLE;
  for (let i = 0; i < 5; i++) {
    const ud = u.dot(fm.vel);
    v0 = ud + Math.sqrt(Math.max(1, ud * ud - V2 + MUZZLE * MUZZLE));
    _w.copy(tf.pos).addScaledVector(tf.vel, tof).addScaledVector(tAcc, 0.5 * tof * tof);
    _w.y += 0.5 * G0 * tof * tof;
    _w.sub(fm.pos);
    const D = _w.length();
    u.copy(_w).divideScalar(Math.max(D, 1));
    tof = (Math.exp(Math.min(c * D, 20)) - 1) / (c * v0);
  }
  return out.copy(u).multiplyScalar(v0).sub(fm.vel).normalize();
}

export function buildObs(fm, tf, tracking) {
  const r = new THREE.Vector3().subVectors(tf.pos, fm.pos), R = r.length();
  const los = r.clone().divideScalar(Math.max(R, 1e-6));
  const u = fm.vel.clone().normalize(), uo = tf.vel.clone().normalize();
  const ata = Math.acos(clamp(u.dot(los), -1, 1)), aa = Math.acos(clamp(uo.dot(los), -1, 1));
  const Vc = -new THREE.Vector3().subVectors(tf.vel, fm.vel).dot(los);
  let rt = new THREE.Vector3().crossVectors(u, new THREE.Vector3(0, 1, 0));
  rt = rt.length() > 1e-3 ? rt.normalize() : new THREE.Vector3(1, 0, 0);
  const lu = new THREE.Vector3().crossVectors(rt, u);
  const frame = (v) => [v.dot(u), v.dot(rt), v.dot(lu)];
  const me = axes(fm.quat), him = axes(tf.quat);
  const aim = gunLeadEnv(fm, tf, attAcc(tf));
  const leadErr = Math.acos(clamp(me.fwd.dot(aim), -1, 1));
  const hisAim = gunLeadEnv(tf, fm, attAcc(fm));
  const hisLead = Math.acos(clamp(him.fwd.dot(hisAim), -1, 1));
  const hisAta = Math.acos(clamp(-him.fwd.dot(los), -1, 1));
  const gam = Math.asin(clamp(u.y, -1, 1));
  const relV = new THREE.Vector3().subVectors(tf.vel, fm.vel);
  const V = fm.s.V, Vo = tf.s.V;   // 학습 환경과 같게: 마지막 물리 단계 시작 시점의 속력
  const E = fm.pos.y + V * V / (2 * G0), Eo = tf.pos.y + Vo * Vo / (2 * G0);
  const s = fm.s, so = tf.s, w = fm.omega;
  const o = [
    V / 250 - 1, fm.pos.y / 4000 - 1, Math.sin(gam),
    me.up.dot(lu), me.up.dot(rt), s.alpha / 0.3, s.nz / 5 - 0.5,
    w.x * 0.5, w.y * 1.5, w.z * 2.0, (fm.engines[0].n - 0.8) * 3, fm.engines[0].ab, fm.sbPos,
    Math.max(fm.hp, 0) / 100, ((fm.thrustMul || 1) - 1.07) * 10,
    ...frame(los), Math.log(Math.max(R, 50)) - 7, ...frame(relV).map((x) => x / 200), Vc / 200,
    Math.cos(ata), Math.cos(aa), Math.cos(hisAta),
    ...frame(uo), ...frame(him.up), so.nz / 5 - 0.5, Vo / 250 - 1,
    (tf.pos.y - fm.pos.y) / 1000, (Eo - E) / 1000, Math.max(tf.hp, 0) / 100, ((tf.thrustMul || 1) - 1.07) * 10,
    Math.min(leadErr / 0.3, 3), Math.min(hisLead / 0.3, 3), ...frame(aim), tracking ? 1 : 0, s.agl / 1000,
  ];
  return { obs: o, R, los, u, aim, leadErr };
}

/** 행동 → 양력 방향(월드)·G·스로틀·스피드브레이크·기총 추적 */
export function actionToCommand(fm, a, los, u) {
  const ref = los.clone().addScaledVector(u, -los.dot(u));
  if (ref.length() > 0.05) ref.normalize();
  else ref.set(0, 1, 0).addScaledVector(u, -u.y).normalize();
  const side = new THREE.Vector3().crossVectors(u, ref);
  const ang = Math.atan2(a[1], a[0]);
  const l = ref.multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
  // 저고도 하한 (rl/env.py와 같음): 1500 m 아래에선 양력벡터의 아래 성분을 줄이고 600 m 아래에선 아래로 당기지 않음
  const agl = fm.s.agl;
  if (agl < 1500 && l.y < 0) l.y *= Math.max(0, (agl - 600) / 900);
  if (l.length() > 1e-3) l.normalize();
  else l.set(0, 1, 0).addScaledVector(u, -u.y).normalize();
  const nzMax = 9 + (fm.nzBonus || 0);
  return {
    l, n: -1 + (a[2] + 1) / 2 * (nzMax + 1), thr: (a[3] + 1) / 2, sb: a[3] < -0.8, track: a[4] > 0,
  };
}
export const RL_TRACK_ENTER = 10 * D2R, RL_TRACK_KEEP = 15 * D2R;
