// 양력벡터 기하 도우미 (AI 기총 방어·면 전환용)
// 수평선 기준 경사각 θ로 양력 방향(캐노피 위쪽 방향)을 정의: θ=0 위, ±90° 수평 좌/우, 180° 아래 (속도에 수직인 평면 안)
import { clamp } from './math.js';

const _b = { vx: 0, vy: 0, vz: 0, lx: 0, ly: 1, lz: 0 };
const _ld = { x: 0, y: 0, z: 0 };

/** 실제 기체 → 속도·양력 방향 (양력 방향은 속도에 수직으로 투영) */
function fromAircraft(ac, out = _b) {
  const fm = ac.fm, q = fm.quat;
  out.vx = fm.vel.x; out.vy = fm.vel.y; out.vz = fm.vel.z;
  out.lx = 2 * (q.x * q.y - q.w * q.z); out.ly = 1 - 2 * (q.x * q.x + q.z * q.z); out.lz = 2 * (q.y * q.z + q.w * q.x);
  const V = Math.hypot(out.vx, out.vy, out.vz) || 1, ux = out.vx / V, uy = out.vy / V, uz = out.vz / V;
  const d = out.lx * ux + out.ly * uy + out.lz * uz;
  let lx = out.lx - d * ux, ly = out.ly - d * uy, lz = out.lz - d * uz;
  let L = Math.hypot(lx, ly, lz);
  if (L < 1e-4) { lx = -ux * uy; ly = 1 - uy * uy; lz = -uz * uy; L = Math.hypot(lx, ly, lz) || 1; }
  out.lx = lx / L; out.ly = ly / L; out.lz = lz / L;
  return out;
}

function liftFromBank(b, th, out = _ld) {
  const V = Math.hypot(b.vx, b.vy, b.vz) || 1, ux = b.vx / V, uy = b.vy / V, uz = b.vz / V;
  let ax = -ux * uy, ay = 1 - uy * uy, az = -uz * uy;          // 위쪽을 속도에 수직으로 투영
  let A = Math.hypot(ax, ay, az);
  if (A < 0.05) { ax = b.lx; ay = b.ly; az = b.lz; A = 1; }    // 수직 비행: 현재 양력 방향 기준
  ax /= A; ay /= A; az /= A;
  const sx = uy * az - uz * ay, sy = uz * ax - ux * az, sz = ux * ay - uy * ax;   // 오른쪽
  const c = Math.cos(th), s = Math.sin(th);
  out.x = ax * c + sx * s; out.y = ay * c + sy * s; out.z = az * c + sz * s;
  return out;
}

/** 실제 기체의 현재 양력 방향의 수평선 기준 경사각 */
export function bankNow(ac) {
  const b = fromAircraft(ac);
  liftFromBank(b, 0, _ld); const ux = _ld.x, uy = _ld.y, uz = _ld.z;
  liftFromBank(b, Math.PI / 2, _ld);
  return Math.atan2(b.lx * _ld.x + b.ly * _ld.y + b.lz * _ld.z, clamp(b.lx * ux + b.ly * uy + b.lz * uz, -1, 1));
}

/** 경사각 θ의 양력 방향(월드)을 실제 기체 기준으로 계산 */
export function liftDirWorld(ac, th, out) {
  liftFromBank(fromAircraft(ac), th, _ld);
  return out.set(_ld.x, _ld.y, _ld.z);
}
