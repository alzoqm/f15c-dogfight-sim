// 적기 AI 조종사: 동일한 6-DOF 비행모델을 스틱/스로틀 입력으로만 조종 (치트 없음)
// 양력벡터 배치(lift-vector placement) 기반 추적, 리드/래그 추적, 방어 기동, 지형 회피, 무장 운용
import * as THREE from 'three';
import { localToAero } from './flightmodel.js';
import { clamp, G0, D2R, R2D } from './math.js';
import { gunLead } from './weapons.js';
import { clBasic } from './f15.js';
import { liftDirWorld, bankNow } from './liftvec.js';
import { getPolicy, buildObs, actionToCommand, RL_TRACK_ENTER, RL_TRACK_KEEP } from './rlpolicy.js';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _b = new THREE.Vector3(), _t = new THREE.Vector3();
const _g = new THREE.Vector3(), _g2 = new THREE.Vector3(), _w = new THREE.Vector3(), _w3 = new THREE.Vector3(), _A = new THREE.Vector3();

export const SKILL = {
  // pull: 최대 스틱 당김 비율, react: 미사일 경보 반응 시간(s), aimErr: 조준 흔들림(rad), flare: 플레어 사용 확률
  // gunRange/fireTol: 기총 사격 거리(m)/리드 조준점 허용 오차(°, 표적 크기 각도에 더함), missileCd: 미사일 재발사 간격(s)
  // srm/mrm: 단/중거리 미사일 수, jinkT: 기총 방어 재킹 방향 전환 주기(s), fullAB: 원거리 추격 시 애프터버너 유지
  // predict: 상대 선회(가속도) 예측 반영 비율 (0 = 직선 리드만)
  // tac: 근접전 전술 수준 — 0 퓨어 추적·단순 선회 / 1 래그 추적·기총 재킹 / 2 에너지 관리(코너 속도)·하이/로 요요
  //      / 3 리드 턴·오버슛 유도(스로틀·스피드브레이크)·수직 브레이크 / 4 더 적극적인 수직 기동, 가장 빠른 판단
  // think: 상황(공세/중립/수세) 재판단 주기(s)
  // aoa: 받음각 한도(°, 기본 27)
  // expert: 정밀 BFM(최대 G 리드 추적 + 안정축 기총 추적 trackNose + 정면 사격 회피), overshoot: 접근률 기반 오버슛 관리,
  // leadTurn: 정면 교차 리드 턴, defAoa/trackAoa: 수세(기총 방어)·기총 추적 중 받음각 한도(°, 그 외 기동은 에너지 유지를 위해 27°)
  rookie:  { pull: 0.6,  react: 1.2,  aimErr: 0.012,  flare: 0.35, gunRange: 500,  fireTol: 1.3, missileCd: 22, srm: 2, mrm: 0, jinkT: 1.2, fullAB: false, predict: 0.0, tac: 0, think: 1.0 },
  veteran: { pull: 0.82, react: 0.6,  aimErr: 0.006,  flare: 0.7,  gunRange: 600,  fireTol: 1.0, missileCd: 14, srm: 2, mrm: 1, jinkT: 1.2, fullAB: false, predict: 0.4, tac: 1, think: 0.6 },
  // 에이스: 규칙 기반 전문가 AI (최대 G 리드 추적 + 정밀 기총 추적, 오버슛 관리, 정면 교차 리드 턴·사격 회피, 수세 받음각 30°)
  // perf: 기체 성능 보정 — thrust 추력 배율, nz CAS G 한계 가산
  ace:     { perf: { thrust: 1.15, nz: 1.0 }, pull: 1.0,  react: 0.08, aimErr: 0.0012, flare: 0.98, gunRange: 1000, fireTol: 0.25, missileCd: 5,  srm: 4, mrm: 3, jinkT: 0.7, fullAB: true,  predict: 1.0, tac: 4, think: 0.1, expert: true, overshoot: true, leadTurn: true, defAoa: 30, trackAoa: 30 },
  // 엘리트·전설: 강화학습 정책 (rl: 정책 파일 이름). 정책을 못 불러오면 에이스와 같은 규칙 기반으로 동작
  // 엘리트: 전설과 같은 학습 정책에 핸디캡 — 반응 지연(rlNerf.lag 결정 단위 0.1 s), 조종 잡음(noise), 최대 당김 제한(pull), 긴 조준 유지(settle), 성능 보정 축소
  elite:   { perf: { thrust: 1.08, nz: 0.5 }, pull: 0.85, react: 0.08, aimErr: 0.0012, flare: 0.98, gunRange: 1000, fireTol: 0.25, missileCd: 5,  srm: 4, mrm: 3, jinkT: 0.7, fullAB: true,  predict: 1.0, tac: 4, think: 0.1, expert: true, overshoot: true, leadTurn: true, defAoa: 30, trackAoa: 30, rl: 'legend', settle: 0.5, rlNerf: { lag: 3, noise: 0.25 } },
  legend:  { perf: { thrust: 1.15, nz: 1.0 }, pull: 1.0,  react: 0.08, aimErr: 0.0012, flare: 0.98, gunRange: 1000, fireTol: 0.25, missileCd: 5,  srm: 4, mrm: 3, jinkT: 0.7, fullAB: true,  predict: 1.0, tac: 4, think: 0.1, expert: true, overshoot: true, leadTurn: true, defAoa: 30, trackAoa: 30, rl: 'legend' },
};

const s0alpha = (fm) => fm.s.alpha || 0;
// 사격 전 조준 유지 시간 (s): 조준점이 표적 위에 이만큼 연속으로 머물러야 발사 (정면 교차처럼 조준점이 스쳐 지나가는 사격은 어려워짐). rl/env.py AIM_SETTLE과 같음
export const AIM_SETTLE = 0.3;

export class AIPilot {
  constructor(ac, skillName = 'veteran') {
    this.ac = ac;
    this.skill = SKILL[skillName];
    this.state = 'engage';
    this.timer = 0;
    this.missileCd = 5 + Math.random() * 8;
    this.flareCd = 0;
    this.burst = 0;
    this.aimHold = 0; this.solNow = false; this.solBurst = 0;   // 사격 해 유지 시간, 이번 프레임 사격 해 여부, 원하는 점사 길이
    this.jink = 0;
    this.thinkT = 0;
    this.patrolCenter = ac.fm.pos.clone();
    this.tPrevVel = null;               // 표적 가속도 추정용 (선회 예측)
    this.tAcc = new THREE.Vector3();
    this.tAccNow = new THREE.Vector3();   // 표적 자세(양력 방향·G)로 본 순간 가속도 — 상위 기량은 선회 반전을 즉시 읽음
    this.aimPrev = null; this.aimRate = new THREE.Vector3();
    this.jit = new THREE.Vector3();       // 조준 흔들림 (저주파)
    this.jinkHalf = 1.2;
    this.bfmT = 0; this.bfmMode = 'neutral'; this.maneuver = '';
    this.gain = { kpF: 1.9, kdF: 0.35, kp: 1.6, kd: 0.2, smooth: 12, rs: 4, rl: 1.6, rd: 0.3 };   // 조향 이득 (G 명령 PD)
    this.holdFire = false;    // true: 사격·미사일 금지 (1:1 기총전 머지 전)
    this.ingressAlt = null;   // 숫자면 머지 전 진입: 현재 침로·이 고도로 직진 (정면 대향 유지)
    if (this.skill.rl) getPolicy(this.skill.rl);   // 학습 정책 미리 불러오기
  }

  /**
   * 원하는 방향(월드 단위벡터)으로 기수를 돌리는 스틱 명령 — 조종사식 '양력벡터 + G 명령' 법칙.
   *  롤: 목표를 양력면(캐노피 위쪽 방향)에 놓도록 굴림. 목표가 기수 바로 아래쪽이면 배면으로 뒤집지 않고 아래쪽 기준으로 맞춤.
   *  당김(G): 피드포워드(따라가는 표적의 G) + 속도에 비례한 오차 이득 + 오차 변화율 감쇠. CAS가 스틱을 G 명령으로 해석.
   *  제한: 받음각 약 27°(롤 역전 방지), 크게 굴려야 하면 먼저 언로드, 저속 실속 방지.
   *  수평에 가까운 비행에서 오차가 작으면(진입·순항) 수평 기준 미세 조정.
   */
  steer(dirWorld, maxPull, allowNeg = false, fine = false) {
    const fm = this.ac.fm, s = fm.s, phi = s.phi;
    // 목표 방향의 회전 각속도 → 그만큼 도는 데 필요한 G를 피드포워드 (오차가 쌓인 뒤에야 당기는 지연 제거). 기량(predict)에 비례
    const sk = this.skill, dtS = Math.max(this.lastDt || 1 / 60, 1e-3);
    if (this.sPrev && this.sMan === this.maneuver) {
      _w.crossVectors(this.sPrev, dirWorld).divideScalar(dtS);
      if (_w.length() > 1.0) _w.setLength(1.0);
      this.sRate.lerp(_w, clamp(dtS / 0.15, 0, 1));
    } else { if (!this.sRate) this.sRate = new THREE.Vector3(); this.sRate.set(0, 0, 0); if (!this.sPrev) this.sPrev = new THREE.Vector3(); }
    this.sPrev.copy(dirWorld); this.sMan = this.maneuver;
    const rateG = Math.max(s.V, 60) * this.sRate.length() / G0 * (sk.predict || 0);
    _q.copy(fm.quat).invert();
    const db = localToAero(_v.copy(dirWorld).applyQuaternion(_q), _b);
    if (!fine) {
      // 추적 비행은 기수가 아니라 비행경로(속도벡터) 기준으로 오차를 잰다 (받음각만큼 기수가 위로 들려 있으므로)
      const a = clamp(s0alpha(fm), -0.3, 0.6), ca = Math.cos(a), sa = Math.sin(a);
      const x = db.x * ca + db.z * sa, z = -db.x * sa + db.z * ca;
      db.x = x; db.z = z;
    }
    const ang = Math.acos(clamp(db.x, -1, 1));
    const ep = Math.atan2(-db.z, db.x), ey = Math.atan2(db.y, db.x);
    let pitch, roll, yaw = 0;
    const turning = Math.abs(phi) > 0.7 || s.nz > 2.5 || this.ffNz != null;
    if (!turning && ang < 0.42 && db.x > 0) {
      // 수평 비행 미세 조정 (진입·초계): 목표 방향으로 완만한 경사 + 피치
      const phiDes = clamp(ey * (fine ? 5 : 3.5), -1.25, 1.25);
      roll = Math.abs(phi) > 1.6 ? -Math.sign(phi) : clamp((phiDes - phi) * 2.2, -1, 1);
      const turnG = 1 / Math.max(0.35, Math.cos(phi)) - 1;
      pitch = clamp(ep * (fine ? 9 : 5) + turnG / 8, allowNeg || !fine ? -0.25 : 0, maxPull);
      if (fine) yaw = clamp(ey * 14, -1, 1);
    } else {
      // 오차가 작을 때(≲6°): 좌우 오차만큼 경사를 살짝 바꾸고 피치 평면 오차만큼 G를 가감 (조준 미세 조정)
      // 오차가 클 때(≳17°): 목표를 양력면(캐노피 위쪽)에 놓도록 굴린 뒤 당김 (양력벡터 배치). 그 사이는 부드럽게 섞음
      const clock = Math.atan2(db.y, -db.z);                               // 기수 둘레 목표 각 (캐노피 위 = 0)
      // 목표가 기수 위쪽이면 6°~17°에서 양력벡터 방식으로 전환, 아래쪽이면 35°까지는 굴리지 않고 G만 줄임
      // (받음각 때문에 기수가 목표보다 들려 있는 흔한 상황에서 배면으로 뒤집는 오동작 방지)
      const w = db.x <= 0 ? 1 : ep >= 0 ? clamp((ang - 0.10) / 0.20, 0, 1) : clamp((ang - 0.6) / 0.3, 0, 1);
      const G = this.gain;
      roll = clamp((1 - w) * ey * G.rs + w * clock * G.rl - fm.omega.x * G.rd, -1, 1);
      // ---- 당김: G 명령 = 피드포워드(따라가는 표적의 G) + 오차 이득 + 감쇠
      const V = Math.max(s.V, 60);
      const ff = Math.max(this.ffNz != null ? Math.max(1, this.ffNz) : 1, Math.sqrt(rateG * rateG + 1));
      const epDot = this.prevEp != null ? clamp((ep - this.prevEp) / Math.max(this.lastDt, 1e-3), -1.5, 1.5) : 0;
      this.prevEp = ep;
      const Gn = this.gain;
      const Kp = V * (fine ? Gn.kpF : Gn.kp) / G0;                        // G / rad
      const err = (1 - w) * ep + w * ang * Math.max(0, Math.cos(clock));
      // 기총 정밀 추적(fine): 오차 적분 → 지속 선회 중 남는 정상상태 오차(피드포워드 부족분) 제거
      if (fine && ang < 0.09) this.errI = clamp((this.errI || 0) + ep * dtS, -0.06, 0.06);
      else this.errI = 0;
      const nzCmd = ff + Kp * err + (1 - w) * (fine ? Gn.kdF : Gn.kd) * V * epDot / G0 + (fine ? 3.0 * V * this.errI / G0 : 0);
      pitch = nzCmd >= 1 ? (nzCmd - 1) / 8 : (nzCmd - 1) / 4;
      pitch = clamp(pitch, allowNeg || w < 0.5 ? -0.3 : 0, maxPull);
      if (fine) yaw = clamp(ey * 10, -1, 1);
      // 크게 굴려야 할 때는 먼저 언로드 (고받음각에서는 롤이 거의 안 됨)
      if (w > 0.5 && Math.abs(clock) > 0.8 && s.alpha > 10 * D2R) pitch = Math.min(pitch, 0.2);
    }
    // 받음각 관리: 양력 ∝ 받음각 → 현재 G·받음각으로 '받음각 27°에서 낼 수 있는 G'를 추정해 그 이상 명령하지 않음
    const aLim = (this.aoaNow || this.skill.aoa || 27) * D2R, alpha = s.alpha;
    const nzAt = Math.max(1, s.nz) * aLim / Math.max(alpha, 3 * D2R);
    pitch = Math.min(pitch, clamp((nzAt - 1) / 8, 0.12, 1));
    // 저속 시 과도한 당김 제한 (실속 방지)
    if (s.V < 140) pitch = Math.min(pitch, 0.3 + (s.V - 100) / 200);
    return { pitch, roll, yaw, ang };
  }

  /**
   * 양력벡터 방향(월드)과 G를 그대로 조종 입력으로: 그 방향으로 롤(크게 굴려야 하면 먼저 언로드), G 명령으로 당김
   */
  flyLift(l, n) {
    const fm = this.ac.fm, s = fm.s;
    _q.copy(fm.quat).invert();
    const lb = localToAero(_v.copy(l).applyQuaternion(_q), _b);
    const clock = Math.atan2(lb.y, -lb.z);
    const roll = clamp(clock * 1.8 - fm.omega.x * 0.3, -1, 1);
    const nzMax = 9 + (fm.nzBonus || 0);
    let nC = n;
    const ac = Math.abs(clock);
    if (ac > 0.5 && nC > 1) nC = Math.min(nC, 1 + (nzMax - 1) * clamp((1.2 - ac) / 0.7, 0.12, 1));
    let pitch = nC >= 1 ? (nC - 1) / (nzMax - 1) : (nC - 1) / 4;
    pitch = clamp(pitch, -0.5, this.skill.pull);
    const aLim = (this.aoaNow || this.skill.aoa || 27) * D2R;
    const nzAt = Math.max(1, s.nz) * aLim / Math.max(s.alpha, 3 * D2R);
    pitch = Math.min(pitch, clamp((nzAt - 1) / 8, 0.12, 1));
    if (s.V < 140) pitch = Math.min(pitch, 0.3 + (s.V - 100) / 200);
    return { pitch, roll, yaw: 0, ang: 0 };
  }

  /**
   * 양력벡터 방향(월드)과 G를 그대로 조종 입력으로 (정밀 조종 법칙)
   *  롤: 속도축(안정축) 둘레로 원하는 양력 방향까지의 각에 비례한 롤레이트 명령 (받음각에 따른 롤 성능 감소 보상)
   *  G: 크게 굴려야 하면 그만큼 G를 줄여 엉뚱한 면으로 당기지 않음. 작은 G로 반대쪽(아래)이 필요하면 뒤집지 않고 음의 G
   *  받음각: CAS가 30°에서 제한 (기량의 받음각 한도가 더 낮으면 직접 제한)
   */
  flyLiftP(l, n, fine = false) {
    const fm = this.ac.fm, s = fm.s;
    _q.copy(fm.quat).invert();
    const lb = localToAero(_v.copy(l).applyQuaternion(_q), _b);
    const al = clamp(s.alpha || 0, -0.3, 0.6), ca = Math.cos(al), sa = Math.sin(al);
    const zs = -lb.x * sa + lb.z * ca;
    let clock = Math.atan2(lb.y, -zs);
    let nC = n;
    if (Math.abs(clock) > 1.95 && n < 1.6) { clock -= Math.sign(clock) * Math.PI; nC = -n; }
    else if (Math.abs(clock) > 2.9 && this.rollSign) clock = this.rollSign * Math.abs(clock);   // 정반대: 굴리던 방향 유지
    this.rollSign = Math.sign(clock) || 1;
    const acl = Math.abs(clock);
    const ul = fine ? 1.3 : 0.5;   // 정밀 추적 중에는 작은 롤 수정에 G를 빼지 않음 (빼면 조준점이 달아남)
    if (acl > ul && nC > 1) nC = 1 + (nC - 1) * clamp((1.4 - acl) / (1.4 - ul + 0.001), 0.15, 1);
    const pEff = 4.0 * clamp(1 - 1.4 * Math.max(0, (s.alpha || 0) - 0.25), 0.3, 1);
    const roll = clamp((fine ? 3.0 : 4.5) * clock / pEff - (fine ? 0.08 : 0) * fm.omega.x, -1, 1);
    const nzMax = fm.data.limits.nzMax + (fm.nzBonus || 0);
    let pitch = nC >= 1 ? (nC - 1) / (nzMax - 1) : (nC - 1) / 4;
    pitch = clamp(pitch, -0.6, this.skill.pull);
    const aLim = (this.aoaNow || this.skill.aoa || 27) * D2R;
    if (aLim < 29.5 * D2R) {
      const nzAt = Math.max(1, s.nz) * aLim / Math.max(s.alpha, 3 * D2R);
      pitch = Math.min(pitch, clamp((nzAt - 1) / 8, 0.12, 1));
      if (s.V < 140) pitch = Math.min(pitch, 0.3 + (s.V - 100) / 200);
    }
    return { pitch, roll, yaw: 0, ang: 0 };
  }

  /**
   * 정밀 기총 추적 — 기수 직접 지향 법칙 (rl/env.py track_nose와 동일):
   *  롤: 조준점을 양력면(속도벡터와 조준점이 이루는 면)에 넣음. 중력 보상분까지 넣은 가속도 방향으로 굴리면 양력면이
   *      조준면에서 기울어 받음각만큼 기수가 옆으로 비껴 고정 오차(2~3°)가 남던 문제를 없앰
   *  G: 받음각 목표 α* = 조준점이 속도벡터에서 떨어진 각 θ + 0.7·dθ/dt(지연 보상) → CL 표로 G 명령으로 환산
   *     (FCS가 이 G를 정확히 그 받음각으로 역산) — 경로 회전율로 제어하던 이전 법칙의 과민 루프(진동) 제거
   *  러더: 오차 2° 이내면 좌우 미세 수정
   *  시험(rl/track_test.py, 선회·반전 표적 8가지): 사격 허용 오차 안에 있는 시간 3% → 94%
   */
  trackNose(aim, dt) {
    const fm = this.ac.fm, s = fm.s;
    const u = _d.copy(fm.vel).normalize();
    const fresh = !this.aimPrev;
    if (fresh) { this.aimPrev = aim.clone(); this.thD = 0; }
    this.aimPrev.copy(aim);
    const ap = _w3.copy(aim).addScaledVector(u, -aim.dot(u));
    const apn = ap.length();
    const th = Math.atan2(apn, aim.dot(u));
    if (!fresh) {
      const d = clamp((th - this.thPrev) / Math.max(dt, 1e-3), -1, 1);
      this.thD += (d - this.thD) * Math.min(1, dt / 0.1);
    }
    this.thPrev = th;
    const aC = clamp(th + 0.7 * this.thD, -0.2, 30 * D2R);
    const n = (s.qbar * fm.data.S * clBasic(aC, s.M)) / (fm.mass * G0);
    const lU = apn > 1e-4 ? ap.divideScalar(apn) : ap.set(0, 1, 0);
    const cmd = this.flyLiftP(lU, n, true);
    const nose = _g2.set(0, 0, -1).applyQuaternion(fm.quat);
    const err = Math.acos(clamp(nose.dot(aim), -1, 1));
    if (err < 2 * D2R) {
      _q.copy(fm.quat).invert();
      const ab = localToAero(_v.copy(aim).applyQuaternion(_q), _b);
      cmd.yaw = clamp(Math.atan2(ab.y, ab.x) * 12, -1, 1);
    }
    cmd.ang = err;
    return cmd;
  }


  /**
   * 근접 공중전(BFM): 기하(ATA·AA·거리·접근률)로 공세/중립/수세를 판정하고, 기량(tac)에 따라
   * 추적 방식(리드/퓨어/래그), 하이·로 요요, 오버슛 방지, 리드 턴, 브레이크·재킹·오버슛 유도,
   * 에너지(코너 속도·비에너지) 관리를 수행한다. 반환: { cmd | null(기총 추적), throttle, sb, gunShot }
   */
  /**
   * 강화학습 정책 기동 (rl/ 에서 PPO 셀프플레이로 학습, 학습 환경 rl/env.py와 같은 관측·행동·조종 법칙):
   * 0.1초마다 정책이 양력벡터 방향(상대 쪽 기준 각)·G·스로틀(+스피드브레이크)·기총 추적 여부를 정하고,
   * 그 사이 매 프레임 flyLiftP(받음각 30°까지)로 그 명령을 그대로 비행. 기총 추적이면 trackNose, 사격은 리드 오차 기준 자동
   */
  bfmRL(dt, target, P) {
    const fm = this.ac.fm, tf = target.fm;
    this.rlActive = true;
    this.aoaNow = 30;
    const ob = buildObs(fm, tf, this.rlTracking);
    this.rlT = (this.rlT ?? 0) - dt;
    if (this.rlT <= 0 || !this.rlCmd) {
      this.rlT = Math.max(this.rlT + 0.1, 0.05);
      const nerf = this.skill.rlNerf, lag = nerf ? nerf.lag : 0;
      if (P.v2) {   // 관측 기록 (결정 0.1초마다 1개, 학습 환경과 같음). 핸디캡: lag개 이전 관측까지만 보고 결정 (반응 지연)
        const keep = P.hist + lag;
        if (!this.rlHist) this.rlHist = Array.from({ length: keep }, () => ob.obs.slice());
        this.rlHist.push(ob.obs.slice()); if (this.rlHist.length > keep) this.rlHist.shift();
      }
      let a = P.v2 ? P.act(lag ? this.rlHist.slice(0, P.hist) : this.rlHist) : P.act(ob.obs);
      if (nerf && nerf.noise) {   // 조종 잡음: 양력벡터 방향·G·스로틀에 가우스 잡음 (기총 추적 여부는 그대로)
        a = a.map((v, i) => (i < 4 ? clamp(v + nerf.noise * Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random()), -1, 1) : v));
      }
      this.rlCmd = actionToCommand(fm, a, ob.los, ob.u);
    }
    const c = this.rlCmd;
    const track = c.track && ob.R < 1500 && ob.leadErr < (this.rlTracking ? RL_TRACK_KEEP : RL_TRACK_ENTER);
    let cmd;
    if (track) {
      if (!this.rlTracking) this.aimPrev = null;
      this.maneuver = 'GUNS TRACK';
      cmd = this.trackNose(ob.aim, dt);
    } else {
      this.maneuver = 'RL BFM';
      cmd = this.flyLiftP(c.l, c.n, false);
    }
    this.rlTracking = track;
    const tol = Math.atan(8 / Math.max(ob.R, 1)) + 0.5 * D2R;
    if (ob.R < 1000 && ob.leadErr < tol && fm.ammo > 0 && !this.holdFire) this.fireSol(dt * 1.5);
    return { cmd, throttle: c.thr, sb: c.sb, gunShot: false };
  }

  fireSol(burst) { this.solNow = true; this.solBurst = Math.max(this.solBurst, burst); }

  bfm(dt, game, target) {
    const ac = this.ac, fm = ac.fm, s = fm.s, sk = this.skill, tf = target.fm, tac = sk.tac;
    const up = new THREE.Vector3(0, 1, 0);
    const losV = new THREE.Vector3().subVectors(tf.pos, fm.pos);
    const R = Math.max(losV.length(), 1);
    const los = losV.clone().divideScalar(R);
    const myV = fm.vel.clone().normalize(), tV = tf.vel.clone().normalize();
    const tNose = new THREE.Vector3(0, 0, -1).applyQuaternion(tf.quat);
    const ata = Math.acos(clamp(myV.dot(los), -1, 1));                       // 내 진행방향 ↔ 적 (0 = 적을 향함)
    const aa = Math.acos(clamp(tV.dot(los), -1, 1));                         // 0 = 내가 적의 6시, π = 정면
    const hisAta = Math.acos(clamp(-tNose.dot(los), -1, 1));                 // 적 기수 ↔ 나 (작을수록 위험)
    const Vc = -new THREE.Vector3().subVectors(tf.vel, fm.vel).dot(los);     // 접근률
    const E = fm.pos.y + s.V * s.V / (2 * G0), tE = tf.pos.y + tf.s.V * tf.s.V / (2 * G0);
    const dE = E - tE;                                                        // 비에너지 우위 (m)
    const corner = 175;                                                       // 코너 속도 CAS ≈ 340 kt
    const cas = s.cas, agl = s.agl;
    const pred = (tl) => tf.pos.clone().addScaledVector(tf.vel, tl).addScaledVector(this.tAcc, 0.5 * tl * tl * sk.predict);

    this.aoaNow = null;
    // 엘리트·전설: 강화학습 정책이 있으면 그 정책으로 기동 (src/<rl>_policy.json, 없거나 로드 전이면 아래 규칙 기반 전문가 AI)
    if (sk.rl) {
      const P = getPolicy(sk.rl);
      if (P) return this.bfmRL(dt, target, P);
    }
    this.rlActive = false;
    if (sk.expert) {
      // ---- 전설 근접전: 정밀 기총 추적 / 정면 교차(사격 회피 → 리드 턴) / 기총 방어 / 최대 G 리드 추적 + 오버슛 관리
      // 상대가 내게 거는 기총 리드 조준 오차 (내 자세로 읽은 내 가속도 포함) — 후방 공격이든 정면 교차든 사격 해를 읽음
      let hisLeadE = Math.PI;
      if (R < 1800 && hisAta < 30 * D2R) {
        const q = fm.quat;
        _w.set(2 * (q.x * q.y - q.w * q.z), 1 - 2 * (q.x * q.x + q.z * q.z), 2 * (q.y * q.z + q.w * q.x)).multiplyScalar((s.nz || 1) * G0);
        _w.y -= G0;
        const HL = gunLead(target, ac, _g, _w, 1);
        hisLeadE = Math.acos(clamp(_g2.set(0, 0, -1).applyQuaternion(tf.quat).dot(HL.dir), -1, 1));
      }
      // 기총 추적 진입: 리드 조준점이 기수 8° 이내일 때만 (벗어나면 15°에서 해제). 정면에서는 내 사격 해가 상대보다 확실히 좋을 때만
      const L = gunLead(ac, target, _g, sk.predict >= 1 ? this.tAccNow : this.tAcc, sk.predict);
      const leadE = Math.acos(clamp(_g2.set(0, 0, -1).applyQuaternion(fm.quat).dot(L.dir), -1, 1));
      const tracking = this.maneuver === 'GUNS TRACK';
      const frontOk = aa < 120 * D2R || (leadE < 3 * D2R && hisLeadE > leadE + 3 * D2R);
      // 접근률이 거리에 비해 너무 크면(곧 오버슛) 추적보다 오버슛 관리가 먼저 — 쏘다가 앞으로 튀어나가면 상대가 리버설로 꼬리를 문다
      const overRun = sk.overshoot && aa < 90 * D2R && R < 1300 && Vc > Math.max(60, (R - 150) / 1.6);   // 아이들+스피드브레이크(~20 m/s²)로 150 m 전에 못 멈추는 접근률
      if (R < sk.gunRange * 1.3 && frontOk && !overRun && leadE < (tracking ? 15 : 8) * D2R) {
        this.maneuver = 'GUNS TRACK';
        return { cmd: null, throttle: 1, sb: false, gunShot: true };
      }
      // 정면 교차 사격 회피: 상대 기수가 내게 사격 해를 거의 잡았는데(6°) 내 사격 해는 더 나쁘면 선회면을 바꿔 피함
      if (this.gd && this.gd.t > 0 && this.gd.headOn) {
        this.gd.t -= dt;
        this.maneuver = 'HEAD-ON 회피';
        liftDirWorld(ac, this.gd.th, _t);
        return { cmd: this.flyLift(_t, 99), throttle: 1, sb: false, gunShot: false };
      }
      if (ata <= 60 * D2R && R < (sk.hoR || 1800) && Vc > 80 && hisLeadE < (sk.hoE || 6) * D2R) {
        const myL = gunLead(ac, target, _g, this.tAccNow, 1);
        const myLeadE = Math.acos(clamp(_g2.set(0, 0, -1).applyQuaternion(fm.quat).dot(myL.dir), -1, 1));
        if (!(myLeadE < 1.5 * D2R && R < sk.gunRange)) {
          this.gd = { t: 0.6 + Math.random() * 0.4, th: bankNow(ac) + (Math.random() < 0.5 ? -1 : 1) * (70 + Math.random() * 50) * D2R, headOn: true };
          this.maneuver = 'HEAD-ON 회피';
          liftDirWorld(ac, this.gd.th, _t);
          return { cmd: this.flyLift(_t, 99), throttle: 1, sb: false, gunShot: false };
        }
      }
      // 정면 교차 리드 턴: 서로 마주 보고 접근하면 통과 약 4초 전부터 상대가 지나갈 쪽으로 수평 최대 선회
      //  → 기수를 상대 사격선에서 빼면서(정면 기총 교환 회피) 상대 꼬리 쪽으로 미리 돌아 각도 선점
      const headOn = ata < 50 * D2R && aa > 130 * D2R && Vc > 150;
      if (sk.leadTurn && headOn && R > 250 && R < Math.max(2200, Vc * 4)) {
        const u = _d.copy(fm.vel).normalize();
        const rt = _w.crossVectors(u, up).normalize();
        if (!this.ltSide) this.ltSide = rt.dot(losV) >= 0 ? 1 : -1;
        _t.copy(up).addScaledVector(u, -u.y).normalize();
        _t.multiplyScalar(Math.cos(80 * D2R)).addScaledVector(rt, this.ltSide * Math.sin(80 * D2R)).normalize();
        this.maneuver = 'LEAD TURN (정면 교차)';
        return { cmd: this.flyLift(_t, 99), throttle: 1, sb: false, gunShot: false };
      } else if (!headOn) this.ltSide = 0;
      // 수세(기총 위협): 받음각을 CAS 한계 30°까지 써서 순간 선회 최대 (공세·중립은 27°로 에너지 보존이 유리)
      if (R < 1500 && hisAta < 25 * D2R && ata > 60 * D2R) {
        if (sk.defAoa) this.aoaNow = sk.defAoa;
        // ---- 기총 방어: 사격 해가 거의 잡혔을 때(5° 이내)만 선회면을 100~160° 바꿔 최대 G (예측 불가한 면 전환), 그 외엔 공격자 쪽으로 최대 G 브레이크
        if (!this.gd || this.gd.headOn) this.gd = { t: 0, th: 0 };
        this.gd.t -= dt;
        if (this.gd.t <= -0.25 && hisLeadE < 5 * D2R) {
          this.gd.th = bankNow(ac) + (Math.random() < 0.5 ? -1 : 1) * (100 + Math.random() * 60) * D2R;
          this.gd.t = 0.55 + Math.random() * 0.45;
        }
        const thr = R < 900 && Vc > 60 ? 0.35 : 1, sbk = R < 900 && Vc > 90;   // 가까이서 빠르게 붙으면 감속 → 오버슛 유도
        if (this.gd.t > 0) {
          this.maneuver = 'GUNS JINK (면 전환)';
          liftDirWorld(ac, this.gd.th, _t);
          return { cmd: this.flyLift(_t, 99), throttle: thr, sb: sbk, gunShot: false };
        }
        this.maneuver = 'GUNS DEFENSE (브레이크)';
        return { cmd: this.steer(los, sk.pull), throttle: thr, sb: sbk, gunShot: false };
      }
      // ---- 공세 오버슛 관리: 꼬리를 문 상태에서 거리에 비해 접근률이 크면(상대가 감속·브레이크) 래그 + 감속(+스피드브레이크),
      //  교차각이 크면 하이 요요로 접근률을 고도로 바꿔 앞으로 튀어나가지 않음 (튀어나가면 상대가 리버설로 꼬리를 문다)
      let lead = sk.lead || 1.2;
      this.maneuver = 'LEAD PURSUIT';
      const offensive = ata < 60 * D2R && aa < 90 * D2R;
      const closeLim = Math.max(30, (R - 300) / 2.5);
      if (sk.overshoot && offensive && R < 1300 && Vc > closeLim) {
        // 하이 요요: 상대 래그점(1초 뒤) 방향 양력면에서 위로 45° 비튼 면으로 최대 G — 큰 G로 속도를 깎고 비행경로를 면 밖으로 빼서
        //  수평 접근률을 줄임 (G를 풀고 위를 보면 속도가 그대로라 결국 앞으로 튀어나감) + 아이들·스피드브레이크
        const u = _d.copy(fm.vel).normalize();
        _t.copy(tf.pos).addScaledVector(tf.vel, -1).sub(fm.pos);
        _t.addScaledVector(u, -_t.dot(u)).normalize();
        const upP = _w.copy(up).addScaledVector(u, -u.y).normalize();
        if (agl > 1200) _t.addScaledVector(upP, 1.0).normalize();
        this.maneuver = Vc > closeLim + 60 ? 'HIGH YO-YO + 감속' : 'HIGH YO-YO';
        return { cmd: this.flyLift(_t, 99), throttle: 0.2, sb: Vc > closeLim + 40, gunShot: false };
      }
      // 최대 G 리드 추적: 상대의 1.2초 앞을 겨눠 선회 안쪽을 자름 (사거리 안에서는 위의 기총 추적으로 넘어감)
      //  꼬리를 문 상태에서는 거리에 맞는 접근률을 스로틀·스피드브레이크로 유지 (감속하는 상대에게 너무 빨리 붙지 않음)
      let thr = 1, sb = false;
      if (sk.overshoot && offensive && R < 3000) {
        const VcT = clamp((R - 300) / 3, 30, 200);
        thr = Vc > VcT + 40 ? 0.25 : Vc > VcT + 10 ? 0.8 : 1;
        sb = Vc > VcT + 90 && s.V > 140;
        if (thr < 0.5) this.maneuver = 'LEAD PURSUIT + 감속';
      }
      _t.copy(tf.pos).addScaledVector(tf.vel, lead).sub(fm.pos).normalize();
      if (agl < 1500 && _t.y < 0) { _t.y *= Math.max(0, (agl - 600) / 900); _t.normalize(); }
      return { cmd: this.steer(_t, sk.pull), throttle: thr, sb, gunShot: false };
    }

    // ---- 상황 판정: 기량이 높을수록 자주 재판단
    this.bfmT -= dt;
    if (this.bfmT <= 0) {
      this.bfmT = sk.think * (0.7 + Math.random() * 0.6);
      if (hisAta < 50 * D2R && aa > 100 * D2R && ata > 60 * D2R && R < 6000) this.bfmMode = 'defensive';
      else if (ata < 70 * D2R && aa < 100 * D2R) this.bfmMode = 'offensive';
      else this.bfmMode = 'neutral';
    }
    const mode = this.bfmMode;

    let dir = null, pull = sk.pull, throttle = 1.0, sb = false;
    // 에너지 관리 (tac 2+): 코너 속도보다 느리면 지속 선회 G로 제한해 에너지를 아끼고, 빠르면 남는 속도를 고도로 저장
    const slow = cas < corner - 25, fast = cas > corner + (tac >= 4 ? 40 : 60);
    const energyPull = tac >= 2 && slow ? sk.pull * 0.85 : sk.pull;   // 느릴 때 약간만 덜 당겨 실속·에너지 고갈 방지

    if (mode === 'offensive') {
      // 기총 추적은 사거리 근처에서만 (멀거나 벌어지는 중이면 아래 리드 추적으로 먼저 접근)
      if (ata < 30 * D2R && (R < sk.gunRange * 1.15 || (R < sk.gunRange * 1.6 && Vc > 15))) {
        this.maneuver = 'GUNS TRACK';
        return { cmd: null, throttle, sb, gunShot: true };
      }
      // 오버슛 위험: 가까운데 접근률이 크거나(1.5 km·140 m/s), 교차각이 큰 채로 1 km 안에 들어올 때
      const overshoot = tac >= 1 && ((R < 1500 && Vc > 140) || (R < 1000 && Vc > 60 && aa > 40 * D2R));
      if (overshoot) {
        // 래그 추적: 적 꼬리 뒤쪽을 겨눠 오버슛 방지. tac2+는 하이 요요 — 선회면 위로 올라가 접근률을 고도로 전환
        dir = tf.pos.clone().addScaledVector(tV, -Math.min(600, R * 0.5)).sub(fm.pos).normalize();
        if (tac >= 2) dir.addScaledVector(up, 0.35).normalize();
        throttle = tac >= 2 ? 0.75 : 0.85;
        sb = tac >= 3 && Vc > 120 && R < 800;
        this.maneuver = tac >= 2 ? 'HIGH YO-YO' : 'LAG PURSUIT';
      } else if (Vc < 40 && R > 1000) {
        // 리드 추적: 평균 가속도로 예측한 미래 위치를 겨눠 선회 안쪽을 잘라 거리 단축 (흔드는 표적은 좌우가 상쇄되어 평균 진로로)
        // tac2+는 속도가 부족하면 로 요요(기수를 낮춰 가속하며 안쪽으로)
        const tl = clamp(R / 450, 1, 4);
        dir = tf.pos.clone().addScaledVector(tf.vel, tl).addScaledVector(this.tAccAvg, 0.5 * tl * tl * Math.max(0.5, sk.predict)).sub(fm.pos).normalize();
        if (tac >= 2 && cas < corner + 10 && agl > 2000) { dir.addScaledVector(up, -0.25).normalize(); this.maneuver = 'LOW YO-YO'; }
        else this.maneuver = 'LEAD PURSUIT';
        pull = energyPull;
      } else {
        // 퓨어~약한 리드 추적, 거리에 맞춰 접근률 조절
        dir = pred(clamp(R / 900, 0, 2.5)).sub(fm.pos).normalize();
        const want = clamp((R - 500) / 4, -20, 120);
        throttle = clamp(0.85 + (want - Vc) * 0.012, 0.3, 1.0);
        pull = energyPull;
        this.maneuver = 'PURSUIT';
      }
    } else if (mode === 'defensive') {
      if (tac >= 1 && R < 1200 && hisAta < 12 * D2R) {
        // 기총 방어 재킹: 불규칙한 주기로 선회면을 바꿔 상대가 리드를 잡지 못하게
        this.jink -= dt;
        if (this.jink < -this.jinkHalf) { this.jinkHalf = sk.jinkT * (0.6 + Math.random() * 0.8); this.jink = this.jinkHalf; }
        this.maneuver = 'GUNS JINK';
        return { cmd: { pitch: sk.pull, roll: this.jink > 0 ? 1 : -1, yaw: 0, ang: 0 }, throttle: tac >= 3 && Vc > 60 ? 0.4 : 1, sb: tac >= 3 && Vc > 90, gunShot: false };
      }
      // 브레이크 선회: 공격자 쪽으로 양력벡터 → 상대의 AA를 키워 사격각·추적각을 빼앗음
      dir = los.clone();
      this.maneuver = 'BREAK';
      // 오버슛 유도: 적이 가까이서 빠르게 접근하며 사격각을 잡으려 할 때만 순간적으로 감속
      if (tac >= 3 && R < 1200 && Vc > 60 && hisAta < 20 * D2R) { throttle = 0.35; sb = true; this.maneuver = 'BREAK + 오버슛 유도'; }
      // 수직 브레이크: 에너지 우위가 클 때만 (상대가 따라 올라오면 먼저 속도가 빠짐)
      if (tac >= 4 && R > 3000 && dE > 1500 && cas > corner) { dir.addScaledVector(up, 0.5).normalize(); this.maneuver = 'VERTICAL BREAK'; }
      if (tac >= 2 && cas < 120 && agl > 1500) { dir = myV.clone().addScaledVector(up, -0.5).normalize(); pull = 0.3; throttle = 1; sb = false; this.maneuver = 'UNLOAD (가속)'; }
    } else {
      const headOn = ata < 35 * D2R && aa > 140 * D2R;
      const side = new THREE.Vector3().crossVectors(los, up);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0); else side.normalize();
      if (headOn && R > 1500) {
        // 정면 교차: 충돌 방지 측면 간격. tac3+는 3.5 km부터 적 뒤쪽 공간을 겨눠 일찍 선회(리드 턴)해 각도 선점
        if (tac >= 3 && R < 3500) { dir = tf.pos.clone().addScaledVector(tV, -1500).addScaledVector(side, 600).sub(fm.pos).normalize(); this.maneuver = 'LEAD TURN'; }
        else { dir = tf.pos.clone().addScaledVector(side, 300).sub(fm.pos).normalize(); this.maneuver = 'MERGE'; }
        pull = 0.6;
      } else {
        // 선회전: 적의 미래 위치(꼬리 쪽)를 향해 선회. 에너지가 남으면 경사 상승 선회로 고도 저장, 부족하면 기수를 낮춰 가속
        dir = pred(clamp(R / 700, 0.5, 3)).sub(fm.pos).normalize();
        pull = energyPull;
        this.maneuver = 'TURN';
        if (tac >= 2 && fast && agl > 1500) { dir.addScaledVector(up, 0.45).normalize(); pull = sk.pull; this.maneuver = 'OBLIQUE UP (속도→고도)'; }
        else if (tac >= 2 && slow && agl > 2000) { dir.addScaledVector(up, -0.35).normalize(); this.maneuver = 'NOSE LOW (가속)'; }
      }
    }
    // 저고도 하드덱: 기수 하강 성분 제한
    if (agl < 1500 && dir.y < 0) { dir.y *= Math.max(0, (agl - 600) / 900); dir.normalize(); }
    // 공세 추적 중에는 표적의 G를 피드포워드로 써서 같은 선회를 따라감
    if (mode === 'offensive') this.ffNz = tf.s.nz * 0.85;
    const cmd = this.steer(dir, pull);
    this.ffNz = null;
    return { cmd, throttle, sb, gunShot: false };
  }

  update(dt, game) {
    const ac = this.ac, fm = ac.fm, s = fm.s, sk = this.skill;
    const ctl = fm.ctl;
    if (!ac.alive || fm.destroyed) { ctl.pitch = 0; ctl.roll = 0.3; ctl.throttle = 0; return; }
    this.lastDt = dt;
    if (this.maneuver !== this._lastMan) { this.prevEp = null; this.aimPrev = null; this.errI = 0; this._lastMan = this.maneuver; }
    this.missileCd -= dt; this.flareCd -= dt; this.thinkT -= dt;
    const target = game.player && game.player.alive && !game.player.fm.destroyed ? game.player : null;
    const world = game.world;
    fm.sbCmd = false;
    // 표적 가속도(선회 중 구심가속도 포함)를 저역통과로 추정 → 리드 추적 시 선회 예측
    if (target) {
      if (!this.tPrevVel) this.tPrevVel = target.fm.vel.clone();
      _v.subVectors(target.fm.vel, this.tPrevVel).divideScalar(Math.max(dt, 1e-3));
      if (_v.length() > 120) _v.setLength(120);
      this.tAcc.lerp(_v, clamp(dt * 3, 0, 1));
      this.tPrevVel.copy(target.fm.vel);
      // 표적의 평균 진행(약 3초 평활) — 위브·시저스처럼 좌우로 흔드는 표적을 상대로 모서리를 잘라 접근할 때 사용
      if (!this.tAccAvg) this.tAccAvg = new THREE.Vector3();
      this.tAccAvg.lerp(this.tAcc, clamp(dt / 2.5, 0, 1));   // 2.5초 평균 가속도: 지속 선회는 남고, 좌우로 흔드는 위브는 상쇄
      // 순간 가속도 = 양력(G × 캐노피 위 방향) + 중력. 상대 기체의 자세를 보고 선회 방향 전환을 바로 읽는 것과 같음
      const tq = target.fm.quat;
      this.tAccNow.set(2 * (tq.x * tq.y - tq.w * tq.z), 1 - 2 * (tq.x * tq.x + tq.z * tq.z), 2 * (tq.y * tq.z + tq.w * tq.x)).multiplyScalar((target.fm.s.nz || 1) * G0);
      this.tAccNow.y -= G0;
    }

    // ---- 위협 평가 (미사일 경보)
    const threats = game.weapons.threatsTo(ac);
    let threat = null, threatR = 1e9;
    for (const m of threats) { const r = m.pos.distanceTo(fm.pos); if (r < threatR) { threatR = r; threat = m; } }

    let cmd, throttle = 0.95;
    // ---- 지형 회피 (최우선)
    let danger;
    if (sk.expert) {
      // 정밀 판정 (전설): 지금 강하각에서 낼 수 있는 G로 수평 회복에 필요한 고도 + 반응 여유 vs 실제 고도,
      //  그리고 2초 앞 직선 경로의 지형 (산). 직선으로 몇 초 앞을 보는 단순 판정은 선회 중 강하에서 너무 일찍 당겨 싸움을 버림
      const gam = Math.asin(clamp(fm.vel.y / Math.max(s.V, 1), -1, 1));
      const nAv = clamp(Math.max(1, s.nz) * 27 * D2R / Math.max(s.alpha, 4 * D2R), 2.5, 7);
      const need = gam < 0 ? s.V * s.V / (G0 * (nAv - 1)) * (1 - Math.cos(gam)) - fm.vel.y * 0.6 : 0;
      let ahead = 1e9;
      for (const tt of [1, 2]) { _t.copy(fm.pos).addScaledVector(fm.vel, tt); ahead = Math.min(ahead, _t.y - world.heightAt(_t.x, _t.z)); }
      // 1초 뒤 예측 (반응 시간): 지금 양력벡터·G를 유지하면 비행경로가 어디까지 꺾이는가 — 아래로 브레이크 중이면
      //  강하각이 초당 20° 이상 커지므로 현재 강하각만 보면 늦는다
      const q = fm.quat;
      _A.set(2 * (q.x * q.y - q.w * q.z), 1 - 2 * (q.x * q.x + q.z * q.z), 2 * (q.y * q.z + q.w * q.x)).multiplyScalar(Math.max(0, s.nz) * G0);
      _A.y -= G0;
      _w.copy(fm.vel).addScaledVector(_A, 1.0);
      const V1 = Math.max(_w.length(), 1), g1 = Math.asin(clamp(_w.y / V1, -1, 1));
      const agl1 = s.agl + fm.vel.y + 0.5 * _A.y;
      const need1 = g1 < 0 ? V1 * V1 / (G0 * (nAv - 1)) * (1 - Math.cos(g1)) - _w.y * 0.6 : 0;
      danger = s.agl < need + 250 || agl1 < need1 + 200 || ahead < 200 || s.agl < 150;
      if (this.state === 'recover' && s.agl < need + 300) danger = true;   // 회복 중에는 여유를 더 두고 해제 (들락날락 방지)
    } else {
      const look = Math.max(4, s.V / 40);
      let minClear = 1e9;
      for (const tt of [1.5, 3, look]) {
        _t.copy(fm.pos).addScaledVector(fm.vel, tt);
        minClear = Math.min(minClear, _t.y - world.heightAt(_t.x, _t.z));
      }
      danger = minClear < 350 || s.agl < 250 || (fm.pos.y < 900 && s.vs < -40);
    }
    if (danger) {
      _d.set(fm.vel.x, 0, fm.vel.z).normalize().multiplyScalar(sk.expert ? 1 : 0.5);
      _d.y = sk.expert ? 0.45 : 1; _d.normalize();
      // 전설: 강하 중이면 양력벡터를 곧장 위로(날개 수평) 두고 최대 G — 굴리면서도 양력이 위쪽 반구에 있는 한 G를 풀지 않음
      if (sk.expert && (fm.vel.y < 0.3 * s.V || this.rlActive)) { this.aoaNow = 30; cmd = this.flyLiftP(liftDirWorld(ac, 0, _t), 99, true); }
      else cmd = this.steer(_d, 1.0);
      throttle = 1;
      this.state = 'recover';
    } else if (threat && threatR < 7000 && Math.random() < 1 - Math.exp(-dt / sk.react) + (this.state === 'defend' ? 1 : 0)) {
      // ---- 방어: 미사일 방향에 수직(빔)으로 급선회 + 플레어
      this.state = 'defend';
      _t.subVectors(threat.pos, fm.pos).normalize();
      _d.crossVectors(_t, _v.set(0, 1, 0)).normalize();
      if (_d.dot(fm.vel) < 0) _d.negate();
      _d.y = -0.15; _d.normalize();
      cmd = this.steer(_d, sk.pull);
      cmd.pitch = Math.max(cmd.pitch, sk.pull * 0.9 * (cmd.ang > 0.3 ? 1 : 0.6));
      throttle = threat.spec.seeker === 'IR' ? 0.78 : 1;
      if (this.flareCd <= 0 && threatR < 4500 && Math.random() < sk.flare) {
        game.weapons.dispense(ac);
        this.flareCd = 0.9 + Math.random() * 0.8;
      }
    } else if (target && this.ingressAlt != null) {
      // ---- 1:1 머지 진입: 침로 유지, 고도 유지, 날개 수평 (정면 교차를 위해 기동하지 않음)
      this.state = 'ingress';
      _d.copy(fm.vel).setY(0).normalize();
      _d.y = clamp((this.ingressAlt - fm.pos.y) / 2500, -0.12, 0.12);
      cmd = this.steer(_d.normalize(), 0.5, true, true);
      throttle = sk.tac >= 2 ? 1.0 : 0.85;   // 상위 기량: 애프터버너로 진입해 머지에서 속도(에너지) 우위
    } else if (target) {
      this.state = 'engage';
      const tf = target.fm;
      _t.subVectors(tf.pos, fm.pos);
      const range = _t.length();
      const los = _t.clone().normalize();
      const aspect = los.dot(_v.copy(tf.vel).normalize()); // >0: 표적 꼬리 쪽
      const clos = -_b.subVectors(tf.vel, fm.vel).dot(los);
      let gunShot = false;
      if (range > 9000) {
        // 원거리(BVR): 선회 예측 리드 추적으로 접근 + 고도 우위 확보, 에너지 보존을 위해 당김 제한
        const tl = clamp(range / 700, 0, 4);
        const aim = _d.copy(tf.pos).addScaledVector(tf.vel, tl).addScaledVector(this.tAcc, 0.5 * tl * tl * sk.predict).sub(fm.pos).normalize();
        if (fm.pos.y < tf.pos.y + 500) { aim.y += 0.12; aim.normalize(); }
        cmd = this.steer(aim, sk.pull * (range > 15000 ? 0.4 : 0.65));
        throttle = clos < 80 || sk.fullAB ? 1.0 : 0.85;
        this.maneuver = 'BVR';
      } else {
        const B = this.bfm(dt, game, target);
        throttle = B.throttle; fm.sbCmd = B.sb;
        if (B.gunShot) gunShot = true; else cmd = B.cmd;
      }
      if (gunShot) {
        // 기관포 추적: 리드 조준(선회 예측 포함) + 접근률 제어(약 450 m 유지)
        // 탄도 해석 리드 + 선회 예측 (전설·정예: 표적 자세로 읽은 순간 가속도, 그 외: 속도 변화로 추정한 가속도)
        const lead = gunLead(ac, target, _d, sk.predict >= 1 ? this.tAccNow : this.tAcc, sk.predict);
        const aim = lead.dir.clone();
        if (clos > 120 && range < 900 && aspect > 0) aim.copy(los).addScaledVector(tf.vel.clone().normalize(), -0.4).normalize();
        // 조준 흔들림: 저주파 잡음 (매 프레임 무작위면 조준점 각속도가 튀어 추적이 망가짐)
        this.jit.x += ((Math.random() - 0.5) * sk.aimErr * 2 - this.jit.x) * clamp(dt * 1.5, 0, 1);
        this.jit.y += ((Math.random() - 0.5) * sk.aimErr * 2 - this.jit.y) * clamp(dt * 1.5, 0, 1);
        this.jit.z += ((Math.random() - 0.5) * sk.aimErr * 2 - this.jit.z) * clamp(dt * 1.5, 0, 1);
        aim.add(this.jit).normalize();
        // G 피드포워드: 전설은 조준점의 각속도로 필요한 G를 계산 (안쪽으로 파고들어 시선 각속도가 커져도 따라감), 그 외는 표적의 G
        if (sk.expert) { if (sk.trackAoa) this.aoaNow = sk.trackAoa; cmd = this.trackNose(aim, dt); }   // 사격 추적은 받음각 30°까지   // 전설: 안정축 분리 정밀 추적 (롤 = 조준점을 양력면에, G = 면 안 오차)
        else {
          this.ffNz = tf.s.nz;
          cmd = this.steer(aim, sk.pull, true, range < 1500);
          this.ffNz = null;
        }
        const fwd = _v.set(0, 0, -1).applyQuaternion(fm.quat);
        const err = Math.acos(clamp(fwd.dot(aim), -1, 1));
        const tol = Math.atan(8 / range) + sk.fireTol * D2R;
        if (range < sk.gunRange && err < tol && fm.ammo > 0) this.fireSol(0.2 + Math.random() * 0.25);   // 짧은 점사, 매 프레임 재판정
        const want = clamp((range - 450) / 3, -30, 90);
        throttle = clamp(0.85 + (want - clos) * 0.015, 0.15, 1.0);
        fm.sbCmd = range < 1500 && clos > want + 45;
      }
      // 스냅샷 (tac2+): 기총 추적 모드가 아니어도 리드 조준점이 기수를 스쳐 지나가는 순간 사격
      if (!gunShot && sk.tac >= 2 && range < sk.gunRange && fm.ammo > 0 && !this.holdFire) {
        const snapAim = gunLead(ac, target, _d, sk.predict >= 1 ? this.tAccNow : this.tAcc, sk.predict).dir;
        const nose = _v.set(0, 0, -1).applyQuaternion(fm.quat);
        if (Math.acos(clamp(nose.dot(snapAim), -1, 1)) < Math.atan(8 / range) + sk.fireTol * 0.8 * D2R) this.fireSol(0.15);
      }
      // 미사일 발사 판단
      const fwd = _v.set(0, 0, -1).applyQuaternion(fm.quat);
      const off = Math.acos(clamp(fwd.dot(los), -1, 1));
      if (this.missileCd <= 0 && !this.holdFire) {
        if (ac.stores.srm > 0 && range > 900 && range < 7000 * (aspect > 0.3 ? 1.2 : 0.7) && off < 22 * D2R) {
          ac.fireMissile(game, 'R-73', target);
          this.missileCd = sk.missileCd * (0.7 + Math.random() * 0.6);
        } else if (ac.stores.mrm > 0 && range > 6000 && range < 28000 && off < 25 * D2R) {
          ac.lock = target;
          ac.fireMissile(game, 'R-77', target);
          this.missileCd = sk.missileCd * (1 + Math.random());
        }
      }
      if (ac.stores.mrm >= 0) ac.lock = range < 40000 && off < 60 * D2R ? target : null;
      if (s.V < 140 && !this.rlActive) { throttle = 1.0; fm.sbCmd = false; }
      // 공중 충돌 회피: 너무 가까우면 사격 중지, 표적 위로 넘어가며 이탈
      // 최근접점 예측: 3초 안에 120 m 이내로 스치면 최근접 방향의 반대쪽으로 회피 (정면 교차의 빠른 접근률에도 대응)
      //  전설은 1.8초·45 m (실제 충돌 판정은 9 m) — 넓게 잡으면 시저스·근접 추적마다 기동을 버리고 이탈해 사격 기회를 내줌
      const rvx = tf.vel.x - fm.vel.x, rvy = tf.vel.y - fm.vel.y, rvz = tf.vel.z - fm.vel.z;
      const rv2 = Math.max(rvx * rvx + rvy * rvy + rvz * rvz, 1);
      const px0 = tf.pos.x - fm.pos.x, py0 = tf.pos.y - fm.pos.y, pz0 = tf.pos.z - fm.pos.z;   // (_t는 bfm에서 덮어쓰므로 새로 계산)
      const tc = -(px0 * rvx + py0 * rvy + pz0 * rvz) / rv2;
      if (tc > 0 && tc < (sk.expert ? 1.8 : 3)) {
        const cx = px0 + rvx * tc, cy = py0 + rvy * tc, cz = pz0 + rvz * tc;
        const dc = Math.hypot(cx, cy, cz);
        if (dc < (sk.expert ? 45 : 120)) {
          // 최근접 시 상대가 있을 방향(c)의 반대쪽으로 양력벡터 → 최대 당김
          if (dc < 1) _d.set(0, -1, 0); else _d.set(-cx / dc, -cy / dc, -cz / dc);
          _d.addScaledVector(_v.copy(fm.vel).normalize(), 2).normalize();
          if (this.rlActive) {
            // 강화학습 정책 기체: 학습 환경(rl/env.py _safety)과 같은 회피 — 최근접 반대쪽(속도에 수직)으로 최대 G
            if (dc < 1) _d.set(0, -1, 0); else _d.set(-cx / dc, -cy / dc, -cz / dc);
            const u = _v.copy(fm.vel).normalize();
            _d.addScaledVector(u, -_d.dot(u));
            if (s.agl < 1500 && _d.y < 0) _d.y *= Math.max(0, (s.agl - 500) / 1000);
            if (_d.length() < 1e-3) liftDirWorld(ac, 0, _d); else _d.normalize();
            cmd = this.flyLiftP(_d, 99, false);
          } else {
            if (s.agl < 1500 && _d.y < 0) { _d.y *= Math.max(0, (s.agl - 500) / 1000); _d.normalize(); }   // 저고도: 아래로 피하지 않음
            cmd = this.steer(_d, sk.pull);
            cmd.pitch = Math.max(cmd.pitch, 0.6);
          }
          this.burst = 0; this.solNow = false;
          this.maneuver = '충돌 회피';
        }
      }
    } else {
      // 초계 선회
      this.state = 'patrol';
      _t.subVectors(this.patrolCenter, fm.pos); _t.y = 0;
      _d.copy(fm.vel).setY(0).normalize();
      _v.crossVectors(_d, new THREE.Vector3(0, 1, 0));
      const dir = _t.length() > 8000 ? _t.normalize() : _d.addScaledVector(_v, 0.5).normalize();
      dir.y = clamp((5000 - fm.pos.y) / 3000, -0.3, 0.3);
      cmd = this.steer(dir.normalize(), 0.4);
      throttle = 0.7;
    }

    const track = this.maneuver === 'GUNS TRACK';   // 기총 추적 중에는 더 빠르게 스틱 반응
    ctl.pitch += (cmd.pitch - ctl.pitch) * clamp(dt * (track ? this.gain.smooth : 6), 0, 1);
    ctl.roll += (cmd.roll - ctl.roll) * clamp(dt * (track ? 12 : 8), 0, 1);
    ctl.yaw += (cmd.yaw - ctl.yaw) * clamp(dt * 6, 0, 1);
    ctl.throttle += (throttle - ctl.throttle) * clamp(dt * 2, 0, 1);
    // 사격 해가 AIM_SETTLE 동안 이어졌을 때만 점사 시작
    this.aimHold = this.solNow ? this.aimHold + dt : 0;
    if (this.solNow && this.aimHold >= (this.skill.settle ?? AIM_SETTLE) - 1e-9) this.burst = Math.max(this.burst, this.solBurst);
    this.solNow = false; this.solBurst = 0;
    this.burst -= dt;
    if (this.holdFire) this.burst = 0;
    ac.trigger = this.burst > 0;
  }
}
