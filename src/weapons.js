// 무장: M61A1 20mm 기관포(탄도/예광탄), 공대공 미사일(비례항법 PN, 근접신관), 플레어/채프
import * as THREE from 'three';
import { isa } from './atmosphere.js';
import { G0, D2R, clamp, interp } from './math.js';
import { makeMissileMesh, glowTexture } from './aircraftModel.js';
import { aeroToLocal, localToAero } from './flightmodel.js';

export const MISSILES = {
  'AIM-9X':  { label: 'AIM-9X', short: 'SRM', seeker: 'IR', mass0: 85.3, mass1: 62, burn: 5.0, thrust: 11000, dia: 0.127, cd0: 0.36, maxG: 45, N: 4.0, gimbal: 90 * D2R, maxTime: 30, prox: 9, lethal: 5, arm: 0.45, flareResist: 0.85, eject: 0, smoke: 1.0, rMax: 14000, rMin: 450 },
  'AIM-120C': { label: 'AIM-120C', short: 'MRM', seeker: 'RADAR', mass0: 152, mass1: 100, burn: 8.0, thrust: 15500, dia: 0.178, cd0: 0.32, maxG: 40, N: 3.5, gimbal: 70 * D2R, maxTime: 75, prox: 12, lethal: 7, arm: 1.2, chaffResist: 0.9, eject: 0.4, smoke: 0.35, rMax: 50000, rMin: 1500, pitbull: 16000 },
  'R-73':    { label: 'R-73', short: 'SRM', seeker: 'IR', mass0: 105, mass1: 78, burn: 4.5, thrust: 13500, dia: 0.17, cd0: 0.4, maxG: 38, N: 3.6, gimbal: 60 * D2R, maxTime: 28, prox: 8, lethal: 5, arm: 0.5, flareResist: 0.7, eject: 0, smoke: 1.0, rMax: 11000, rMin: 400 },
  'R-77':    { label: 'R-77', short: 'MRM', seeker: 'RADAR', mass0: 175, mass1: 118, burn: 7.0, thrust: 17000, dia: 0.2, cd0: 0.36, maxG: 38, N: 3.4, gimbal: 60 * D2R, maxTime: 70, prox: 12, lethal: 7, arm: 1.2, chaffResist: 0.8, eject: 0.35, smoke: 0.5, rMax: 40000, rMin: 1500, pitbull: 15000 },
};
const CD_MACH = [[0, 0.8], [0.9, 0.9], [1.1, 1.6], [1.5, 1.4], [2.5, 1.1], [4, 0.85]];

const GUN = { rate: 100, muzzle: 1050, spinUp: 0.4, disp: 0.0028, life: 3.2, k: 0.00026, offset: [1.2, 1.95, -0.25] };

// 예광탄 리본의 6개 꼭짓점: [0=앞끝/1=뒤끝, 좌우, 세계공간 반폭(m)]
const TRACER_LAYOUT = [[0, -1, 0.12], [0, 1, 0.12], [1, -1, 0.04], [1, -1, 0.04], [0, 1, 0.12], [1, 1, 0.04]];

// 미사일 연기 궤적 시각 상수 (m·초)
const TRAIL_FX = { step: 1.3, life: 17, size0: 4, size1: 22, lowStep: 3, lowLife: 6, lowSize1: 12 };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _R = new THREE.Vector3(), _Vr = new THREE.Vector3(), _W = new THREE.Vector3(), _acc = new THREE.Vector3(), _tp = new THREE.Vector3();

/** 두 점이 dt 동안 등속 이동할 때의 최근접 거리와 시점 (상대운동) */
function closestApproach(p0, v0, q0, u0, dt) {
  // 상대 위치 r(t) = (p0-q0) + (v0-u0) t,  t∈[0,dt]
  _a.subVectors(p0, q0); _b.subVectors(v0, u0);
  const bb = _b.lengthSq();
  let t = bb > 1e-9 ? clamp(-_a.dot(_b) / bb, 0, dt) : 0;
  _c.copy(_a).addScaledVector(_b, t);
  return { d: _c.length(), t };
}

// 기체 피탄 형상: 기체축 타원체 (반축 m — 기수 방향 9.7, 날개 방향 6.5, 상하 2.0). 정면 투영 ≈ 41 m², 옆 ≈ 61 m²,
// 위아래(평면형) ≈ 198 m² — 구(반경 6.5 m, 모든 방향 133 m²)로 보면 정면·후방 사격이 실제보다 훨씬 쉬워짐
export const HIT_AXES = [9.7, 6.5, 2.0];
const _hq = new THREE.Quaternion(), _ha = new THREE.Vector3(), _hb = new THREE.Vector3();
/** 탄 경로 [p0, p0+v0·dt]가 표적(q0에서 속도 u0, 자세 quat)의 피탄 타원체를 지나는지 */
function hitsAirframe(p0, v0, q0, u0, quat, dt) {
  _hq.copy(quat).invert();
  localToAero(_ha.subVectors(p0, q0).applyQuaternion(_hq), _a);
  localToAero(_hb.subVectors(v0, u0).applyQuaternion(_hq), _b);
  _a.x /= HIT_AXES[0]; _a.y /= HIT_AXES[1]; _a.z /= HIT_AXES[2];
  _b.x /= HIT_AXES[0]; _b.y /= HIT_AXES[1]; _b.z /= HIT_AXES[2];
  const bb = _b.lengthSq();
  const t = bb > 1e-9 ? clamp(-_a.dot(_b) / bb, 0, dt) : 0;
  return _a.addScaledVector(_b, t).lengthSq() < 1;
}

export class Weapons {
  constructor(scene, effects, audio) {
    this.scene = scene;
    this.fx = effects;
    this.audio = audio;
    this.bullets = [];
    this.missiles = [];
    this.flares = [];
    this.chaff = [];
    this.MAXB = 900;
    // 예광탄: 카메라를 바라보는 테이퍼 리본 (앞이 밝고 굵고, 뒤로 가늘어짐)
    const g = new THREE.BufferGeometry();
    const V = this.MAXB * 6;
    this.tracerPos = new Float32Array(V * 3);
    this.tracerHead = new Float32Array(V * 3);
    this.tracerTail = new Float32Array(V * 3);
    this.tracerCol = new Float32Array(V * 3);
    this.tracerSide = new Float32Array(V);
    this.tracerWidth = new Float32Array(V);
    const dyn = (arr, size) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', dyn(this.tracerPos, 3));
    g.setAttribute('aHead', dyn(this.tracerHead, 3));
    g.setAttribute('aTail', dyn(this.tracerTail, 3));
    g.setAttribute('aColor', dyn(this.tracerCol, 3));
    g.setAttribute('aSide', dyn(this.tracerSide, 1));
    g.setAttribute('aWidth', dyn(this.tracerWidth, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const tracerMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aHead; attribute vec3 aTail; attribute vec3 aColor;
        attribute float aSide; attribute float aWidth;
        varying vec3 vColor;
        void main(){
          vColor = aColor;
          vec4 mv = viewMatrix * vec4(position, 1.0);
          vec4 cH = projectionMatrix * viewMatrix * vec4(aHead, 1.0);
          vec4 cT = projectionMatrix * viewMatrix * vec4(aTail, 1.0);
          vec2 dh = cH.xy / max(cH.w, 1e-4) - cT.xy / max(cT.w, 1e-4);
          vec2 dir = length(dh) > 1e-6 ? normalize(dh) : vec2(1.0, 0.0);
          vec2 perp = vec2(-dir.y, dir.x);
          // 세계공간 반폭(m) → NDC. 카메라 근처·뒤 정점의 폭 폭주를 막기 위해 상·하한을 둔다.
          float wNdc = aWidth * projectionMatrix[1][1] / max(-mv.z, 1.0);
          float w = clamp(wNdc, 0.002, 0.008);   // 720p에서 약 1.4~5.8 px
          vec4 clip = projectionMatrix * mv;
          clip.xy += perp * aSide * w * clip.w;
          gl_Position = clip;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <logdepthbuf_pars_fragment>
        varying vec3 vColor;
        void main(){
          gl_FragColor = vec4(vColor, 1.0);
          #include <logdepthbuf_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, fog: false,
    });
    this.tracers = new THREE.Mesh(g, tracerMat);
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 5;
    scene.add(this.tracers);
    this.missileMats = {
      missile: new THREE.MeshStandardMaterial({ color: 0xdedfdc, roughness: 0.5, metalness: 0.2 }),
      seeker: new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.1, metalness: 0.6 }),
      band: new THREE.MeshStandardMaterial({ color: 0xd6b23a, roughness: 0.5 }),
    };
    this.plumeTex = glowTexture('rgba(255,230,180,1)', 'rgba(255,120,30,0)');
  }

  // ------------------------------------------------------------- 기관포
  /** 매 프레임 호출. trigger: 방아쇠 상태 */
  updateGun(ac, trigger, dt) {
    ac.gunSpin = clamp(ac.gunSpin + (trigger && ac.fm.ammo > 0 && !ac.fm.destroyed ? dt / GUN.spinUp : -dt / 0.6), 0, 1);
    ac.gunFiring = trigger && ac.gunSpin > 0.05 && ac.fm.ammo > 0 && !ac.fm.destroyed;
    if (!ac.gunFiring) { ac.gunAcc = 0; return; }
    ac.gunAcc = (ac.gunAcc || 0) + GUN.rate * ac.gunSpin * dt;
    const fm = ac.fm;
    while (ac.gunAcc >= 1 && fm.ammo > 0) {
      ac.gunAcc -= 1;
      fm.ammo--;
      if (this.bullets.length >= this.MAXB) this.bullets.shift();
      const muzzle = aeroToLocal(_a.set(...GUN.offset), new THREE.Vector3()).applyQuaternion(fm.quat).add(fm.pos);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(fm.quat);
      dir.x += (Math.random() - 0.5) * 2 * GUN.disp; dir.y += (Math.random() - 0.5) * 2 * GUN.disp; dir.z += (Math.random() - 0.5) * 2 * GUN.disp;
      dir.normalize();
      const vel = dir.multiplyScalar(GUN.muzzle).add(fm.vel);
      // 프레임 내 발사 시점 분산 (연속적인 탄 흐름)
      const frac = Math.random() * dt;
      muzzle.addScaledVector(vel, frac);
      this.bullets.push({ p: muzzle, v: vel, life: GUN.life, owner: ac, tracer: (fm.ammo % 3) === 0 });
    }
  }

  // ------------------------------------------------------------- 미사일
  launch(shooter, type, target) {
    const spec = MISSILES[type];
    const fm = shooter.fm;
    const mesh = makeMissileMesh(type === 'AIM-120C' || type === 'R-77' ? 'AIM-120' : 'AIM-9', this.missileMats);
    const plume = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.plumeTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    plume.scale.setScalar(3);
    plume.position.z = mesh.userData.length * 0.5 + 0.6;
    mesh.add(plume);
    // 발사 위치: 장착 스테이션 근사
    const station = shooter.nextStation ? shooter.nextStation(type) : [0, 0, 1];
    const pos = aeroToLocal(_a.set(...station), new THREE.Vector3()).applyQuaternion(fm.quat).add(fm.pos);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(fm.quat);
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(fm.quat);
    const vel = fm.vel.clone().addScaledVector(spec.eject > 0 ? down : fwd, spec.eject > 0 ? 7 : 4);
    mesh.position.copy(pos);
    mesh.quaternion.copy(fm.quat);
    this.scene.add(mesh);
    const m = {
      spec, type, mesh, plume, pos, vel, prev: pos.clone(), t: 0, mass: spec.mass0, owner: shooter, target,
      alive: true, lostT: 0, lastKnown: target ? target.fm.pos.clone() : null, trailAcc: 0, motorOn: false,
    };
    this.missiles.push(m);
    this.audio?.missileLaunch(pos);
    // 발사한 미사일 표식(경보용)
    return m;
  }

  /** 플레어 + 채프 살포 (1회: 플레어 2발, 채프 1묶음) */
  dispense(ac) {
    if (ac.flares <= 0 && ac.chaff <= 0) return;
    const fm = ac.fm;
    for (let i = 0; i < 2 && ac.flares > 0; i++) {
      ac.flares--;
      const side = i === 0 ? -1 : 1;
      const dirLocal = aeroToLocal(_a.set(-0.3, side * 0.6, 0.8), new THREE.Vector3()).applyQuaternion(fm.quat).normalize();
      const f = { p: fm.pos.clone().addScaledVector(dirLocal, 3), v: fm.vel.clone().addScaledVector(dirLocal, 30), life: 4.5, owner: ac };
      this.flares.push(f);
      // 열 추적 미사일 기만
      for (const m of this.missiles) {
        if (!m.alive || m.spec.seeker !== 'IR' || m.target !== ac) continue;
        const r = m.pos.distanceTo(fm.pos);
        if (r > 9000) continue;
        // 미사일 시선 기준 표적-플레어 각 (근접할수록 효과 큼)
        let p = (1 - m.spec.flareResist) * (r < 1500 ? 1.4 : 1.0);
        if (ac.fm.engines.some(e => e.ab > 0.1)) p *= 0.6;  // 애프터버너 사용 시 효과 감소
        if (Math.random() < p) m.target = f;
      }
    }
    if (ac.chaff > 0) {
      ac.chaff--;
      const c = { p: fm.pos.clone(), v: fm.vel.clone().multiplyScalar(0.1), life: 3 };
      this.chaff.push(c);
      for (const m of this.missiles) {
        if (!m.alive || m.spec.seeker !== 'RADAR' || m.target !== ac) continue;
        const r = m.pos.distanceTo(fm.pos);
        if (r > 25000) continue;
        // 빔 기동(노칭) 시 채프 효과 증가
        _R.subVectors(fm.pos, m.pos).normalize();
        const beam = 1 - Math.abs(_R.dot(_b.copy(fm.vel).normalize()));
        let p = (1 - m.spec.chaffResist) + (beam > 0.85 ? 0.35 : 0);
        if (Math.random() < p) m.target = c;
      }
    }
    this.audio?.flare();
  }

  /** 주어진 항공기를 노리는 미사일 목록 (미사일 경보 체계) */
  threatsTo(ac) {
    return this.missiles.filter(m => m.alive && m.target === ac && m.motorOn !== null && m.pos.distanceTo(ac.fm.pos) < 15000);
  }

  // ------------------------------------------------------------- 갱신
  update(dt, aircraft, world) {
    this._updateBullets(dt, aircraft, world);
    this._updateMissiles(dt, aircraft, world);
    this._updateDecoys(dt);
  }

  _updateBullets(dt, aircraft, world) {
    const rhoSL = 1.225;
    let n = 0;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      const rho = isa(b.p.y).rho;
      const sp = b.v.length();
      const k = GUN.k * (rho / rhoSL) * sp;
      _d.copy(b.p);
      b.v.multiplyScalar(Math.max(0, 1 - k * dt));
      b.v.y -= G0 * dt;
      b.p.addScaledVector(b.v, dt);
      let hit = false;
      for (const ac of aircraft) {
        if (ac === b.owner || !ac.alive) continue;
        // 상대 운동 최근접 판정 (프레임 시작 위치 기준)
        const ca = closestApproach(_d, b.v, ac.prevPos, ac.fm.vel, dt);
        if (ca.d < 10 && _d.distanceTo(ac.prevPos) < 1500 && hitsAirframe(_d, b.v, ac.prevPos, ac.fm.vel, ac.fm.quat, dt)) {
          if (Math.random() < 0.6) {
            hit = true;
            ac.hitBy(b.owner, 4 + Math.random() * 5, 'gun');
            const hp = ac.fm.pos.clone().add(_c.multiplyScalar(0.4));
            this.fx.sparks(hp, 6);
            this.fx.fire.spawn(hp.x, hp.y, hp.z, ac.fm.vel.x, ac.fm.vel.y, ac.fm.vel.z, 0.25, 2.5, 4, 1, 0.8, 0.4, 1, 0.5);
            this.audio?.hit(hp);
          }
          break;
        }
      }
      if (hit || b.life <= 0) { this.bullets.splice(i, 1); continue; }
      if (b.p.y < 3000 && b.p.y < world.heightAt(b.p.x, b.p.z)) {
        if (Math.random() < 0.3) this.fx.smoke.spawn(b.p.x, b.p.y + 1, b.p.z, 0, 6, 0, 1.5, 2, 6, 0.45, 0.4, 0.33, 0.6, 1, -1);
        this.bullets.splice(i, 1);
        continue;
      }
      if (n < this.MAXB) {
        const len = b.tracer ? 18 : 9;
        const inv = len / Math.max(1, b.v.length());
        const red = b.owner.side === 'red';
        const br = b.tracer ? 1 : 0.35;
        // 앞끝은 주황~노랑 HDR 1.15(블룸 살짝), 뒤끝은 어둡고 가늘게
        this._writeTracer(n,
          b.p.x, b.p.y, b.p.z,
          b.p.x - b.v.x * inv, b.p.y - b.v.y * inv, b.p.z - b.v.z * inv,
          1.15 * br, (red ? 0.32 : 0.5) * br, (red ? 0.05 : 0.09) * br,
          0.25 * br, 0.06 * br, 0.01 * br);
        n++;
      }
    }
    this.tracers.geometry.setDrawRange(0, n * 6);
    const a = this.tracers.geometry.attributes;
    a.position.needsUpdate = a.aHead.needsUpdate = a.aTail.needsUpdate = true;
    a.aColor.needsUpdate = a.aSide.needsUpdate = a.aWidth.needsUpdate = true;
  }

  /** 예광탄 리본 6꼭짓점 기록 (판정 로직에는 영향 없음) */
  _writeTracer(n, hx, hy, hz, tx, ty, tz, hr, hg, hb, tr, tg, tb) {
    const P = this.tracerPos, H = this.tracerHead, T = this.tracerTail;
    const C = this.tracerCol, S = this.tracerSide, W = this.tracerWidth;
    for (let j = 0; j < 6; j++) {
      const L = TRACER_LAYOUT[j], i3 = n * 18 + j * 3, i = n * 6 + j;
      const x = L[0] ? tx : hx, y = L[0] ? ty : hy, z = L[0] ? tz : hz;
      P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
      H[i3] = hx; H[i3 + 1] = hy; H[i3 + 2] = hz;
      T[i3] = tx; T[i3 + 1] = ty; T[i3 + 2] = tz;
      C[i3] = L[0] ? tr : hr; C[i3 + 1] = L[0] ? tg : hg; C[i3 + 2] = L[0] ? tb : hb;
      S[i] = L[1]; W[i] = L[2];
    }
  }

  _updateMissiles(dt, aircraft, world) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (!m.alive) { this.scene.remove(m.mesh); this.missiles.splice(i, 1); continue; }
      const sub = 4, h = dt / sub;
      for (let k = 0; k < sub && m.alive; k++) this._stepMissile(m, h, world, (k + 1) / sub);
      // 시각화
      m.mesh.position.copy(m.pos);
      if (m.vel.lengthSq() > 1) m.mesh.quaternion.setFromUnitVectors(_a.set(0, 0, -1), _b.copy(m.vel).normalize());
      m.plume.visible = m.motorOn;
      m.plume.scale.setScalar(2.5 + Math.random() * 1.2);
      // 연기 궤적: 모터 연소 중에만 방출. 간격보다 초기 지름이 커 틈 없는 연속 리본이 된다.
      if (m.motorOn) {
        const smoke = m.spec.smoke;
        const low = smoke < 0.6;   // AIM-120/R-77 는 저연기
        const step = low ? TRAIL_FX.lowStep : TRAIL_FX.step;
        const dist = m.pos.distanceTo(m.prev);
        m.trailAcc += dist;
        while (m.trailAcc > step) {
          m.trailAcc -= step;
          const t = m.trailAcc / Math.max(dist, 1e-3);
          const px = m.pos.x + (m.prev.x - m.pos.x) * t;
          const py = m.pos.y + (m.prev.y - m.pos.y) * t;
          const pz = m.pos.z + (m.prev.z - m.pos.z) * t;
          const g = 0.94 + Math.random() * 0.05;   // 태양광을 받은 밝은 흰 연기
          const life = low ? TRAIL_FX.lowLife * (0.8 + Math.random() * 0.4)
                           : TRAIL_FX.life * (0.7 + Math.random() * 0.5);
          this.fx.wsmoke.spawn(px, py, pz,
            (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2 + 0.4, (Math.random() - 0.5) * 2,
            life, low ? 2.5 : TRAIL_FX.size0,
            low ? TRAIL_FX.lowSize1 : TRAIL_FX.size1 * (0.85 + Math.random() * 0.3),
            g, g, g * 0.98, 0.8 * smoke, 0.3, 0.15,
            g, g, g * 0.96, Math.random() * 6.2832, (Math.random() - 0.5) * 0.5,
            1.05, 0.7 + Math.random() * 0.7);
        }
        // 노즐 바로 뒤 화염 코어(HDR 1.1) + 짧은 불꽃
        const noz = (m.mesh.userData.length || 3) * 0.5 + 0.6;
        _d.set(0, 0, noz).applyQuaternion(m.mesh.quaternion).add(m.pos);
        this.fx.fire.spawn(_d.x, _d.y, _d.z, m.vel.x * 0.04, m.vel.y * 0.04, m.vel.z * 0.04,
          0.1, low ? 4.2 : 3.4, 0.9, 1.1, 0.94, 0.62, low ? 0.85 : 0.7, 0, 0, 1.06, 0.4, 0.1);
        if (!low || Math.random() < 0.5) {
          this.fx.fire.spawn(_d.x, _d.y, _d.z, m.vel.x * 0.02, m.vel.y * 0.02, m.vel.z * 0.02,
            0.06, 1.8, 0.4, 1.1, 0.72, 0.25, 0.5, 0, 0, 1.02, 0.3, 0.08);
        }
      }
      m.prev.copy(m.pos);
    }
  }

  _stepMissile(m, h, world, frac = 1) {
    const s = m.spec;
    m.t += h;
    const sp = m.vel.length();
    const atm = isa(m.pos.y);
    const Mach = sp / atm.a;
    const q = 0.5 * atm.rho * sp * sp;
    const A = Math.PI * s.dia * s.dia / 4;
    const tIgn = s.eject;
    m.motorOn = m.t >= tIgn && m.t < tIgn + s.burn;
    const thrust = m.motorOn ? s.thrust : 0;
    if (m.motorOn) m.mass = Math.max(s.mass1, m.mass - ((s.mass0 - s.mass1) / s.burn) * h);
    _W.copy(m.vel).normalize();
    // ---- 유도 (비례항법)
    _acc.set(0, 0, 0);
    let tgtPos = null, tgtVel = null;
    const tgt = m.target;
    if (tgt && m.t > tIgn + 0.15) {
      // 항공기 표적: 프레임 내 위치 보간 (미사일 서브스텝과 시간 정합)
      if (tgt.fm) { tgtPos = _tp.copy(tgt.prevPos).lerp(tgt.fm.pos, frac); tgtVel = tgt.fm.vel; if (!tgt.alive && !tgt.fm.destroyed) { m.target = null; } }
      else { tgtPos = tgt.p; tgtVel = tgt.v; if (tgt.life <= 0) m.target = null; }
      if (tgtPos) {
        _R.subVectors(tgtPos, m.pos);
        const range = _R.length();
        // 탐색기 짐벌 한계
        if (_W.dot(_c.copy(_R).normalize()) < Math.cos(s.gimbal)) { m.target = null; }
        // 중거리 미사일: 피트불 이전에는 발사기의 레이더 지원 필요
        else if (s.seeker === 'RADAR' && tgt.fm && range > s.pitbull && m.owner.lock !== tgt) {
          m.lostT += h;
          if (m.lostT > 3) m.target = null;
        } else {
          m.lostT = 0;
          _Vr.subVectors(tgtVel, m.vel);
          const vc = -_R.dot(_Vr) / range;
          const omega = _c.crossVectors(_R, _Vr).divideScalar(range * range);
          _acc.crossVectors(omega, _d.copy(_R).divideScalar(range)).multiplyScalar(s.N * Math.max(vc, 150));
          // 중력 보상 + 원거리 로프트
          _acc.y += G0;
          if (s.seeker === 'RADAR' && range > 18000 && m.t < 12) _acc.y += G0 * 3 * clamp((range - 18000) / 20000, 0, 1);
          // 근접신관: 신관 반경 안에서 최근접점(PCA)을 지나는 순간 기폭 → 실제 빗나감 거리로 피해 산정
          if (m.t > s.arm && range < s.prox + 60) {
            const ca = closestApproach(m.pos, m.vel, tgtPos, tgtVel, h);
            if (ca.d < s.prox && (ca.t < h - 1e-6 || ca.d < 1.0)) {
              m.pos.addScaledVector(m.vel, ca.t);
              this._detonate(m, tgt, ca.d);
              return;
            }
          }
        }
      }
    }
    // 측방 가속만 (속도 방향 성분 제거) + 동압에 따른 최대 G
    _acc.addScaledVector(_W, -_acc.dot(_W));
    const maxA = Math.min(s.maxG * G0, (q * A * 25) / m.mass);
    const al = _acc.length();
    if (al > maxA) _acc.multiplyScalar(maxA / al);
    const lift = _acc.length() * m.mass;
    const cd = s.cd0 * interp(CD_MACH, Mach) + (m.motorOn ? 0 : 0.08);
    const drag = q * A * cd + (q > 10 ? (lift * lift) / (q * A * 50) : 0);
    const along = (thrust - drag) / m.mass;
    m.vel.addScaledVector(_W, along * h).addScaledVector(_acc, h);
    m.vel.y -= G0 * h;
    m.pos.addScaledVector(m.vel, h);
    // 종료 조건
    const gh = world.heightAt(m.pos.x, m.pos.z);
    if (m.pos.y < gh) { m.pos.y = gh + 1; this._detonate(m, null, 1e9, true); return; }
    if (m.t > s.maxTime || (m.t > tIgn + s.burn + 3 && sp < 230)) { this._detonate(m, null, 1e9); }
  }

  _detonate(m, tgt, dist, ground = false) {
    m.alive = false;
    const s = m.spec;
    this.fx.burst(m.pos, ground ? null : m.vel.clone().multiplyScalar(0.2), 0.45);
    if (ground) this.fx.groundImpact(m.pos, 0.4);
    this.audio?.explosion(m.pos, 0.6);
    if (tgt && tgt.fm) {
      // 파편 탄두 치사 확률 근사: 치명 반경 내 격추, 바깥은 거리에 따라 감소 + 난수
      const k = clamp((dist - s.lethal) / (s.prox - s.lethal), 0, 1);
      let dmg = dist < s.lethal ? 130 : (100 - 65 * k) * (0.75 + Math.random() * 0.5);
      tgt.hitBy(m.owner, dmg, 'missile');
    }
  }

  _updateDecoys(dt) {
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.life -= dt;
      f.v.multiplyScalar(Math.exp(-1.6 * dt));
      f.v.y -= G0 * dt * 0.6;
      f.p.addScaledVector(f.v, dt);
      if (f.life <= 0) { this.flares.splice(i, 1); continue; }
      const k = f.life / 4.5;
      this.fx.fire.spawn(f.p.x, f.p.y, f.p.z, 0, 0, 0, 0.12, 6 * k + 2, 3, 1, 0.95, 0.8, 1, 0, 0);
      this.fx.smoke.spawn(f.p.x, f.p.y, f.p.z, 0, 1, 0, 2.5, 1.5, 6, 0.9, 0.9, 0.9, 0.35, 0.3, 0.3);
    }
    for (let i = this.chaff.length - 1; i >= 0; i--) {
      const c = this.chaff[i];
      c.life -= dt;
      c.p.addScaledVector(c.v, dt);
      if (c.life <= 0) this.chaff.splice(i, 1);
    }
  }

  clear() {
    for (const m of this.missiles) this.scene.remove(m.mesh);
    this.missiles.length = 0; this.bullets.length = 0; this.flares.length = 0; this.chaff.length = 0;
    this.tracers.geometry.setDrawRange(0, 0);
  }
}

/**
 * 기관포 리드 계산 (탄도 해석해): 탄은 총구에서 '총구속도×기수방향 + 기체속도'로 나가 방향은 유지한 채
 * 이차 항력(dv/dt = -c·v²)으로 감속하고 중력으로 낙하한다. 비행거리 s(t) = ln(1 + c·v0·t)/c 를 이용해
 * 표적의 미래 위치(속도 + 선택적 가속도 예측)와 만나는 비행시간을 반복 계산하고, 그 탄도 방향을 내기 위한
 * 기수 방향(기체속도를 뺀 방향)을 돌려준다. 항력이 기체속도 성분까지 줄이는 효과를 포함해 원거리에서도 정확.
 */
export function gunLead(shooter, target, out, tAcc = null, predict = 0) {
  const fm = shooter.fm, t = target.fm;
  const c = GUN.k * (isa(fm.pos.y).rho / 1.225);
  const muzzle = aeroToLocal(_W.set(...GUN.offset), _c).applyQuaternion(fm.quat).add(fm.pos);
  const u = _R.subVectors(t.pos, muzzle).normalize();
  const M = GUN.muzzle, V2 = fm.vel.lengthSq();
  let tof = 0.5, v0 = M;
  for (let i = 0; i < 5; i++) {
    const ud = u.dot(fm.vel);
    v0 = ud + Math.sqrt(Math.max(1, ud * ud - V2 + M * M));    // |v0·u - 기체속도| = 총구속도
    _tp.copy(t.pos).addScaledVector(t.vel, tof);
    if (tAcc && predict) _tp.addScaledVector(tAcc, 0.5 * tof * tof * predict);
    _tp.y += 0.5 * G0 * tof * tof;                               // 중력 낙하 보상
    _Vr.subVectors(_tp, muzzle);
    const D = _Vr.length();
    u.copy(_Vr).divideScalar(Math.max(D, 1));
    tof = (Math.exp(Math.min(c * D, 20)) - 1) / (c * v0);
  }
  out.copy(u).multiplyScalar(v0).sub(fm.vel).normalize();
  return { dir: out, tof, range: t.pos.distanceTo(fm.pos) };
}
export { GUN };
