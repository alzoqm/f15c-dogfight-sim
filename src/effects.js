// 파티클 효과: 다단계 폭발(섬광→불덩이→연기 기둥), 파편 꼬리, 충격파 링,
// 피격 스파크, 흙먼지·물보라, 베이퍼 콘. 모든 텍스처는 절차적으로 생성한다.
import * as THREE from 'three';
import { clamp, lerp } from './math.js';

// ------------------------------------------------------------------ 목표 크기·지속 시간 상수
// size=1 기준 미터/초. 실제 값은 explosion(size) 배. 입자 개수가 아니라 이 목표값으로 맞춘다.
// 투영 검산: gl_PointSize = size * viewH/(2*tan(fov/2)) / dist → size는 세계공간 지름(m).
//   300 m, fov 40°에서 25 m 지름 = 25/(600*tan20°) = 화면 높이의 11.5% ≈ 화면 폭의 8%.
const FX = {
  FLASH_D: 5,          // 순간 섬광 지름
  FLASH_LIFE: 0.12,    // 섬광 및 점광원 지속
  SHOCK_D_END: 30,     // 충격파 링 최종 지름
  SHOCK_LIFE: 0.3,
  FIREBALL_D: 17,      // 불덩이 목표 지름 (size=1.5 → 25.5 m)
  FIREBALL_LIFE: 2.6,  // 불덩이(외곽) 지속
  SMOKE_D_START: 12,   // 연기 퍼프 초기 지름
  SMOKE_D_END: 45,     // 연기 구름 최종 지름 (size=1.5 → 67.5 m)
  SMOKE_LIFE: 25,      // 공중 격추 연기 지속
  SMOKE_FADE: 0.75,    // 연기 알파 감쇠 지수 (낮을수록 오래 진하게 남음)
  SMOKE_WIND: 0.25,    // 상층풍 적용 비율 (16초에 약 35 m 이동)
  TRAIL_INTERVAL: 0.045,// 파편 연기 방출 간격
  TRAIL_LIFE: 2.5,     // 꼬리 퍼프 지속 (1~3초에 옅어짐)
  TRAIL_D_END: 10,     // 꼬리 퍼프 최종 지름
  DUST_LIFE: 12,       // 흙먼지 지속
  SPRAY_LIFE: 3,       // 물보라 지속
};

// ------------------------------------------------------------------ 절차적 텍스처
const TEX = 128;

function textureFrom(draw) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = TEX;
  const c = cv.getContext('2d');
  draw(c, TEX);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

// 값 노이즈 (텍스처의 덩어리감과 가장자리 흐트러짐에 사용)
function hash2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

/** 부드러운 연기: 여러 노이즈 덩어리를 겹치고 가장자리를 페이드 */
function makeSmokeTexture() {
  return textureFrom((c, s) => {
    for (let i = 0; i < 22; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * s * 0.24;
      const x = s * 0.5 + Math.cos(ang) * rad;
      const y = s * 0.5 + Math.sin(ang) * rad;
      const r = s * (0.1 + Math.random() * 0.17);
      const a = 0.18 + Math.random() * 0.2;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.55, `rgba(255,255,255,${a * 0.45})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, s, s);
    }
    const img = c.getImageData(0, 0, s, s), d = img.data;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const dx = (x + 0.5) / s * 2 - 1, dy = (y + 0.5) / s * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      const edge = clamp((1 - r) / 0.32, 0, 1);
      const raw = 0.28 + 0.95 * noise2(x * 0.07, y * 0.07) + 0.34 * noise2(x * 0.27, y * 0.27);
      const n = clamp((raw - 0.5) * 1.8, 0.14, 1.25);
      d[i + 3] = clamp(d[i + 3] * edge * n, 0, 255);
    }
    c.putImageData(img, 0, 0);
  });
}

/** 불꽃: 밝은 중심 + 노이즈로 흐트러진 가장자리 */
function makeFlameTexture() {
  return textureFrom((c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.24, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, s, s);
    const img = c.getImageData(0, 0, s, s), d = img.data;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n = 0.76 + 0.36 * noise2(x * 0.13, y * 0.13) + 0.16 * noise2(x * 0.42, y * 0.42);
      d[i + 3] = d[i + 3] * n;
    }
    c.putImageData(img, 0, 0);
  });
}

/** 스파크 줄무늬: 수평으로 길고 양끝이 페이드되는 밝은 선 */
function makeStreakTexture() {
  return textureFrom((c, s) => {
    c.save();
    c.translate(s / 2, s / 2);
    c.scale(4.6, 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, s * 0.24);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.72)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, s * 0.24, 0, Math.PI * 2); c.fill();
    c.restore();
    const img = c.getImageData(0, 0, s, s), d = img.data;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const edge = clamp((1 - Math.abs((y + 0.5) / s * 2 - 1)) / 0.35, 0, 1);
      d[i + 3] = d[i + 3] * (0.8 + 0.2 * noise2(x * 0.2, y * 0.2)) * edge;
    }
    c.putImageData(img, 0, 0);
  });
}

/** 충격파 링: 안쪽이 비고 바깥쪽 테두리가 흐릿하게 번지는 고리 */
function makeRingTexture() {
  return textureFrom((c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,0)');
    g.addColorStop(0.58, 'rgba(255,255,255,0)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.79, 'rgba(255,255,255,1)');
    g.addColorStop(0.88, 'rgba(255,255,255,0.3)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, s, s);
    const img = c.getImageData(0, 0, s, s), d = img.data;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const a = Math.atan2(y - s / 2, x - s / 2);
      const n = 0.72 + 0.4 * noise2(a * 9 + 30, 5) + 0.16 * noise2(a * 23, 11);
      d[i + 3] = d[i + 3] * n;
    }
    c.putImageData(img, 0, 0);
  });
}

// ------------------------------------------------------------------ 파티클 시스템
/** GPU 포인트 스프라이트 기반 파티클 시스템 (버퍼·풀 방식, 시스템당 단일 드로우콜) */
export class ParticleSystem {
  constructor(scene, max, { additive = false, texture, alignVel = false, sunLit = !additive } = {}) {
    this.max = max;
    this.count = 0;
    this.alignVel = alignVel;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.arot = new Float32Array(max);
    this.avel = new Float32Array(max * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('arot', new THREE.BufferAttribute(this.arot, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('avel', new THREE.BufferAttribute(this.avel, 3).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          map: { value: texture }, scale: { value: 500 },
          uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
          uSunLit: { value: sunLit ? 1 : 0 },
          uAlign: { value: alignVel ? 1 : 0 },
        },
      ]),
      vertexShader: /* glsl */`
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        attribute float size; attribute vec4 pcolor; attribute float arot; attribute vec3 avel;
        varying vec4 vColor; varying float vRot; varying vec3 vSun;
        uniform float scale; uniform vec3 uSunDir; uniform float uAlign;
        void main(){
          vColor = pcolor;
          vSun = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          float rot = arot;
          if (uAlign > 0.5 && dot(avel, avel) > 1.0e-6) {
            vec3 vv = (viewMatrix * vec4(avel, 0.0)).xyz;
            rot = atan(vv.y, vv.x);
          }
          vRot = rot;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = min(size * scale / max(-mvPosition.z, 0.1), 2048.0);
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D map; uniform float uSunLit;
        varying vec4 vColor; varying float vRot; varying vec3 vSun;
        void main(){
          vec2 q = gl_PointCoord - 0.5;
          float cs = cos(vRot), sn = sin(vRot);
          vec2 uv = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y) + 0.5;
          vec4 t = texture2D(map, uv);
          float a = vColor.a * t.a;
          if (a < 0.004) discard;
          vec3 rgb = vColor.rgb * t.rgb;
          if (uSunLit > 0.5) {
            vec2 d = gl_PointCoord * 2.0 - 1.0;
            float r2 = dot(d, d);
            vec3 n = normalize(vec3(d.x, -d.y, sqrt(max(0.0, 1.0 - r2)) + 0.001));
            // 태양 쪽 밝은 회색, 반대쪽 어두운 회갈색 (연기는 HDR 1 이하 유지)
            rgb = min(rgb * (0.45 + 0.8 * max(dot(n, normalize(vSun)), 0.0)), vec3(0.95));
          }
          gl_FragColor = vec4(rgb, a);
          #include <logdepthbuf_fragment>
          #include <fog_fragment>
        }`,
      transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 5 : 4;
    this.wind = new THREE.Vector3();   // 연기를 바람으로 흘려보내는 속도 (Effects가 설정)
    scene.add(this.points);
    // 파티클 상태 (구조체 배열)
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3); this.c1 = new Float32Array(max * 3);
    this.a0 = new Float32Array(max); this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.rot = new Float32Array(max); this.rotv = new Float32Array(max); this.fade = new Float32Array(max);
    this.wfac = new Float32Array(max);   // 퍼프별 바람 계수 (구름 늘어짐)
  }

  spawn(px, py, pz, vx, vy, vz, life, s0, s1, r, g, b, a, drag = 0.5, grav = 0,
        r1 = r, g1 = g, b1 = b, rot0 = Math.random() * 6.2832,
        rotv0 = (Math.random() - 0.5) * 0.9, fadeExp = 2, wfac = 1) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.p[i * 3] = px; this.p[i * 3 + 1] = py; this.p[i * 3 + 2] = pz;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.life[i] = 0; this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.c0[i * 3] = r; this.c0[i * 3 + 1] = g; this.c0[i * 3 + 2] = b;
    this.c1[i * 3] = r1; this.c1[i * 3 + 1] = g1; this.c1[i * 3 + 2] = b1;
    this.a0[i] = a; this.drag[i] = drag; this.grav[i] = grav;
    this.rot[i] = rot0; this.rotv[i] = rotv0; this.fade[i] = fadeExp;
    this.wfac[i] = wfac;
  }

  _copy(dst, src) {
    const c3 = (arr) => {
      arr[dst * 3] = arr[src * 3];
      arr[dst * 3 + 1] = arr[src * 3 + 1];
      arr[dst * 3 + 2] = arr[src * 3 + 2];
    };
    c3(this.p); c3(this.v); c3(this.c0); c3(this.c1);
    this.life[dst] = this.life[src]; this.maxLife[dst] = this.maxLife[src];
    this.s0[dst] = this.s0[src]; this.s1[dst] = this.s1[src];
    this.a0[dst] = this.a0[src]; this.drag[dst] = this.drag[src]; this.grav[dst] = this.grav[src];
    this.rot[dst] = this.rot[src]; this.rotv[dst] = this.rotv[src]; this.fade[dst] = this.fade[src];
    this.wfac[dst] = this.wfac[src];
  }

  update(dt, viewHeight, fovRad) {
    this.mat.uniforms.scale.value = viewHeight / (2 * Math.tan(fovRad / 2));
    let i = 0;
    while (i < this.count) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        this.count--;
        if (i !== this.count) this._copy(i, this.count);
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= k;
      this.v[i * 3 + 1] = this.v[i * 3 + 1] * k + this.grav[i] * dt;
      this.v[i * 3 + 2] *= k;
      const wf = this.wfac[i];
      this.p[i * 3] += (this.v[i * 3] + this.wind.x * wf) * dt;
      this.p[i * 3 + 1] += (this.v[i * 3 + 1] + this.wind.y * wf) * dt;
      this.p[i * 3 + 2] += (this.v[i * 3 + 2] + this.wind.z * wf) * dt;
      this.rot[i] += this.rotv[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.pos[i * 3] = this.p[i * 3];
      this.pos[i * 3 + 1] = this.p[i * 3 + 1];
      this.pos[i * 3 + 2] = this.p[i * 3 + 2];
      this.size[i] = lerp(this.s0[i], this.s1[i], Math.sqrt(t));
      this.col[i * 4] = lerp(this.c0[i * 3], this.c1[i * 3], t);
      this.col[i * 4 + 1] = lerp(this.c0[i * 3 + 1], this.c1[i * 3 + 1], t);
      this.col[i * 4 + 2] = lerp(this.c0[i * 3 + 2], this.c1[i * 3 + 2], t);
      const fadeIn = clamp(t * 30, 0, 1);
      const rest = 1 - t;
      this.col[i * 4 + 3] = this.a0[i] * fadeIn *
        (this.fade[i] === 2 ? rest * rest : Math.pow(rest, this.fade[i]));
      this.arot[i] = this.rot[i];
      if (this.alignVel) {
        this.avel[i * 3] = this.v[i * 3];
        this.avel[i * 3 + 1] = this.v[i * 3 + 1];
        this.avel[i * 3 + 2] = this.v[i * 3 + 2];
      }
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    const a = this.geo.attributes;
    a.position.needsUpdate = a.pcolor.needsUpdate = a.size.needsUpdate = a.arot.needsUpdate = true;
    if (this.alignVel) a.avel.needsUpdate = true;
  }
}

const _v = new THREE.Vector3();

// ------------------------------------------------------------------ 종합 이펙트
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.world = null;
    this.time = 0;
    this.frameSmooth = 1 / 60;
    this.detail = 1;
    this.pending = [];
    this.smoke = new ParticleSystem(scene, 9000, { texture: makeSmokeTexture() });
    // 미사일 연기 전용: 어두운 음영 없이 밝은 흰색으로 유지
    this.wsmoke = new ParticleSystem(scene, 12000, { texture: makeFlameTexture(), sunLit: false });
    this.fire = new ParticleSystem(scene, 5000, { additive: true, texture: makeFlameTexture() });
    this.streaks = new ParticleSystem(scene, 1200, { additive: true, texture: makeStreakTexture(), alignVel: true });

    // 충격파 링 풀 (스프라이트라 카메라가 없어도 자동으로 정면을 본다)
    this.shockTex = makeRingTexture();
    this.shockPool = [];
    this.shocks = [];
    for (let i = 0; i < 20; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.shockTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0,
      }));
      s.visible = false; s.renderOrder = 7;
      scene.add(s); this.shockPool.push(s);
    }

    this.flashLight = new THREE.PointLight(0xffbb77, 0, 350, 2);
    scene.add(this.flashLight);
    this.flashT = 0;
    this.shake = 0;

    // 파편 풀 (런타임 메시 생성을 줄인다)
    this.debrisGeo = new THREE.BoxGeometry(1, 0.15, 0.8);
    this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.8, metalness: 0.4 });
    this.metalMat = new THREE.MeshStandardMaterial({ color: 0x9fa6ad, roughness: 0.35, metalness: 0.85 });
    this.debrisPool = [];
    this.debris = [];
  }

  /** 지연 실행 예약 (다단계 폭발용) */
  _schedule(delay, fn) {
    if (this.pending.length < 128) this.pending.push({ t: this.time + delay, fn });
  }

  _shockwave(pos, endD, color = 0xffe6b0, life = FX.SHOCK_LIFE) {
    const s = this.shockPool.pop();
    if (!s) return;
    s.visible = true;
    s.position.copy(pos);
    s.material.color.set(color);
    s.material.opacity = 0.55;
    const s0 = endD * 0.08;
    s.scale.setScalar(s0);
    this.shocks.push({ s, t: 0, life, s0, s1: endD });
  }

  /** 파편 생성 (금속 조각 + 연기 꼬리) */
  _spawnDebris(pos, vel, size, count, small = false) {
    for (let i = 0; i < count && this.debris.length < 160; i++) {
      let m = this.debrisPool.pop();
      if (!m) {
        m = new THREE.Mesh(this.debrisGeo, this.debrisMat);
        this.scene.add(m);
      }
      m.material = small ? this.metalMat : this.debrisMat;
      m.visible = true;
      m.position.copy(pos);
      if (small) {
        m.scale.set(0.06 + Math.random() * 0.12, 0.05 + Math.random() * 0.05, 0.06 + Math.random() * 0.14);
      } else {
        m.scale.set(0.5 + Math.random() * 1.6, 1, 0.4 + Math.random());
      }
      // 속도를 크게 흩어 일부는 짧게 끊기게 한다 (제곱 난수)
      const speed = small ? 14 + Math.random() * 34
        : (8 + Math.random() * Math.random() * 65) * clamp(size, 0.3, 2);
      const v = new THREE.Vector3().randomDirection().multiplyScalar(speed);
      if (vel) v.addScaledVector(vel, small ? 0.8 : 0.6);
      m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const life = small ? 0.5 + Math.random() * 0.7 : 8 + Math.random() * 6;
      this.debris.push({
        m, v, w: new THREE.Vector3().randomDirection().multiplyScalar(small ? 16 : 6),
        life, maxLife: life, trail: !small, emit: 0, trailT: 0,
        trailMax: 0.6 + Math.random() * 2,   // 꼬리 길이를 파편마다 다르게
      });
    }
  }

  /** 폭발: size 1 = 전투기. 섬광 → 불덩이 → 검은 연기 구름 */
  explosion(pos, vel, size = 1, debris = true) {
    const S = clamp(size, 0.2, 3);
    const D = this.detail;
    const P = pos.clone();   // 지연 발생 위치가 이후에 움직이지 않도록 고정
    const bx = vel ? vel.x * 0.3 : 0, by = vel ? vel.y * 0.3 : 0, bz = vel ? vel.z * 0.3 : 0;
    const FD = FX.FIREBALL_D * S;   // 목표 불덩이 지름 (m)
    const SD = FX.SMOKE_D_END * S;  // 목표 연기 구름 지름 (m)

    // 1단계: 짧고 작은 섬광 (HDR 1.08 정도로 블룸은 살짝)
    this.flashLight.position.copy(P);
    this.flashLight.intensity = 4e4 * S;
    this.flashT = FX.FLASH_LIFE;
    this.shake = Math.min(1, this.shake + 0.1 * S);
    const flashN = Math.max(4, Math.round(7 * S * D));
    for (let i = 0; i < flashN; i++) {
      _v.randomDirection().multiplyScalar((4 + Math.random() * 10) * S);
      this.fire.spawn(P.x, P.y, P.z, bx + _v.x, by + _v.y, bz + _v.z,
        FX.FLASH_LIFE * 0.5, FX.FLASH_D * S * 0.6, FX.FLASH_D * S,
        1.08, 1.05, 0.96, 0.5, 4, 0, 1.02, 0.7, 0.25);
    }
    this._shockwave(P, FX.SHOCK_D_END * S, 0xffe6b0, FX.SHOCK_LIFE);

    // 2단계: 불덩이. 목표 지름 FD를 3개 온도층이 공유한다 (1.5초에 약 FD).
    this._schedule(0.04, () => {
      const core = Math.max(6, Math.round(9 * S * D));
      for (let i = 0; i < core; i++) {
        _v.randomDirection().multiplyScalar(FD * 0.08);
        const cx = P.x + _v.x, cy = P.y + _v.y, cz = P.z + _v.z;
        _v.randomDirection().multiplyScalar((3 + Math.random() * 10) * S);
        this.fire.spawn(cx, cy, cz, bx + _v.x, by + _v.y, bz + _v.z,
          1.1, FD * 0.35, FD * 0.8, 1.12, 1.08, 0.92, 0.5, 1.8, 1.5,
          1.06, 0.85, 0.3, Math.random() * 6.2832, (Math.random() - 0.5) * 0.6, 1.3);
      }
      const mid = Math.max(8, Math.round(14 * S * D));
      for (let i = 0; i < mid; i++) {
        _v.randomDirection().multiplyScalar(FD * 0.12);
        const cx = P.x + _v.x, cy = P.y + _v.y, cz = P.z + _v.z;
        _v.randomDirection().multiplyScalar((2 + Math.random() * 10) * S);
        this.fire.spawn(cx, cy, cz, bx + _v.x, by + _v.y, bz + _v.z,
          2.0, FD * 0.5, FD * 1.05, 1.08, 0.72, 0.18, 0.42, 1.2, 2,
          1, 0.34, 0.05, Math.random() * 6.2832, (Math.random() - 0.5) * 0.6, 1.15);
      }
      const outer = Math.max(10, Math.round(18 * S * D));
      for (let i = 0; i < outer; i++) {
        _v.randomDirection().multiplyScalar(FD * 0.16);
        const cx = P.x + _v.x, cy = P.y + _v.y, cz = P.z + _v.z;
        _v.randomDirection().multiplyScalar((2 + Math.random() * 9) * S);
        this.fire.spawn(cx, cy, cz, bx + _v.x, by + _v.y, bz + _v.z,
          FX.FIREBALL_LIFE, FD * 0.6, FD * 1.2, 1, 0.4, 0.09, 0.36, 0.9, 2.5,
          0.62, 0.05, 0.02, Math.random() * 6.2832, (Math.random() - 0.5) * 0.5, 1);
      }
    });

    // 3단계: 목표 지름 SD의 진한 연기 구름. 퍼프 크기·위치·수명을 상수에서 계산.
    this._schedule(0.16, () => {
      const initial = Math.max(14, Math.round(30 * S * D));
      for (let i = 0; i < initial; i++) {
        _v.randomDirection().multiplyScalar(SD * 0.12);
        const cx = P.x + _v.x, cy = P.y + _v.y, cz = P.z + _v.z;
        _v.randomDirection().multiplyScalar((1 + Math.random() * 4) * S);
        const g = 0.36 + Math.random() * 0.14;
        const warm = i % 3 === 0;   // 불덩이 가까운 아래쪽은 주황빛으로 비침
        this.smoke.spawn(cx, cy, cz, bx + _v.x, by + _v.y + (warm ? 0.5 : 1.5) * S, bz + _v.z,
          FX.SMOKE_LIFE * (0.9 + Math.random() * 0.2),
          FX.SMOKE_D_START * S * (0.6 + Math.random() * 0.5), SD * (0.55 + Math.random() * 0.2),
          warm ? 0.52 : g * 1.12, warm ? 0.28 : g, warm ? 0.12 : g * 0.86, 0.36,
          0.45 + Math.random() * 0.6, 0.1 + Math.random() * 0.4,
          g * 0.95, g * 0.9, g * 0.8, Math.random() * 6.2832, (Math.random() - 0.5) * 0.7,
          FX.SMOKE_FADE, 0.7 + Math.random() * 0.5);
      }
      // 상승 기둥을 2초간 촘촘히 방출해 구름의 두께를 만든다.
      for (let k = 1; k <= 12; k++) {
        this._schedule(0.17 * k, () => {
          const cnt = Math.max(4, Math.round(10 * S * D));
          for (let i = 0; i < cnt; i++) {
            _v.randomDirection().multiplyScalar(SD * 0.1);
            const jx = _v.x, jy = _v.y, jz = _v.z;
            const g = 0.35 + Math.random() * 0.13;
            const cap = k > 7;   // 위쪽은 버섯처럼 넓게 퍼진다
            _v.randomDirection().multiplyScalar((1 + Math.random() * 5) * S);
            this.smoke.spawn(P.x + jx, P.y + (2 + k * 0.5) * S + jy, P.z + jz,
              bx + _v.x, by + (cap ? 2 + Math.random() * 3 : 1 + Math.random() * 3) * S, bz + _v.z,
              FX.SMOKE_LIFE, FX.SMOKE_D_START * S * 0.5,
              SD * (cap ? 0.52 + Math.random() * 0.12 : 0.4 + Math.random() * 0.18),
              g * 1.1, g * 0.98, g * 0.84, 0.34,
              0.4 + Math.random() * 0.6, 0.1 + Math.random() * 0.35,
              g * 0.92, g * 0.87, g * 0.78, Math.random() * 6.2832, (Math.random() - 0.5) * 0.7,
              FX.SMOKE_FADE, 0.7 + Math.random() * 0.6);
          }
        });
      }
    });

    // 4단계: 파편과 파편이 끄는 연기 꼬리
    if (debris) this._spawnDebris(P, vel, S, Math.max(3, Math.round(4 * S)));
  }

  /** 작은 폭발 (미사일 근접신관 / 피탄) */
  burst(pos, vel, size = 0.4) { this.explosion(pos, vel, size, false); }

  /** 피격 스파크: 밝은 불꽃 + 줄무늬 + 작은 연기 퍼프 + 금속 파편 */
  sparks(pos, n = 5) {
    const m = Math.max(1, Math.round(n));
    const D = this.detail;
    for (let i = 0; i < m; i++) {
      _v.randomDirection().multiplyScalar(18 + Math.random() * 45);
      this.streaks.spawn(pos.x, pos.y, pos.z, _v.x, _v.y, _v.z,
        0.18 + Math.random() * 0.22, 1.8, 0.5, 1.08, 1.02, 0.86, 0.85, 2.5, -14,
        1.02, 0.62, 0.2);
      if (i % 2 === 0) {
        this.fire.spawn(pos.x, pos.y, pos.z, _v.x * 0.5, _v.y * 0.5, _v.z * 0.5,
          0.12 + Math.random() * 0.15, 2, 0.5, 1.06, 0.8, 0.3, 0.5, 3, -10,
          1, 0.3, 0.05);
      }
    }
    const puffs = Math.max(1, Math.round(m * 0.5 * D));
    for (let i = 0; i < puffs; i++) {
      _v.randomDirection().multiplyScalar(2 + Math.random() * 6);
      this.smoke.spawn(pos.x, pos.y, pos.z, _v.x, _v.y, _v.z,
        1.2 + Math.random() * 0.8, 0.8, 3.5, 0.3, 0.29, 0.28, 0.45, 1.4, 1.2,
        0.26, 0.25, 0.24, Math.random() * 6.2832, (Math.random() - 0.5) * 1.2, 1.4);
    }
    const bits = Math.max(0, Math.round(m * 0.4 * D));
    if (bits) this._spawnDebris(pos, null, 0.3, Math.min(bits, 3), true);
  }

  /** 지면/수면 충돌: 흙먼지 기둥 또는 물보라 기둥 */
  groundImpact(pos, size = 1) {
    const S = clamp(size, 0.2, 3);
    const D = this.detail;
    const water = this.world && typeof this.world.isWater === 'function'
      ? this.world.isWater(pos.x, pos.z) : false;
    const cnt = Math.max(8, Math.round((water ? 55 : 46) * S * D));
    for (let i = 0; i < cnt; i++) {
      if (water) {
        _v.set((Math.random() - 0.5) * 30, 12 + Math.random() * 26, (Math.random() - 0.5) * 30).multiplyScalar(S);
        this.smoke.spawn(pos.x, pos.y + 1, pos.z, _v.x, _v.y, _v.z,
          FX.SPRAY_LIFE * (0.7 + Math.random() * 0.3), 2 * S, 12 * S, 0.72, 0.8, 0.88, 0.6, 1.3, -9,
          0.8, 0.86, 0.92, Math.random() * 6.2832, (Math.random() - 0.5) * 1.2, 1.4);
      } else {
        _v.set((Math.random() - 0.5) * 28, Math.random() * 22, (Math.random() - 0.5) * 28).multiplyScalar(S);
        this.smoke.spawn(pos.x, pos.y + 2, pos.z, _v.x, _v.y, _v.z,
          FX.DUST_LIFE * (0.7 + Math.random() * 0.3), 4 * S, 24 * S, 0.42, 0.37, 0.3, 0.5, 0.9, -1.2,
          0.5, 0.46, 0.4, Math.random() * 6.2832, (Math.random() - 0.5) * 0.7, 1.3);
      }
    }
    // 물보라의 반짝이는 물방울
    if (water) {
      const drops = Math.max(4, Math.round(18 * S * D));
      for (let i = 0; i < drops; i++) {
        _v.set((Math.random() - 0.5) * 30, 14 + Math.random() * 26, (Math.random() - 0.5) * 30).multiplyScalar(S);
        this.streaks.spawn(pos.x, pos.y + 1, pos.z, _v.x, _v.y, _v.z,
          0.3 + Math.random() * 0.4, 1.6, 0.5, 0.85, 0.94, 1, 0.8, 0.8, -18,
          0.9, 0.97, 1);
      }
    }
    this._shockwave(pos, FX.SHOCK_D_END * S * 0.7, water ? 0xbfe6ff : 0xd8b48a, 0.4);
  }

  update(dt, world, viewH, fov) {
    if (world) this.world = world;
    if (world && world.sunDir && world.sunDir.lengthSq() > 1e-6) {
      this.smoke.mat.uniforms.uSunDir.value.copy(world.sunDir);
    }
    // 상층풍으로 연기를 흘려보낸다 (world의 바람 값은 읽기만 함)
    this.smoke.wind.set(world && world.windX ? world.windX * FX.SMOKE_WIND : 0, 0,
      world && world.windZ ? world.windZ * FX.SMOKE_WIND : 0);
    this.wsmoke.wind.copy(this.smoke.wind);

    // 프레임 시간이 늘어나면 발생량을 줄여 중간 품질에서도 60fps를 지킨다
    if (dt > 0 && dt < 0.5) {
      this.frameSmooth += (dt - this.frameSmooth) * 0.05;
      this.detail = clamp(0.018 / this.frameSmooth, 0.45, 1);
    }
    if (dt > 0) {
      this.time += dt;
      let i = 0;
      while (i < this.pending.length && this.pending[i].t <= this.time) {
        this.pending[i++].fn();
      }
      if (i) this.pending.splice(0, i);
    }

    this.smoke.update(dt, viewH, fov);
    this.wsmoke.update(dt, viewH, fov);
    this.fire.update(dt, viewH, fov);
    this.streaks.update(dt, viewH, fov);

    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flashLight.intensity *= Math.exp(-dt * 9);
      if (this.flashT <= 0) this.flashLight.intensity = 0;
    }

    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const r = this.shocks[i];
      r.t += dt;
      if (r.t >= r.life) {
        r.s.visible = false;
        this.shockPool.push(r.s);
        this.shocks.splice(i, 1);
        continue;
      }
      const k = r.t / r.life;
      r.s.scale.setScalar(lerp(r.s0, r.s1, 1 - (1 - k) * (1 - k)));
      r.s.material.opacity = 0.85 * (1 - k) * (1 - k);
    }

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      d.v.y -= 9.8 * dt;
      d.v.multiplyScalar(Math.exp(-0.25 * dt));
      d.m.position.addScaledVector(d.v, dt);
      d.m.rotation.x += d.w.x * dt;
      d.m.rotation.y += d.w.y * dt;
      d.m.rotation.z += d.w.z * dt;
      // 처음엔 굵고 진한 줄기, 1~3초에 걸쳐 옅어진다. 중력으로 아래로 휜다.
      if (d.trail && d.trailT < d.trailMax) {
        d.trailT += dt;
        d.emit += dt;
        while (d.emit > FX.TRAIL_INTERVAL && this.smoke.count < this.smoke.max) {
          d.emit -= FX.TRAIL_INTERVAL;
          const fade = clamp(1 - d.trailT / d.trailMax, 0.15, 1);
          this.smoke.spawn(d.m.position.x, d.m.position.y, d.m.position.z,
            d.v.x * 0.2, d.v.y * 0.2 - 1.5, d.v.z * 0.2,
            FX.TRAIL_LIFE * (0.8 + Math.random() * 0.4), 3, FX.TRAIL_D_END,
            0.3 * fade + 0.06, 0.28 * fade + 0.06, 0.25 * fade + 0.05,
            0.55 * fade + 0.12, 0.6, -1.5,
            0.22, 0.21, 0.2, Math.random() * 6.2832, (Math.random() - 0.5) * 0.6, 1.5);
        }
      }
      const gh = this.world ? this.world.heightAt(d.m.position.x, d.m.position.z) : 0;
      if (d.m.position.y < gh) {
        d.m.position.y = gh;
        d.v.set(0, 0, 0);
        d.w.set(0, 0, 0);
        d.trail = false;
      }
      if (d.life <= 0) {
        d.m.visible = false;
        this.debrisPool.push(d.m);
        this.debris.splice(i, 1);
      }
    }
    this.shake = Math.max(0, this.shake - dt * 1.5);
  }
}

/** 천음속 베이퍼 콘 (마하 0.95~1.02, 습한 저고도) */
export function makeVaporCone() {
  const geo = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.42);
  geo.rotateX(-Math.PI / 2);  // 돔이 전방(-Z), 테두리가 후방으로 퍼짐
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main(){
        vP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uOpacity; uniform float uTime;
      varying vec3 vP; varying vec3 vN; varying vec3 vV;
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
                   mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p){
        float v = 0.0, a = 0.5;
        for (int k = 0; k < 3; k++){ v += a * n2(p); p *= 2.03; a *= 0.5; }
        return v;
      }
      void main(){
        #include <logdepthbuf_fragment>
        vec2 uv = vec2(atan(vP.y, vP.x) * 2.54648, vP.z * 0.55);
        vec2 flow = vec2(uTime * 0.35, -uTime * 0.55);
        float n = fbm(uv * 3.0 + flow) * 0.7 + fbm(uv * 7.0 - flow * 1.7) * 0.3;
        float edge = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.35);
        float body = smoothstep(-0.98, -0.32, vP.z);
        float flick = 0.86 + 0.14 * sin(uTime * 29.0 + n * 18.0);
        float a = uOpacity * body * (0.16 + 0.9 * edge) * (0.5 + n) * flick;
        a = clamp(a, 0.0, 0.92);
        vec3 col = mix(vec3(0.82, 0.88, 0.98), vec3(1.0), n);
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(4.6, 3.6, 7);
  m.position.set(0, 0.3, 3.2);
  m.visible = false;
  m.renderOrder = 6;
  return m;
}
