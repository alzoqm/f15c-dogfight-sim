// 국제표준대기(ISA, 1976) 모델과 대기속도 변환
import { G0 } from './math.js';

const R = 287.05287;      // 공기 기체상수 J/(kg·K)
const GAMMA = 1.4;
export const RHO0 = 1.225;
export const P0 = 101325;
export const T0 = 288.15;
export const A0 = Math.sqrt(GAMMA * R * T0); // 340.29 m/s

const _atm = { T: 0, p: 0, rho: 0, a: 0, sigma: 0 };

/** 고도 h[m]에서의 온도, 압력, 밀도, 음속 */
export function isa(h, out = _atm) {
  h = Math.max(-500, Math.min(h, 32000));
  let T, p;
  if (h < 11000) {
    T = T0 - 0.0065 * h;
    p = P0 * Math.pow(T / T0, 5.255877);
  } else if (h < 20000) {
    T = 216.65;
    p = 22632.06 * Math.exp((-G0 * (h - 11000)) / (R * T));
  } else {
    T = 216.65 + 0.001 * (h - 20000);
    p = 5474.889 * Math.pow(216.65 / T, 34.1632);
  }
  out.T = T;
  out.p = p;
  out.rho = p / (R * T);
  out.a = Math.sqrt(GAMMA * R * T);
  out.sigma = out.rho / RHO0;
  return out;
}

/** 피토관 충격압 (아음속: 등엔트로피, 초음속: 레일리 피토 공식) */
export function impactPressure(M, p) {
  if (M <= 1) return p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return p * ((166.9215801 * Math.pow(M, 7)) / Math.pow(7 * M * M - 1, 2.5) - 1);
}

/** 보정대기속도(CAS, m/s) — 계기에 표시되는 속도 */
export function casFromMach(M, p) {
  const qc = impactPressure(M, p);
  let Mc = Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
  if (Mc > 1) {
    let lo = 1, hi = 6;
    for (let i = 0; i < 32; i++) {
      const mid = 0.5 * (lo + hi);
      if (impactPressure(mid, P0) > qc) hi = mid; else lo = mid;
    }
    Mc = 0.5 * (lo + hi);
  }
  return Mc * A0;
}

/** 총압(Pt) — 엔진 연소실 압력 제한 계산용 */
export function totalPressure(M, p) {
  return p + impactPressure(M, p);
}
