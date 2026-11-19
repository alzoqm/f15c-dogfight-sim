// F-15C Eagle 제원 및 공력 계수 모델
// 좌표계: 기체 공력 좌표 (x: 기수방향, y: 오른쪽 날개, z: 아래)
// 조종면 부호 규약(본 시뮬레이터): de>0 기수 올림, da>0 우측 롤, dr>0 기수 우측
import { D2R, R2D, clamp, interp, smoothstep } from './math.js';

export const F15C = {
  name: 'F-15C Eagle',
  // 기하 제원
  S: 56.5,        // 날개 면적 m² (608 ft²)
  b: 13.05,       // 날개 폭 m
  c: 4.86,        // 평균공력시위(MAC) m
  length: 19.43,
  // 질량 제원
  massEmpty: 12973,      // 자체 중량 kg (28,600 lb)
  massCrew: 110,         // 조종사 + 장비
  fuelInternal: 6103,    // 내부 연료 kg (13,455 lb)
  gunAmmo: 940,
  roundMass: 0.26,       // 20mm PGU 탄 1발 (탄피 포함)
  // 관성 모멘트 (NASA F-15 시뮬레이션 자료, 20,412 kg 기준, kg·m²)
  inertiaRef: { mass: 20412, Ixx: 38912, Iyy: 223846, Izz: 254760, Ixz: -705 },
  // 엔진: P&W F100-PW-220 x 2
  engine: {
    milSL: 64900,   // 군용추력(MIL) N / 엔진 (14,590 lbf)
    abSL: 105700,   // 최대 A/B 추력 N / 엔진 (23,770 lbf)
    idleN: 0.66,    // 아이들 회전수 비율
    yOffset: 0.65,  // 엔진 횡방향 위치 m
    tsfcDry: 2.12e-5, // kg/(N·s)  ≈ 0.75 lb/(lbf·h)
    tsfcAB: 5.95e-5,  // kg/(N·s)  ≈ 2.1 lb/(lbf·h)
  },
  // 조종면 한계와 구동기 속도
  surf: {
    deUp: 29 * D2R, deDown: 15 * D2R, deRate: 40 * D2R,   // 전가동 수평 안정판(스태빌레이터)
    daMax: 20 * D2R, daRate: 90 * D2R,                    // 에일러론 + 차동 스태빌레이터
    drMax: 30 * D2R, drRate: 90 * D2R,                    // 쌍 러더
  },
  limits: {
    nzMax: 9.0, nzMin: -3.0,
    nzStructural: 13.5, nzStructuralNeg: -6.5,
    alphaCAS: 30 * D2R, alphaCASneg: -12 * D2R,
    vneCAS: 800 / 1.943844,      // 800 KCAS
    machMax: 2.5,
    gearSpeed: 250 / 1.943844,   // 기어 내림 한계 250 KCAS
    flapSpeed: 250 / 1.943844,
  },
  // 랜딩기어 (공력좌표, CG 기준 m)
  gear: [
    { name: 'NOSE', r: [4.4, 0, 2.2], k: 2.6e5, c: 3.6e4, stroke: 0.32, steer: true, brake: false },
    { name: 'LEFT', r: [-0.75, -1.38, 2.2], k: 6.2e5, c: 9.5e4, stroke: 0.36, steer: false, brake: true },
    { name: 'RIGHT', r: [-0.75, 1.38, 2.2], k: 6.2e5, c: 9.5e4, stroke: 0.36, steer: false, brake: true },
  ],
  // 충돌 감지점 (기수, 꼬리, 날개끝, 수직미익, 동체 하부, 노즐)
  hardpoints: [
    [10.3, 0, 0.15], [-8.9, 0, 0.3], [1.0, -6.5, 0.3], [1.0, 6.5, 0.3],
    [-7.0, -1.75, -3.5], [-7.0, 1.75, -3.5], [0, 0, 1.4], [-3.0, 0, 1.3],
    [-7.7, -0.65, 0.66], [-7.7, 0.65, 0.66], [-8.6, -4.3, 0.15], [-8.6, 4.3, 0.15],
  ],
  // 무장 질량
  aim9Mass: 85.3,
  aim120Mass: 152,
};

// ---------------------------------------------------------------------------
// 공력 테이블 (마하 수 / 받음각 함수)
// ---------------------------------------------------------------------------

// 저속 양력곡선 CL(α[deg]) — F-15 특유의 완만한 실속 특성 (CLmax≈1.52 @ 35°)
const CL_TAB = [
  [-90, 0], [-70, -0.62], [-50, -0.9], [-40, -0.84], [-30, -0.86], [-25, -0.87],
  [-20, -0.8], [-15, -0.67], [-10, -0.49], [-5, -0.24], [0, 0.03], [5, 0.31],
  [10, 0.6], [15, 0.88], [20, 1.12], [25, 1.32], [30, 1.46], [35, 1.52], [40, 1.48],
  [45, 1.38], [50, 1.26], [60, 1.03], [70, 0.72], [80, 0.37], [90, 0],
];
// 압축성에 의한 양력 기울기 배율
const CLM_TAB = [[0, 1.0], [0.6, 1.04], [0.85, 1.12], [0.95, 1.16], [1.05, 1.12], [1.2, 1.0], [1.5, 0.84], [2.0, 0.66], [2.5, 0.54]];
// 영양력 항력계수 (천음속 항력 증가 포함)
export const CD0_TAB = [[0, 0.0205], [0.7, 0.0205], [0.85, 0.022], [0.92, 0.025], [0.97, 0.032], [1.02, 0.041], [1.1, 0.044], [1.2, 0.0425], [1.5, 0.0375], [2.0, 0.0315], [2.5, 0.0285]];
// 유도항력 계수 K (CDi = K·CL²)
export const K_TAB = [[0, 0.128], [0.8, 0.132], [0.95, 0.15], [1.1, 0.22], [1.5, 0.3], [2.0, 0.4], [2.5, 0.48]];
// 세로 정안정성 Cmα (/rad) — 초음속에서 공력중심 후퇴로 안정성 증가
const CMA_TAB = [[0, -0.28], [0.8, -0.3], [0.9, -0.36], [1.0, -0.55], [1.2, -0.8], [1.5, -0.86], [2.5, -0.86]];
// 피치 감쇠 Cmq
const CMQ_TAB = [[0, -4.6], [0.9, -4.8], [1.2, -3.8], [2.5, -3.0]];
// 스태빌레이터 효율 Cmδe (/rad, 기수올림 양)
const CMDE_TAB = [[0, 0.48], [0.8, 0.48], [0.95, 0.45], [1.1, 0.38], [1.5, 0.33], [2.0, 0.28], [2.5, 0.25]];
// 롤 조종면 효율 마하 배율
const AIL_M_TAB = [[0, 1], [0.9, 1], [1.2, 0.75], [2.0, 0.55], [2.5, 0.5]];
// 방향 안정성 마하 배율
const DIR_M_TAB = [[0, 1], [1.0, 1], [1.5, 0.75], [2.0, 0.55], [2.5, 0.45]];

/** 기본 양력계수 (조종면 효과 제외), α in rad */
export function clBasic(alpha, M) {
  let ad = alpha * R2D;
  let cl;
  if (ad > 90) cl = -interp(CL_TAB, 180 - ad) * 0.7;
  else if (ad < -90) cl = -interp(CL_TAB, -180 - ad) * 0.7;
  else cl = interp(CL_TAB, ad);
  return cl * interp(CLM_TAB, M);
}

/** CAS용: 요구 CL을 만드는 받음각 역산 (선형 영역 이분법) */
export function alphaForCL(CLreq, M, flaps, aMin, aMax) {
  const fl = flaps * 0.2;
  let lo = aMin, hi = aMax;
  if (clBasic(hi, M) + fl <= CLreq) return hi;
  if (clBasic(lo, M) + fl >= CLreq) return lo;
  for (let i = 0; i < 18; i++) {
    const mid = 0.5 * (lo + hi);
    if (clBasic(mid, M) + fl < CLreq) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * 공력 계수 계산. 조종면이 0일 때의 기본 계수와 조종면 미계수(선형)를 함께 반환.
 * s: { alpha, beta, M, phat, qhat, rhat, flaps, sb, gear, agl, stores, t }
 */
export function aeroCoeffs(s, o) {
  const a = s.alpha, b = s.beta, M = s.M;
  const aAbsDeg = Math.abs(a) * R2D;
  const sa = Math.sin(a), ca = Math.cos(a);
  const sb = Math.sin(b);

  // --- 지면효과 (날개 폭 이하 고도에서 유도항력 감소, 양력 증가)
  const hb = Math.max(0.3, s.agl) / F15C.b;
  const ge = (256 * hb * hb) / (1 + 256 * hb * hb);

  // --- 양력
  let CL = clBasic(a, M);
  CL += s.flaps * 0.2 * Math.max(0, ca);
  CL *= 1 + 0.09 * (1 - ge);
  const CLw = CL;

  // --- 항력: 부착류(극곡선)과 박리류(평판) 중 큰 값
  const cd0 = interp(CD0_TAB, M);
  const k = interp(K_TAB, M);
  const cdAtt = cd0 + k * CLw * CLw * ge;
  const cdFlat = cd0 + 1.25 * sa * sa;
  let CD = Math.max(cdAtt, cdFlat) + 0.55 * sb * sb +
    s.flaps * 0.034 + s.gear * 0.024 + s.sb * 0.055 + s.stores;

  // --- 측력
  const CY = -0.9 * sb;

  // --- 롤
  const aPos = clamp(a, 0, 0.8);
  const Clb = -(0.045 + 0.13 * Math.sin(aPos));                 // 상반각 효과 (후퇴익: α 증가 시 증가)
  const Clp = -0.28 + 0.36 * smoothstep(26, 50, aAbsDeg);       // 고받음각에서 감쇠 상실 → 자동회전
  const Clr = 0.04 + 0.1 * clamp(CLw, 0, 1.5);
  const effA = Math.max(0.22, ca * ca) * interp(AIL_M_TAB, M);
  const Clda = 0.09 * effA;
  const Cldr = -0.008;

  // --- 요
  const machDir = interp(DIR_M_TAB, M);
  const Cnb = (aAbsDeg < 32 ? 0.12 * (1 - (aAbsDeg / 32) ** 2) : -0.06 * smoothstep(32, 48, aAbsDeg)) * machDir;
  const Cnr = -0.36 * (0.35 + 0.65 * Math.max(0, Math.cos(2 * a)));
  const Cnp = -0.03 - 0.06 * clamp(sa, 0, 0.7);
  const Cnda = -0.008 * effA;
  const Cndr = 0.075 * Math.max(0.18, ca * ca) * (M > 1 ? interp(DIR_M_TAB, M) : 1);

  // --- 피치
  const Cma = interp(CMA_TAB, M);
  const Cmq = interp(CMQ_TAB, M);
  const Cmde = interp(CMDE_TAB, M) * Math.max(0.35, 1 - 0.5 * sa * sa);
  let Cm = 0.004 + Cma * Math.sin(a) * (Math.abs(a) > Math.PI / 2 ? -1 : 1) + Cmq * s.qhat;
  Cm += -0.015 * s.flaps + 0.012 * s.sb + 0.004 * s.gear - 0.015 * (1 - ge);

  // --- 고받음각 버펫/윙락 (실속 근처 비대칭 교란)
  const buffet = smoothstep(18, 32, aAbsDeg);
  const rock = smoothstep(28, 42, aAbsDeg);
  const t = s.t;
  const Cl = Clb * sb + Clp * s.phat + Clr * s.rhat + rock * 0.012 * Math.sin(t * 2.3 + Math.sin(t * 0.7));
  const Cn = Cnb * sb + Cnr * s.rhat + Cnp * s.phat + rock * 0.004 * Math.sin(t * 1.1 + 1.3);

  o.CL = CL; o.CD = CD; o.CY = CY;
  o.Cl = Cl; o.Cm = Cm; o.Cn = Cn;
  o.Cmde = Cmde; o.CLde = -0.25; o.CDde = 0.05;
  o.Clda = Clda; o.Cldr = Cldr; o.Cnda = Cnda; o.Cndr = Cndr; o.CYdr = -0.15;
  o.buffet = buffet + smoothstep(0.9, 0.98, M) * (1 - smoothstep(1.02, 1.1, M)) * 0.5;
  o.ge = ge;
  return o;
}
