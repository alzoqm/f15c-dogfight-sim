// 월드: 절차적 지형(섬), 바다, 하늘(대기산란), 구름, 공군기지(활주로/격납고/관제탑), 수목/도시
// 물리 함수가 쓰는 높이 규칙(terrainRaw, heights 격자)은 그대로 두고 렌더링 품질만 올린다.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeNoise2D, smoothstep, lerp, clamp, mulberry32 } from './math.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// 대기 원근(높이 지수 안개): 공기 밀도처럼 고도에 따라 지수적으로 옅어지는 안개.
// THREE.Fog를 재해석: fog.near = 해면 소광계수(1/m), fog.far = 척도고도(m).
// 시선 경로를 따라 밀도를 해석적으로 적분 → 계곡엔 연무, 고고도에선 맑은 시야.
// ---------------------------------------------------------------------------
THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogView;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogView = mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    vec3 fogUpV = ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
    float fogDist = length( vFogView );
    float fogK = dot( vFogView, fogUpV ) / fogFar;
    float fogBase = exp( - max( cameraPosition.y, 0.0 ) / fogFar );
    float fogInteg = abs( fogK ) > 1e-3 ? fogBase * ( 1.0 - exp( - fogK ) ) / fogK : fogBase;
    float fogFactor = 1.0 - exp( - fogNear * fogDist * fogInteg );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( fogFactor, 0.0, 1.0 ) );
#endif`;

export const BASE_ELEV = 30;          // 기지 표고 m
export const RUNWAY = { length: 3200, width: 46, x: 0, z: 0 };   // 활주로 36/18 (남북 방향)

const SIZE = 120000;   // 지형 크기 120 km
const N = 800;         // 격자 셀 수 (150 m 간격)
const CELL = SIZE / N;
const HALF = SIZE / 2;

const _Y = new THREE.Vector3(0, 1, 0);
const nA = makeNoise2D(7), nB = makeNoise2D(13), nC = makeNoise2D(29), nD = makeNoise2D(71);
function fbm(nf, x, z, oct) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * nf(x * f, z * f); f *= 2.03; a *= 0.5; }
  return s;
}
function ridged(nf, x, z, oct) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { const v = 1 - Math.abs(nf(x * f, z * f)); s += a * v * v; f *= 2.1; a *= 0.5; }
  return s;
}

/** 지오메트리 병합 도우미: 인덱스 유무를 non-indexed로 통일하고 실패하면 바로 에러를 던진다 */
function mergeAll(list) {
  const norm = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = mergeGeometries(norm, false);
  if (!out) throw new Error('mergeGeometries 실패 (속성 불일치): ' + list.map((g) => g.type + (g.index ? '[indexed]' : '[non-indexed]')).join(', '));
  return out;
}

/** 리니어 → sRGB 바이트 (알베도 텍스처 굽기용) */
function encC(v) {
  v = clamp(v, 0, 1);
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(clamp(s, 0, 1) * 255);
}

/** 원시 지형 높이 함수 (m). 섬 중앙에 기지, 북쪽/동쪽에 산맥 */
function terrainRaw(x, z) {
  const kx = x / 1000, kz = z / 1000;
  const wx = kx + 7 * fbm(nB, kx * 0.03, kz * 0.03, 3);
  const wz = kz + 7 * fbm(nB, kx * 0.03 + 40, kz * 0.03 + 17, 3);
  const r = Math.hypot(wx, (wz + 6) * 1.12);
  const land = smoothstep(52, 36, r);
  let h = 70 + 130 * fbm(nA, kx * 0.07, kz * 0.07, 5) + 30 * nC(kx * 0.4, kz * 0.4);
  const mm = clamp(smoothstep(-9, -26, kz) + 0.7 * smoothstep(12, 30, kx) + 0.5 * smoothstep(-14, -32, kx), 0, 1);
  const rid = ridged(nC, kx * 0.055, kz * 0.055, 5);
  h += Math.pow(rid, 2.3) * 3000 * mm + 350 * mm * (fbm(nD, kx * 0.12, kz * 0.12, 3) + 0.5);
  h = lerp(-180, h, land);
  // 기지 주변 평탄화
  const bx = Math.max(0, Math.abs(x - 250) - 700), bz = Math.max(0, Math.abs(z) - 2300);
  const f = smoothstep(0, 2600, Math.hypot(bx, bz));
  return lerp(BASE_ELEV - 0.4, h, f);
}

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.heights = new Float32Array((N + 1) * (N + 1));
    this.sunDir = new THREE.Vector3();
    this.envMap = null;   // 환경맵은 렌더링 파이프라인(main.js)이 skyMesh/sunDir로 PMREM 생성
    this.time = 0;
    this.windX = 9;       // 상층풍 (구름 이동, m/s)
    this.windZ = 2.5;
    this._buildHeights();
    this._buildSky();
    this._buildLights();
    this._buildTerrain();
    this._buildWater();
    this._buildAirbase();
    this._buildVegetation();
    this._buildClouds();
  }

  // ---------------- 지형 높이 조회 (메시 삼각형과 동일한 보간) ----------------
  terrainHeight(x, z) {
    const fx = (x + HALF) / CELL, fz = (z + HALF) / CELL;
    if (fx < 0 || fz < 0 || fx >= N || fz >= N) return -200;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const H = this.heights, W = N + 1;
    const ha = H[j * W + i], hb = H[(j + 1) * W + i], hc = H[(j + 1) * W + i + 1], hd = H[j * W + i + 1];
    if (u + v <= 1) return ha + (hd - ha) * u + (hb - ha) * v;
    return hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
  }
  /** 충돌용 높이: 해수면(0) 포함 */
  heightAt(x, z) {
    const h = this.terrainHeight(x, z);
    return h > 0 ? h : 0;
  }
  isWater(x, z) { return this.terrainHeight(x, z) <= 0.2; }

  _buildHeights() {
    const W = N + 1;
    for (let j = 0; j <= N; j++) {
      const z = -HALF + j * CELL;
      for (let i = 0; i <= N; i++) {
        this.heights[j * W + i] = terrainRaw(-HALF + i * CELL, z);
      }
    }
  }

  // ---------------- 하늘 / 조명 ----------------
  _buildSky() {
    // 물리 기반 대기 산란 (레일리 + 미). 고고도에서 내려다봐도 어색하지 않게
    // 지평선 연무는 Sky 셰이더가 태양 고도에 맞춰 만든다.
    const sky = new Sky();
    sky.scale.setScalar(450000);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    const u = sky.material.uniforms;
    u.turbidity.value = 1.7;
    u.rayleigh.value = 3.2;
    u.mieCoefficient.value = 0.0025;
    u.mieDirectionalG.value = 0.88;
    const elev = 40 * Math.PI / 180, az = 28 * Math.PI / 180;   // 남남동 (북쪽을 향한 기본 시점이 순광)
    this.sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, az);
    this._sunH = new THREE.Vector3(this.sunDir.x, 0, this.sunDir.z).normalize();
    u.sunPosition.value.copy(this.sunDir);
    this.sky = sky;
    this.skyMesh = sky;   // 공개: main.js가 PMREM 환경맵 생성에 사용
    this.scene.add(sky);

    // 대기 원근용 안개: 수십 km 밖 지형·바다가 하늘 지평선색으로 녹아들게.
    // 고도 5 km에서 수평선 방향으로 봐도 연무가 남도록 소광을 키우고 척도고도를 높였다.
    // scene.environment는 여기서 만들지 않는다 (main.js 담당).
    this.hazeCool = new THREE.Color(0xbccde0);   // 태양 반대쪽 차가운 연무
    this.hazeWarm = new THREE.Color(0xdcd2c2);   // 태양 쪽 따뜻한 연무
    this.fogColor = this.hazeCool.clone();
    this.scene.fog = new THREE.Fog(this.fogColor, 3.5e-5, 4200);   // near=소광계수, far=척도고도
    this._fogDir = new THREE.Vector3();
    // 지평선 아래는 대기 원근색(안개색)으로 직접 칠한다: 수면 끝과 하늘 사이에 경계가 생기지 않게.
    // uFogColor는 안개색과 같은 객체라 태양 방위 연동이 그대로 반영되고, PMREM 환경맵에도 같은 색이 들어간다.
    sky.material.uniforms.uFogColor = { value: this.fogColor };
    sky.material.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('uniform float mieDirectionalG;', 'uniform float mieDirectionalG;\nuniform vec3 uFogColor;')
        .replace('gl_FragColor = vec4( retColor, 1.0 );', `gl_FragColor = vec4( retColor, 1.0 );
          {
            // 지평선 일치: 고도 0°에서 정확히 안개색이 되고 위로 약 2°에 걸쳐 하늘색으로 섞인다.
            // 아래쪽(안개색)과 값이 이어져 경계선이 생기지 않는다. 둘 다 선형·톤매핑 전이라 수치도 같다.
            vec3 sdir = normalize( vWorldPosition - cameraPosition );
            float hz = 1.0 - smoothstep( 0.0, 0.035, sdir.y );
            gl_FragColor.rgb = mix( gl_FragColor.rgb, uFogColor, hz );
          }`);
    };
  }

  _buildLights() {
    // 지면색은 '하면이 받는 반사광'만 정한다: 하늘색 쪽이 평지 지형과 기체 상면을 담당하므로
    // 지면색을 올려도 그 둘은 그대로다(법선 +Y 의 지면 가중치는 0). 예전 값 0x4a5236(선형 휘도
    // 0.078)은 하면에 조도 0.039 밖에 못 줘서, 상면(조도 0.93)과 24배 차이가 났다.
    const hemi = new THREE.HemisphereLight(0xc4d9f2, 0x7a875d, 0.5);
    this.scene.add(hemi);
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight(0xfff0da, 3.2);
    sun.position.copy(this.sunDir).multiplyScalar(1000);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 3000;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  // ---------------- 지형 메시 ----------------
  _buildTerrain() {
    const W = N + 1, count = W * W;
    const pos = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        pos[k * 3] = -HALF + i * CELL;
        pos[k * 3 + 1] = this.heights[k];   // 물리 조회값과 동일한 격자 높이
        pos[k * 3 + 2] = -HALF + j * CELL;
        uv[k * 2] = pos[k * 3] / 350;
        uv[k * 2 + 1] = pos[k * 3 + 2] / 350;
      }
    }
    const idx = new Uint32Array(N * N * 6);
    let p = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * W + i, b = (j + 1) * W + i, c = (j + 1) * W + i + 1, d = j * W + i + 1;
        idx[p++] = a; idx[p++] = b; idx[p++] = d;
        idx[p++] = b; idx[p++] = c; idx[p++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    this._initGroundPalette();
    geo.setAttribute('shade', new THREE.BufferAttribute(this._bakeShade(), 2));

    // 위성사진급 알베도 텍스처 (정점 색 대신 사용 → 위에서 본 경계 계단 제거)
    const albTex = this._bakeAlbedo();

    const detail = this._detailMaps();
    const mat = new THREE.MeshStandardMaterial({ map: detail.map, roughness: 0.97, metalness: 0, envMapIntensity: 0.18 });
    this.terrainUniforms = { uTimeC: { value: 0 }, uCloudAmt: { value: 0.7 }, uNormalDetail: { value: detail.normal }, uAlbedo: { value: albTex } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.terrainUniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 shade;\nvarying vec2 vShade;\nvarying vec3 vWXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = shade;\nvWXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vShade; varying vec3 vWXZ;
          uniform sampler2D uNormalDetail; uniform sampler2D uAlbedo;
          uniform float uTimeC; uniform float uCloudAmt;
          float twNoise( vec2 q ) {
            vec2 iq = floor( q ), fq = fract( q );
            vec2 w = fq * fq * ( 3.0 - 2.0 * fq );
            float a = fract( sin( dot( iq, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
            float b = fract( sin( dot( iq + vec2( 1.0, 0.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
            float cc = fract( sin( dot( iq + vec2( 0.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
            float d = fract( sin( dot( iq + vec2( 1.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
            return mix( mix( a, b, w.x ), mix( cc, d, w.x ), w.y );
          }`)
        // 다중 스케일 디테일: 근거리 미세 질감 + 중거리 얼룩 + 원거리 거대 변화 (타일 반복 은폐)
        .replace('#include <map_fragment>', `
          #ifdef USE_MAP
            // 위성 알베도: 경계를 노이즈로 ±60 m 흔들어 계단 모양 제거 (밭 직선 경계는 유지)
            vec2 auv = vWXZ.xz / 120000.0 + 0.5;
            vec2 wob = vec2( twNoise( auv * 640.0 ), twNoise( auv * 640.0 + 13.7 ) ) - 0.5;
            vec3 alb = texture2D( uAlbedo, auv + wob * 0.001 ).rgb;
            // 중·근거리 디테일 (셰이더에서 계산해 텍셀 뭉개짐 해소, 거리별 페이드)
            {
              float lum = dot( alb, vec3( 0.333 ) );
              float distT = length( vViewPosition );
              float nearF = 1.0 - smoothstep( 120.0, 1100.0, distT );
              float midF = 1.0 - smoothstep( 1500.0, 6000.0, distT );
              // 숲 수관 반점 (어두운 녹색, 5~20 m)
              float darkM = 1.0 - smoothstep( 0.06, 0.22, lum );
              float canopy = twNoise( vWXZ.xz * 0.09 ) * 0.6 + twNoise( vWXZ.xz * 0.22 ) * 0.4;
              alb *= 1.0 + ( canopy - 0.5 ) * 0.9 * darkM * nearF;
              // 밭 작물 줄무늬 (따뜻한 밝은 픽셀, 약 12 m 간격)
              float warmM = clamp( ( ( alb.r + alb.g ) * 0.5 - alb.b ) * 4.0, 0.0, 1.0 ) * smoothstep( 0.1, 0.25, lum );
              float rows = sin( dot( vWXZ.xz, vec2( 0.94, 0.34 ) ) * 0.5 + twNoise( vWXZ.xz * 0.008 ) * 9.0 );
              alb *= 1.0 + rows * 0.09 * warmM * nearF;
              // 바위 균열 (회색 픽셀, 중거리)
              float grayM = clamp( 1.0 - abs( alb.r - alb.g ) * 6.0 - abs( alb.g - alb.b ) * 6.0, 0.0, 1.0 ) * smoothstep( 0.12, 0.3, lum );
              float crack = 1.0 - abs( twNoise( vWXZ.xz * 0.06 ) * 2.0 - 1.0 );
              alb *= 1.0 - smoothstep( 0.75, 0.98, crack ) * 0.3 * grayM * midF;
            }
            diffuseColor.rgb = alb;
            float tA = texture2D( map, vMapUv ).r;
            float tB = texture2D( map, vMapUv * 7.31 + 0.17 ).r;
            float tC = texture2D( map, vMapUv * 0.071 ).r;
            float tD = texture2D( map, vMapUv * 0.0093 + 0.43 ).r;
            float distV = length( vViewPosition );
            float nearW = 1.0 - smoothstep( 500.0, 4500.0, distV );
            float midW = 1.0 - smoothstep( 4000.0, 30000.0, distV );
            float det = mix( tC, tA * 0.5 + tB * 0.5, nearW );
            diffuseColor.rgb *= ( 0.62 + 0.76 * det * ( 0.5 + 0.5 * midW ) + 0.28 * ( 1.0 - midW ) );
            diffuseColor.rgb *= ( 0.8 + 0.4 * tC * midW + 0.2 * ( 1.0 - midW ) );
            diffuseColor.rgb *= ( 0.85 + 0.3 * tD );
          #endif`)
        // 근거리 노멀 디테일 (자갈·풀·흙 질감의 빛 반사 변화), 거리 따라 페이드
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          {
            float distN = length( vViewPosition );
            float nW = 1.0 - smoothstep( 60.0, 3000.0, distN );
            if ( nW > 0.001 ) {
              vec3 dnA = texture2D( uNormalDetail, vMapUv * 3.7 ).xyz * 2.0 - 1.0;
              vec3 dnB = texture2D( uNormalDetail, vMapUv * 0.83 + 0.37 ).xyz * 2.0 - 1.0;
              vec3 dnC = texture2D( uNormalDetail, vMapUv * 11.0 + 0.61 ).xyz * 2.0 - 1.0;
              float midW = 1.0 - smoothstep( 200.0, 3000.0, distN );
              normal = normalize( normal + vec3( dnA.x * 1.0 + dnB.x * 0.7 + dnC.x * 0.45 * midW, dnA.y * 1.0 + dnB.y * 0.7 + dnC.y * 0.45 * midW, 0.0 ) * nW );
            }
          }`)
        // 베이크된 산 그림자(직사광) + 지형 차폐(간접광) + 이동하는 구름 그림자
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            vec2 cuv = vWXZ.xz * 0.00006 + vec2( uTimeC * 0.0011, uTimeC * 0.0003 );
            float cs = twNoise( cuv ) * 0.6 + twNoise( cuv * 3.1 ) * 0.4;
            float shadeF = mix( 1.0, 0.62 + 0.38 * smoothstep( 0.25, 0.75, cs ), uCloudAmt );
            reflectedLight.directDiffuse *= vShade.x * shadeF;
            reflectedLight.indirectDiffuse *= vShade.y * mix( 1.0, 0.86 + 0.14 * cs, uCloudAmt );
          }`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrain = mesh;
    this.terrainDetail = detail;
    this.scene.add(mesh);
  }

  /** 지면 팔레트 (채도 낮춘 위성사진 톤: 올리브·갈색·회녹) */
  _initGroundPalette() {
    const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    this._pal = {
      sand: srgb(0.6, 0.56, 0.42),
      grassA: srgb(0.3, 0.34, 0.16), grassB: srgb(0.36, 0.37, 0.2),
      meadow: srgb(0.38, 0.4, 0.22), dry: srgb(0.46, 0.44, 0.27),
      forest: srgb(0.13, 0.19, 0.1), riparian: srgb(0.09, 0.16, 0.08),
      rock: srgb(0.4, 0.37, 0.33), rock2: srgb(0.3, 0.29, 0.27),
      snow: srgb(0.93, 0.95, 0.98), seabed: srgb(0.22, 0.3, 0.28), scree: srgb(0.46, 0.42, 0.35),
      village: srgb(0.55, 0.54, 0.48),
      fields: [srgb(0.55, 0.47, 0.25), srgb(0.4, 0.44, 0.24), srgb(0.36, 0.3, 0.22), srgb(0.28, 0.33, 0.16), srgb(0.47, 0.43, 0.3), srgb(0.5, 0.42, 0.24)],
    };
  }

  /** 높이 격자 쌍선형 보간 (알베도 굽기용, 물리 조회와 별개) */
  _heightBilinear(x, z) {
    const fx = (x + HALF) / CELL, fz = (z + HALF) / CELL;
    const i = clamp(Math.floor(fx), 0, N - 1), j = clamp(Math.floor(fz), 0, N - 1);
    const u = clamp(fx - i, 0, 1), v = clamp(fz - j, 0, 1);
    const H = this.heights, W = N + 1;
    const a = H[j * W + i] * (1 - u) + H[j * W + i + 1] * u;
    const b = H[(j + 1) * W + i] * (1 - u) + H[(j + 1) * W + i + 1] * u;
    return a * (1 - v) + b * v;
  }

  /** 한 지점의 지면 색 (리니어). 밭·숲·마을·암설 경계는 smoothstep으로 섞는다 */
  _groundColor(x, z, c, tmp) {
    const P = this._pal;
    const h = this._heightBilinear(x, z);
    const e = 75;
    const hx = (this._heightBilinear(x + e, z) - this._heightBilinear(x - e, z)) / (2 * e);
    const hz = (this._heightBilinear(x, z + e) - this._heightBilinear(x, z - e)) / (2 * e);
    const slope = 1 - 1 / Math.sqrt(hx * hx + 1 + hz * hz);
    const n1 = nA(x * 0.0007, z * 0.0007), n2 = nD(x * 0.003, z * 0.003);
    const nMacro = nB(x * 0.00018 + 11, z * 0.00018 - 5);
    if (h < -1) c.copy(P.seabed).lerp(P.sand, clamp(1 + h / 40, 0, 1));
    else if (h < 2.5) c.copy(P.sand);   // 모래 띠는 얇게 (호숫가·해안선 바로 곁만)
    else {
      // 초지 바탕 + km 규모 습도 얼룩 (모래에서 풀밭으로 빠르게 전환)
      c.copy(P.sand).lerp(P.grassA, smoothstep(1.5, 4, h));
      c.lerp(P.grassB, (0.5 + 0.5 * n1) * smoothstep(2, 8, h));
      c.lerp(P.meadow, smoothstep(0.1, 0.55, nMacro) * 0.55 * smoothstep(700, 250, h));
      c.lerp(tmp.copy(P.grassB).multiplyScalar(0.8), smoothstep(-0.1, -0.5, nMacro) * 0.5);
      // 계곡·경사면을 따라 길게 이어지는 숲 (도메인 워핑 노이즈 + 경사·계곡 마스크)
      const H = this.heights, W = N + 1;
      const gx = Math.round((x + HALF) / CELL), gz = Math.round((z + HALF) / CELL);
      const gAt = (ii, jj) => H[clamp(jj, 0, N) * W + clamp(ii, 0, N)];
      const avgN = (gAt(gx + 3, gz) + gAt(gx - 3, gz) + gAt(gx, gz + 3) + gAt(gx, gz - 3)) * 0.25;
      const valley = clamp(avgN - h, 0, 400) / 160;
      const valleyM = clamp(valley, 0, 1) * smoothstep(900, 350, h) * smoothstep(15, 40, h);
      const ridge = clamp((h - avgN) / 120, 0, 1) * smoothstep(300, 600, h);   // 능선 밝은 건초지
      c.lerp(P.dry, ridge * 0.55 * smoothstep(1400, 900, h));
      const wx = x + 2200 * nB(x * 0.00035 + 3.1, z * 0.00035 - 1.7);
      const wz = z + 2200 * nB(x * 0.00035 - 8.4, z * 0.00035 + 5.2);
      const fBase = fbm(nB, wx * 0.0009, wz * 0.0009, 3);
      const slopeBelt = smoothstep(0.02, 0.1, slope) * (1 - smoothstep(0.5, 0.7, slope) * smoothstep(1200, 700, h));
      let forestAmt = Math.max(smoothstep(0.05, 0.4, fBase + 0.25 * smoothstep(0.03, 0.2, slope)) * Math.max(slopeBelt, 0.25 * smoothstep(500, 200, h)), valleyM * 0.9);
      c.lerp(P.forest, forestAmt * smoothstep(1400, 900, h));
      if (valleyM > 0.2) c.lerp(P.riparian, Math.min(1, valleyM) * 0.7 * smoothstep(1400, 900, h));
      // 밭 모자이크 (지역마다 셀 크기·색이 다른 직사각형, 얇은 경계선)
      const reg = mulberry32((Math.floor(x / 4600) * 911) ^ (Math.floor(z / 4600) * 1327 + 7))();
      const gw = reg < 0.5 ? 1200 : 2600, gh = reg < 0.5 ? 900 : 2000;
      const fu0 = x / gw + 0.3 * n2, fv0 = z / gh;
      const fx = Math.floor(fu0), fz = Math.floor(fv0);
      const fu = fu0 - fx, fv = fv0 - fz;
      const hash = mulberry32((fx * 73856093) ^ (fz * 19349663))();
      const farm = smoothstep(280, 130, h) * smoothstep(0.09, 0.03, slope) * (1 - forestAmt) * smoothstep(0.15, -0.15, nMacro + 0.3 * n1);
      if (farm > 0.01) {
        tmp.copy(P.fields[Math.floor(hash * P.fields.length)]);
        const stripe = 0.93 + 0.07 * Math.sin((hash > 0.5 ? x : z) * 0.35);
        tmp.multiplyScalar(stripe);
        c.lerp(tmp, farm * 0.85);
        const edge = Math.min(Math.min(fu, 1 - fu) * gw, Math.min(fv, 1 - fv) * gh);
        const hedge = 1 - smoothstep(8, 25, edge);
        c.multiplyScalar(1 - hedge * 0.35 * farm);
      }
      // 마을 느낌 (2.3 km 셀 중 일부, 저지대)
      const vx = Math.floor(x / 2300), vz = Math.floor(z / 2300);
      const vhash = mulberry32((vx * 911) ^ (vz * 1327 + 7))();
      if (vhash > 0.7 && h > 10 && h < 300 && slope < 0.06) {
        const speck = 0.5 + 0.5 * nD(x * 0.02, z * 0.02);
        c.lerp(P.village, 0.5 * speck * smoothstep(0.7, 0.82, vhash) * (1 - farm * 0.5));
      }
      // 암벽 + 고산 너덜 지대
      const rockAmt = Math.max(smoothstep(0.32, 0.55, slope), smoothstep(1300, 1900, h + n2 * 260 + n1 * 120));
      c.lerp(tmp.copy(P.rock).lerp(P.rock2, 0.5 + 0.5 * n2), rockAmt);
      c.lerp(P.scree, smoothstep(1500, 1900, h) * smoothstep(0.45, 0.25, slope) * 0.6);
      // 설선
      const snowAmt = smoothstep(1950, 2250, h + n1 * 260 + nMacro * 150) * smoothstep(0.7, 0.4, slope);
      c.lerp(P.snow, snowAmt);
    }
    c.multiplyScalar(0.92 + 0.12 * n2);
    return c;
  }

  /** 2048 위성 알베도 텍스처 굽기 (약 60 m/텍셀, 선형 필터로 경계가 매끈) */
  _bakeAlbedo() {
    const S = 2048;
    const data = new Uint8Array(S * S * 4);
    const c = new THREE.Color(), tmp = new THREE.Color();
    for (let y = 0; y < S; y++) {
      const z = (y / (S - 1) - 0.5) * SIZE;
      for (let x = 0; x < S; x++) {
        this._groundColor((x / (S - 1) - 0.5) * SIZE, z, c, tmp);
        const i = (y * S + x) * 4;
        data[i] = encC(c.r); data[i + 1] = encC(c.g); data[i + 2] = encC(c.b); data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  /** 태양 방향 레이마칭으로 산 그림자를 굽고, 주변 높이와 비교해 계곡 차폐(AO)를 계산 */
  _bakeShade() {
    const W = N + 1, H = this.heights, out = new Float32Array(W * W * 2);
    const sd = this.sunDir, horiz = Math.hypot(sd.x, sd.z);
    const tanE = sd.y / horiz, stepX = sd.x / horiz, stepZ = sd.z / horiz;
    const at = (i, j) => H[clamp(Math.round(j), 0, N) * W + clamp(Math.round(i), 0, N)];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const h0 = H[j * W + i];
        // 그림자: 태양 쪽으로 진행하며 지형이 광선 위로 솟는지 검사 (부드러운 반그림자)
        let vis = 1;
        if (h0 > -5) {
          for (let k = 1; k <= 60; k++) {
            const d = k <= 20 ? k : 20 + (k - 20) * 2.5;
            const ray = h0 + d * CELL * tanE;
            if (ray > 3400) break;
            const th = at(i + stepX * d, j + stepZ * d);
            const occ = (th - ray) / (25 + d * 6);
            if (occ > -1) vis = Math.min(vis, clamp(-occ, 0, 1));
            if (vis <= 0) break;
          }
        }
        // 차폐: 반경 3셀 평균보다 낮으면 어둡게 (계곡), 높으면 밝게 (능선)
        let sum = 0;
        for (const [di, dj] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, 2], [2, -2], [-2, -2]]) sum += at(i + di, j + dj);
        const cav = (sum / 8 - h0) / 120;
        const ao = clamp(1 - cav * 0.65, 0.45, 1.15);
        const k2 = (j * W + i) * 2;
        out[k2] = 0.25 + 0.75 * vis;
        out[k2 + 1] = ao;
      }
    }
    return out;
  }

  /** 절차적 디테일 텍스처: albedo용 그레이 + 법선 디테일용 노멀맵 (둘 다 타일 경계 봉합) */
  _detailMaps() {
    const s = 512, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const img = g.createImageData(s, s);
    const nf = makeNoise2D(5), nf2 = makeNoise2D(17);
    // 주기 경계를 맞춘 타일링 노이즈 (풀/덤불/흙 얼룩 느낌의 다옥타브)
    const f = (px, py) => 0.42 * nf(px * 0.025, py * 0.025) + 0.28 * nf(px * 0.07, py * 0.07) + 0.18 * nf2(px * 0.19, py * 0.19) + 0.12 * nf2(px * 0.5, py * 0.5);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const a = f(x, y), b = f(x - s, y), cc = f(x, y - s), d = f(x - s, y - s);
      const u = x / s, v = y / s;
      const n = lerp(lerp(a, b, u), lerp(cc, d, u), v);
      const val = 128 + n * 150;
      const i = (y * s + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = clamp(val, 0, 255);
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 16;

    // 법선 디테일: 같은 방식의 높이장 → sobel식 법선 (타일 봉합)
    const cv2 = document.createElement('canvas');
    cv2.width = cv2.height = s;
    const g2 = cv2.getContext('2d');
    const img2 = g2.createImageData(s, s);
    const nf3 = makeNoise2D(23), nf4 = makeNoise2D(37);
    const h = (px, py) => 0.5 * nf3(px * 0.05, py * 0.05) + 0.3 * nf4(px * 0.13 + 7, py * 0.13) + 0.2 * nf3(px * 0.31, py * 0.31 + 3);
    const hs = new Float32Array(s * s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const a = h(x, y), b = h(x - s, y), cc = h(x, y - s), d = h(x - s, y - s);
      const u = x / s, v = y / s;
      hs[y * s + x] = lerp(lerp(a, b, u), lerp(cc, d, u), v);
    }
    const H = (x, y) => hs[(((y % s) + s) % s) * s + (((x % s) + s) % s)];
    const nv = new THREE.Vector3();
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = H(x + 1, y) - H(x - 1, y), dy = H(x, y + 1) - H(x, y - 1);
      nv.set(-dx * 3.2, -dy * 3.2, 1).normalize();
      const i = (y * s + x) * 4;
      img2.data[i] = (nv.x * 0.5 + 0.5) * 255; img2.data[i + 1] = (nv.y * 0.5 + 0.5) * 255; img2.data[i + 2] = (nv.z * 0.5 + 0.5) * 255; img2.data[i + 3] = 255;
    }
    g2.putImageData(img2, 0, 0);
    const tn = new THREE.CanvasTexture(cv2);
    tn.wrapS = tn.wrapT = THREE.RepeatWrapping;
    tn.colorSpace = THREE.NoColorSpace;
    tn.anisotropy = 8;
    return { map: t, normal: tn };
  }

  // ---------------- 바다 ----------------
  _buildWater() {
    // 파도 법선맵 (타일링 다옥타브 노이즈 → 법선)
    const s = 512, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const img = g.createImageData(s, s);
    const nf = makeNoise2D(99), nf2 = makeNoise2D(123);
    const hs = new Float32Array(s * s);
    const tw = (px, py) => 0.5 * nf(px * 0.03, py * 0.03) + 0.3 * nf2(px * 0.08 + 9, py * 0.08) + 0.2 * nf(px * 0.21, py * 0.21 + 5);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const a = tw(x, y), b = tw(x - s, y), c = tw(x, y - s), d = tw(x - s, y - s);
      hs[y * s + x] = lerp(lerp(a, b, x / s), lerp(c, d, x / s), y / s);
    }
    const H = (x, y) => hs[(((y % s) + s) % s) * s + (((x % s) + s) % s)];
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = H(x + 1, y) - H(x - 1, y), dy = H(x, y + 1) - H(x, y - 1);
      const n = new THREE.Vector3(-dx * 6, -dy * 6, 1).normalize();
      const i = (y * s + x) * 4;
      img.data[i] = (n.x * 0.5 + 0.5) * 255; img.data[i + 1] = (n.y * 0.5 + 0.5) * 255; img.data[i + 2] = (n.z * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const nt = new THREE.CanvasTexture(cv);
    nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
    nt.repeat.set(4000, 4000);
    nt.anisotropy = 16;
    // 수심 + 바다 여부 텍스처 (R=수심, G=바다). 바다는 가장자리에서 물로 이어지는 곳만이라 호수와 구분된다.
    const W = N + 1, dep = new Uint8Array(W * W * 2);
    const sea = new Uint8Array(W * W);
    const stack = [];
    for (let i = 0; i <= N; i++) {
      for (const [ii, jj] of [[i, 0], [i, N], [0, i], [N, i]]) {
        const k = jj * W + ii;
        if (!sea[k] && this.heights[k] <= 0.2) { sea[k] = 1; stack.push(k); }
      }
    }
    while (stack.length) {
      const k = stack.pop(), i = k % W, j = (k / W) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii > N || jj > N) continue;
        const k2 = jj * W + ii;
        if (!sea[k2] && this.heights[k2] <= 0.2) { sea[k2] = 1; stack.push(k2); }
      }
    }
    for (let k = 0; k < W * W; k++) { dep[k * 2] = clamp(-this.heights[k], 0, 255); dep[k * 2 + 1] = sea[k] * 255; }
    const depTex = new THREE.DataTexture(dep, W, W, THREE.RGFormat, THREE.UnsignedByteType);
    depTex.unpackAlignment = 1;
    depTex.magFilter = depTex.minFilter = THREE.LinearFilter;
    depTex.needsUpdate = true;

    const mat = new THREE.MeshStandardMaterial({ color: 0x0f3550, roughness: 0.08, metalness: 0.0, normalMap: nt, normalScale: new THREE.Vector2(0.55, 0.55), envMapIntensity: 1.35, transparent: true });
    this.waterUniforms = { uTime: { value: 0 }, uDepth: { value: depTex }, uSize: { value: SIZE }, uSunDirW: { value: this.sunDir.clone() }, uHaze: { value: this.hazeCool.clone() } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.waterUniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos;
          uniform float uTime;
          uniform sampler2D uDepth;
          uniform float uSize;
          uniform vec3 uSunDirW;
          uniform vec3 uHaze;
          float wtNoise( vec2 q ) {
            vec2 iq = floor( q ), fq = fract( q );
            vec2 w = fq * fq * ( 3.0 - 2.0 * fq );
            float a = fract( sin( dot( iq, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
            float b = fract( sin( dot( iq + vec2( 1.0, 0.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
            float cc = fract( sin( dot( iq + vec2( 0.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
            float d = fract( sin( dot( iq + vec2( 1.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
            return mix( mix( a, b, w.x ), mix( cc, d, w.x ), w.y );
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 dUv = vWPos.xz / uSize + 0.5;
          vec2 ds = ( dUv.x > 0.0 && dUv.x < 1.0 && dUv.y > 0.0 && dUv.y < 1.0 ) ? texture2D( uDepth, dUv ).rg : vec2( 1.0, 1.0 );
          float wDepth = ds.r * 255.0;
          float seaM = ds.g;
          // 깊이 그라데이션: 얇은 모래 가장자리 → 짙은 청록 중간물 → 남색 심해 + 대규모 얼룩
          vec3 cShore = vec3( 0.24, 0.3, 0.26 ), cMid = vec3( 0.04, 0.17, 0.2 ), cDeep = vec3( 0.004, 0.04, 0.09 );
          diffuseColor.rgb = mix( cShore, cMid, smoothstep( 0.0, 2.5, wDepth ) );
          float wVar = wtNoise( vWPos.xz * 0.0016 ) * 0.6 + wtNoise( vWPos.xz * 0.00021 + 7.0 ) * 0.4;
          diffuseColor.rgb *= 0.85 + 0.3 * wVar;
          diffuseColor.rgb = mix( diffuseColor.rgb, cDeep, smoothstep( 2.0, 25.0, wDepth ) );
          // 해안선 거품대 (바다만, 호수 제외): 깊이에 노이즈 흔들기를 줘 다각형 경계가 읽히지 않게
          float wDepthW = wDepth + ( wtNoise( vWPos.xz * 0.05 ) - 0.5 ) * 6.0;
          float foamBand = ( 1.0 - smoothstep( 0.0, 3.5, wDepthW ) ) * seaM;
          float foamWave = 0.5 + 0.5 * sin( uTime * 1.3 - wDepth * 2.2 + sin( vWPos.x * 0.004 + vWPos.z * 0.003 ) * 3.0 );
          float foamTex = 0.5 + 0.5 * sin( vWPos.x * 0.35 + vWPos.z * 0.31 + uTime * 0.8 ) * sin( vWPos.x * 0.13 - vWPos.z * 0.29 - uTime * 0.6 );
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.85, 0.9, 0.92 ), foamBand * foamWave * ( 0.15 + 0.25 * foamTex ) );
          // 프레넬: 비스듬히 볼수록 하늘 연무색 반사 (수평선과 자연스럽게 연결)
          vec3 Vw = normalize( cameraPosition - vWPos );
          float fres = pow( 1.0 - clamp( Vw.y, 0.0, 1.0 ), 3.0 );
          diffuseColor.rgb = mix( diffuseColor.rgb, uHaze, clamp( fres * 0.85 + 0.06, 0.0, 1.0 ) );
          // 물가 가장자리 소프트 페이드: 수심 0→2 m에서 서서히 나타나 다각형 모서리를 숨긴다
          diffuseColor.a = smoothstep( 0.0, 2.0, wDepthW );`)
        // 3개 스케일의 파도 법선을 서로 다른 방향으로 흘려 타일 반복을 숨김
        .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', `
          vec3 wn1 = texture2D( normalMap, vNormalMapUv + vec2( uTime * 0.0045, uTime * 0.0027 ) ).xyz * 2.0 - 1.0;
          vec3 wn2 = texture2D( normalMap, vNormalMapUv * 0.29 + vec2( - uTime * 0.0019, uTime * 0.0031 ) ).xyz * 2.0 - 1.0;
          vec3 wn3 = texture2D( normalMap, vNormalMapUv * 0.041 + vec2( uTime * 0.0004, - uTime * 0.0005 ) ).xyz * 2.0 - 1.0;
          vec3 mapN = normalize( vec3( wn1.xy + wn2.xy + wn3.xy * 1.4, 1.0 ) );`)
        // 태양 스펙큘러 반짝임: 날카로운 글리터 + 넓은 쉬인
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec3 Vv = normalize( vViewPosition );
            vec3 sv = normalize( ( viewMatrix * vec4( uSunDirW, 0.0 ) ).xyz );
            vec3 Rv = reflect( -Vv, normalize( normal ) );
            float sd = max( dot( Rv, sv ), 0.0 );
            totalEmissiveRadiance += vec3( 1.0, 0.93, 0.8 ) * ( pow( sd, 700.0 ) * 4.5 + pow( sd, 60.0 ) * 0.45 );
          }`);
    };
    const water = new THREE.Mesh(new THREE.PlaneGeometry(900000, 900000), mat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0;
    water.receiveShadow = false;
    water.renderOrder = 2;   // 불투명 지형 위, 투명 구름(3, 4)보다 먼저 그려 순서 고정
    this.water = water;
    this.waterNormal = nt;
    this.scene.add(water);
  }

  // ---------------- 공군 기지 ----------------
  _buildAirbase() {
    const g = new THREE.Group();
    const y = BASE_ELEV + 0.02;
    const L = RUNWAY.length, Wd = RUNWAY.width;

    // 활주로 텍스처 (위쪽 = 북쪽 끝)
    const cw = 256, ch = 8192, cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const c = cv.getContext('2d');
    c.fillStyle = '#3a3b3d'; c.fillRect(0, 0, cw, ch);
    const rnd = mulberry32(3);
    for (let i = 0; i < 30000; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? 20 : 90},${rnd() < 0.5 ? 20 : 90},${rnd() < 0.5 ? 22 : 92},0.15)`; c.fillRect(rnd() * cw, rnd() * ch, 2, 3 + rnd() * 8); }
    // 콘크리트 슬래브 이음선 (30 m 간격 가로줄 + 중앙 세로줄)
    c.fillStyle = 'rgba(0,0,0,0.28)';
    const mpy0 = ch / L;
    for (let m = 0; m < L; m += 30) c.fillRect(0, m * mpy0, cw, 2);
    c.fillRect(cw / 2 - 1, 0, 2, ch);
    const mpx = cw / Wd, mpy = ch / L; // px per meter
    c.fillStyle = '#e8e8e8';
    // 측면선
    c.fillRect(1 * mpx, 0, 0.9 * mpx, ch); c.fillRect(cw - 1.9 * mpx, 0, 0.9 * mpx, ch);
    // 중심선 (36m 선, 24m 간격)
    for (let m = 120; m < L - 120; m += 60) c.fillRect(cw / 2 - 0.45 * mpx, m * mpy, 0.9 * mpx, 36 * mpy);
    // 피아노 건반 (양끝)
    const keys = (yy) => { for (let k = 0; k < 6; k++) { const off = 3 + k * 3.1; c.fillRect(off * mpx, yy, 1.8 * mpx, 45 * mpy); c.fillRect(cw - (off + 1.8) * mpx, yy, 1.8 * mpx, 45 * mpy); } };
    keys(6 * mpy); keys(ch - 51 * mpy);
    // 조준점 표지 / 접지구역
    const aim = (yy) => { c.fillRect(7 * mpx, yy, 9 * mpx, 50 * mpy); c.fillRect(cw - 16 * mpx, yy, 9 * mpx, 50 * mpy); };
    aim(ch - 400 * mpy); aim(350 * mpy);
    for (const d of [150, 450, 600]) {
      c.fillRect(9 * mpx, ch - (d + 22) * mpy, 1.8 * mpx, 22 * mpy); c.fillRect(12 * mpx, ch - (d + 22) * mpy, 1.8 * mpx, 22 * mpy);
      c.fillRect(cw - 11 * mpx, ch - (d + 22) * mpy, 1.8 * mpx, 22 * mpy); c.fillRect(cw - 14 * mpx, ch - (d + 22) * mpy, 1.8 * mpx, 22 * mpy);
      c.fillRect(9 * mpx, (d) * mpy, 1.8 * mpx, 22 * mpy); c.fillRect(12 * mpx, d * mpy, 1.8 * mpx, 22 * mpy);
      c.fillRect(cw - 11 * mpx, d * mpy, 1.8 * mpx, 22 * mpy); c.fillRect(cw - 14 * mpx, d * mpy, 1.8 * mpx, 22 * mpy);
    }
    // 활주로 번호
    const num = (txt, yy, rot) => {
      // 숫자 1자 약 6 m 폭, 18 m 길이 (ICAO 규격)
      c.save(); c.translate(cw / 2, yy); c.rotate(rot); c.scale(1, (18 * mpy) / (6.5 * mpx * 1.35));
      c.font = `bold ${Math.round(6.5 * mpx * 1.35)}px Arial`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(txt, 0, 0); c.restore();
    };
    num('36', ch - 80 * mpy, 0); num('18', 80 * mpy, Math.PI);
    // 타이어 자국 (접지대 2곳에 진하게 + 중앙선 따라 옅게)
    c.fillStyle = 'rgba(15,15,15,0.35)';
    for (let i = 0; i < 260; i++) { const yy = (rnd() < 0.5 ? ch - (100 + rnd() * 600) * mpy : (100 + rnd() * 600) * mpy); c.fillRect(cw / 2 + (rnd() - 0.5) * 9 * mpx, yy, 0.6 * mpx, (5 + rnd() * 30) * mpy); }
    c.fillStyle = 'rgba(12,12,12,0.22)';
    for (let i = 0; i < 500; i++) { const yy = rnd() * ch; c.fillRect(cw / 2 + (rnd() - 0.5) * 4 * mpx, yy, 0.5 * mpx, (8 + rnd() * 20) * mpy); }
    // 오버런 셰브론 (양끝 외곽, 노랑): 갓길 평면이 덮으므로 생략, 타이어 자국으로 대체
    const rtex = new THREE.CanvasTexture(cv);
    rtex.anisotropy = 16;
    rtex.colorSpace = THREE.SRGBColorSpace;
    const runway = new THREE.Mesh(new THREE.PlaneGeometry(Wd, L), new THREE.MeshStandardMaterial({ map: rtex, roughness: 0.85, metalness: 0 }));
    runway.rotation.x = -Math.PI / 2;
    runway.position.set(RUNWAY.x, y + 0.03, RUNWAY.z);
    runway.receiveShadow = true;
    g.add(runway);

    // 갓길/오버런
    const asphalt = new THREE.MeshStandardMaterial({ color: 0x4a4b4c, roughness: 0.95 });
    const conc = new THREE.MeshStandardMaterial({ color: 0x8b8a84, roughness: 0.9 });
    const plane = (w, l, x, z, m, dy = 0) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, l), m); p.rotation.x = -Math.PI / 2; p.position.set(x, y + dy, z); p.receiveShadow = true; g.add(p); return p; };
    plane(Wd + 16, L + 300, 0, 0, asphalt, 0.0);
    // 평행 유도로와 연결로, 계류장
    plane(23, L - 200, 190, 0, asphalt, 0.02);
    for (const zz of [-L / 2 + 120, -400, 400, L / 2 - 120]) plane(190, 23, 95, zz, asphalt, 0.025);
    // 계류장: 주기 위치 박스선 + 유도로 중앙선 (노랑) 텍스처
    const apC = document.createElement('canvas');
    apC.width = 256; apC.height = 512;
    const ap = apC.getContext('2d');
    ap.fillStyle = '#8b8a84'; ap.fillRect(0, 0, 256, 512);
    const rndA = mulberry32(21);
    for (let i = 0; i < 2500; i++) { ap.fillStyle = `rgba(60,60,58,${0.08 + rndA() * 0.1})`; ap.fillRect(rndA() * 256, rndA() * 512, 2, 2); }
    ap.strokeStyle = '#c8a028'; ap.lineWidth = 3;
    ap.setLineDash([18, 14]);
    ap.beginPath(); ap.moveTo(128, 10); ap.lineTo(128, 502); ap.stroke();   // 유도로 중앙선
    ap.setLineDash([]);
    ap.strokeStyle = '#e8e8e8'; ap.lineWidth = 3;
    for (let i = 0; i < 6; i++) { const yy = 40 + i * 78; ap.strokeRect(48, yy, 160, 58); }  // 주기 박스
    const apTex = new THREE.CanvasTexture(apC);
    apTex.colorSpace = THREE.SRGBColorSpace;
    apTex.anisotropy = 8;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(260, 620), new THREE.MeshStandardMaterial({ map: apTex, roughness: 0.9 }));
    apron.rotation.x = -Math.PI / 2; apron.position.set(360, y + 0.03, 0); apron.receiveShadow = true; g.add(apron);

    // 격납고 (아치 지붕 + 보강 리브 + 문틀 + 환기창)
    const hangarMat = new THREE.MeshStandardMaterial({ color: 0x7b8070, roughness: 0.8, metalness: 0.1 });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x2e3133, roughness: 0.7 });
    const ribMat = new THREE.MeshStandardMaterial({ color: 0x5d6154, roughness: 0.85 });
    for (let i = 0; i < 5; i++) {
      const hz = -240 + i * 120;
      const hg = new THREE.Group();
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 40, 24, 1, false, 0, Math.PI), hangarMat);
      roof.rotation.set(0, 0, Math.PI / 2);   // 원통 축을 X축으로, 반원이 위쪽
      roof.scale.set(1, 1, 0.75);
      hg.add(roof);
      for (let r = -2; r <= 2; r++) {   // 지붕 보강 리브
        const rib = new THREE.Mesh(new THREE.TorusGeometry(22.3, 0.5, 6, 20, Math.PI), ribMat);
        rib.rotation.y = Math.PI / 2;
        rib.position.x = r * 8;
        rib.scale.z = 0.75;
        hg.add(rib);
      }
      const door = new THREE.Mesh(new THREE.PlaneGeometry(26, 14), doorMat);
      door.rotation.y = -Math.PI / 2; door.position.set(-20.1, 7.5, 0);
      hg.add(door);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.8, 15, 28), ribMat);  // 문틀
      frame.position.set(-20.3, 7.5, 0);
      hg.add(frame);
      const winStrip = new THREE.Mesh(new THREE.BoxGeometry(40.5, 1.6, 0.3), new THREE.MeshStandardMaterial({ color: 0x1d2c3a, roughness: 0.2, metalness: 0.5 }));
      winStrip.position.set(0, 12, -16.6);   // 측면 환기창 띠
      hg.add(winStrip);
      hg.position.set(530, y, hz);
      hg.rotation.y = 0;
      roof.castShadow = true;
      hg.traverse(o => { o.castShadow = true; o.receiveShadow = true; });
      g.add(hg);
    }
    // 관제탑 (샤프트 홈 + 캐브 유리 멀리언 + 지붕 안테나 + 적색 비컨)
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xc9c5ba, roughness: 0.8 });
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 32, 12), towerMat);
    tower.position.set(470, y + 16, 420); tower.castShadow = true; g.add(tower);
    for (let f = 0; f < 3; f++) {   // 샤프트 수평 홈대
      const band = new THREE.Mesh(new THREE.CylinderGeometry(4.35 - f * 0.06, 4.45 - f * 0.06, 0.7, 12), ribMat);
      band.position.set(470, y + 8 + f * 8, 420);
      g.add(band);
    }
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 6, 6, 8), new THREE.MeshStandardMaterial({ color: 0x24394a, roughness: 0.1, metalness: 0.6 }));
    cab.position.set(470, y + 35, 420); cab.castShadow = true; g.add(cab);
    for (let mI = 0; mI < 8; mI++) {   // 캐브 유리 멀리언
      const a = (mI / 8) * Math.PI * 2 + Math.PI / 8;
      const mull = new THREE.Mesh(new THREE.BoxGeometry(0.35, 5.6, 0.35), towerMat);
      mull.position.set(470 + Math.cos(a) * 6.85, y + 35, 420 + Math.sin(a) * 6.85);
      g.add(mull);
    }
    const capm = new THREE.Mesh(new THREE.CylinderGeometry(8.2, 8.2, 1.2, 8), towerMat);
    capm.position.set(470, y + 38.6, 420); capm.castShadow = true; g.add(capm);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 7, 6), ribMat);
    mast.position.set(470, y + 42.5, 420); g.add(mast);
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2020 });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), this.beaconMat);
    beacon.position.set(470, y + 46.2, 420); g.add(beacon);
    // 기타 건물
    const bmat = new THREE.MeshStandardMaterial({ color: 0xa8a294, roughness: 0.9 });
    const rnd2 = mulberry32(11);
    for (let i = 0; i < 26; i++) {
      const w = 15 + rnd2() * 35, d = 12 + rnd2() * 30, h = 5 + rnd2() * 12;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bmat);
      b.position.set(620 + rnd2() * 380, y + h / 2, -700 + rnd2() * 1400);
      b.castShadow = b.receiveShadow = true;
      g.add(b);
      if (rnd2() < 0.5) {   // 옥상 물탱크/박스
        const box = new THREE.Mesh(new THREE.BoxGeometry(3, 2.5, 3), ribMat);
        box.position.set(b.position.x + (rnd2() - 0.5) * w * 0.5, y + h + 1.25, b.position.z + (rnd2() - 0.5) * d * 0.5);
        box.castShadow = true;
        g.add(box);
      }
    }
    // 연료 탱크 2기 + 방호벽
    const tankMat = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.6, metalness: 0.2 });
    for (const [tx, tz] of [[700, 620], [748, 620]]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 12, 20), tankMat);
      tank.position.set(tx, y + 6, tz); tank.castShadow = tank.receiveShadow = true; g.add(tank);
      const lid = new THREE.Mesh(new THREE.SphereGeometry(14, 20, 6, 0, Math.PI * 2, 0, 0.45), tankMat);
      lid.position.set(tx, y + 12, tz); g.add(lid);
    }
    const wall = new THREE.Mesh(new THREE.BoxGeometry(120, 3, 1.5), conc);
    wall.position.set(724, y + 1.5, 590); wall.castShadow = true; g.add(wall);
    // 윈드삭 (폴 + 콘)
    const sockPole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 8, 6), ribMat);
    sockPole.position.set(-60, y + 4, 900); sockPole.castShadow = true; g.add(sockPole);
    const sock = new THREE.Mesh(new THREE.ConeGeometry(1.1, 4.5, 8), new THREE.MeshStandardMaterial({ color: 0xd8622a, roughness: 0.8 }));
    sock.rotation.z = Math.PI / 2 - 0.15;
    sock.position.set(-57.5, y + 7.6, 900);
    g.add(sock);
    // 활주로 등화 (등간격)
    const lightGeo = new THREE.BoxGeometry(0.5, 0.35, 0.5);
    const edgeCount = Math.floor(L / 60) + 1;
    const lights = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xfff6d0 }), edgeCount * 2 + 40);
    const m4 = new THREE.Matrix4();
    let li = 0;
    for (let i = 0; i < edgeCount; i++) {
      const zz = -L / 2 + i * 60;
      m4.makeTranslation(-Wd / 2 - 1.5, y + 0.2, zz); lights.setMatrixAt(li++, m4);
      m4.makeTranslation(Wd / 2 + 1.5, y + 0.2, zz); lights.setMatrixAt(li++, m4);
    }
    // 진입등 (남쪽)
    for (let i = 0; i < 20; i++) { m4.makeTranslation((i % 5 - 2) * 3, y + 0.4, L / 2 + 60 + Math.floor(i / 5) * 60); lights.setMatrixAt(li++, m4); }
    for (let i = 0; i < 20; i++) { m4.makeTranslation((i % 5 - 2) * 3, y + 0.4, -L / 2 - 60 - Math.floor(i / 5) * 60); lights.setMatrixAt(li++, m4); }
    lights.count = li;
    g.add(lights);
    // PAPI (활주로 좌측, 접지점 옆) — 진입각 3°
    this.papi = [];
    const papiGeo = new THREE.SphereGeometry(0.9, 8, 6);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(papiGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      m.position.set(-Wd / 2 - 15 - i * 9, y + 0.9, L / 2 - 350);
      g.add(m);
      this.papi.push({ mesh: m, angle: [3.5, 3.17, 2.83, 2.5][i] });
    }
    this.papiPos = new THREE.Vector3(-Wd / 2 - 28, y, L / 2 - 350);
    this.airbase = g;
    this.scene.add(g);
  }

  // ---------------- 수목 / 도시 ----------------
  _buildVegetation() {
    const rnd = mulberry32(42);
    const paint = (g, r, gg, b) => { const c = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < c.length; i += 3) { c[i] = r; c[i + 1] = gg; c[i + 2] = b; } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g; };
    // 2단 원뿔 침엽수 + 줄기 (하나의 지오메트리로 병합)
    const crownA = new THREE.ConeGeometry(4.2, 9, 7); crownA.translate(0, 7.5, 0);
    const crownB = new THREE.ConeGeometry(3.0, 7, 7); crownB.translate(0, 12, 0);
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 4, 5); trunk.translate(0, 2, 0);
    const treeGeo = mergeAll([paint(crownA, 1, 1, 1), paint(crownB, 1.15, 1.15, 1.1), paint(trunk, 0.9, 0.6, 0.45)]);
    this.windUniforms = { uTime: { value: 0 } };
    const sway = (mat) => {
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, this.windUniforms);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            {
              float phW = 0.0;
              #ifdef USE_INSTANCING
                phW = instanceMatrix[3][0] * 0.05 + instanceMatrix[3][2] * 0.07;
              #endif
              float bendW = clamp( transformed.y / 12.0, 0.0, 1.0 );
              transformed.x += sin( uTime * 1.3 + phW ) * bendW * 0.35;
              transformed.z += cos( uTime * 0.9 + phW * 1.3 ) * bendW * 0.25;
            }`);
      };
    };
    const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    sway(treeMat);
    const MAX = 45000;
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, MAX);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const tc = new THREE.Color();
    let n = 0;
    for (let tries = 0; tries < 400000 && n < MAX; tries++) {
      const x = (rnd() - 0.5) * 44000, z = (rnd() - 0.5) * 44000;
      if (Math.abs(x - 250) < 1100 && Math.abs(z) < 2700) continue;
      const h = this.terrainHeight(x, z);
      if (h < 8 || h > 1500) continue;
      const forest = nB(x * 0.0011, z * 0.0011);
      if (forest < 0.08 && rnd() > 0.04) continue;
      const sc = 0.7 + rnd() * 0.9;
      s.set(sc, sc * (0.8 + rnd() * 0.5), sc);
      p.set(x, h - 0.6, z);
      q.setFromAxisAngle(_Y, rnd() * Math.PI * 2);
      m4.compose(p, q, s);
      trees.setMatrixAt(n, m4);
      tc.setHSL(0.24 + rnd() * 0.09, 0.45 + rnd() * 0.2, 0.13 + rnd() * 0.08);
      trees.setColorAt(n, tc);
      n++;
    }
    trees.count = n;
    trees.castShadow = false;
    trees.receiveShadow = true;
    this.scene.add(trees);
    this.trees = trees;
    q.identity();

    // 활엽수 (둥근 수관): 저지대·산록에 침엽수와 섞어 심음
    const blob = new THREE.IcosahedronGeometry(4.6, 1); blob.translate(0, 6.4, 0);
    const trunk2 = new THREE.CylinderGeometry(0.3, 0.45, 3.4, 5); trunk2.translate(0, 1.7, 0);
    const broadGeo = mergeAll([paint(blob, 1.2, 1.2, 1.0), paint(trunk2, 0.85, 0.58, 0.42)]);
    broadGeo.computeVertexNormals();
    const broadMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    sway(broadMat);
    const MAXB = 14000;
    const broad = new THREE.InstancedMesh(broadGeo, broadMat, MAXB);
    let nb = 0;
    for (let tries = 0; tries < 200000 && nb < MAXB; tries++) {
      const x = (rnd() - 0.5) * 40000, z = (rnd() - 0.5) * 40000;
      if (Math.abs(x - 250) < 1100 && Math.abs(z) < 2700) continue;
      const h = this.terrainHeight(x, z);
      if (h < 8 || h > 900) continue;
      const forest = nB(x * 0.0011 + 31, z * 0.0011 - 17);
      if (forest < 0.02 && rnd() > 0.03) continue;
      const sc = 0.8 + rnd() * 1.1;
      s.set(sc * (0.9 + rnd() * 0.3), sc, sc * (0.9 + rnd() * 0.3));
      p.set(x, h - 0.5, z);
      q.setFromAxisAngle(_Y, rnd() * Math.PI * 2);
      m4.compose(p, q, s);
      broad.setMatrixAt(nb, m4);
      tc.setHSL(0.22 + rnd() * 0.1, 0.4 + rnd() * 0.2, 0.16 + rnd() * 0.09);
      broad.setColorAt(nb, tc);
      nb++;
    }
    broad.count = nb;
    broad.receiveShadow = true;
    this.scene.add(broad);
    this.broadleaf = broad;
    q.identity();

    // 소도시 (기지 남서쪽)
    const bGeo = new THREE.BoxGeometry(1, 1, 1);
    bGeo.translate(0, 0.5, 0);
    const bMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const city = new THREE.InstancedMesh(bGeo, bMat, 1400);
    const col = new THREE.Color();
    let k = 0;
    for (const [cx, cz, r, cnt] of [[-6500, 5200, 1700, 900], [9000, 9000, 1100, 500]]) {
      for (let i = 0; i < cnt; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * r;
        const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
        const h = this.terrainHeight(x, z);
        if (h < 5) continue;
        const tall = rr < r * 0.3 ? 20 + rnd() * 55 : 6 + rnd() * 14;
        s.set(15 + rnd() * 25, tall, 15 + rnd() * 25);
        p.set(Math.round(x / 40) * 40, h - 1, Math.round(z / 40) * 40);
        m4.compose(p, q, s);
        city.setMatrixAt(k, m4);
        col.setHSL(0.08 + rnd() * 0.05, 0.08 + rnd() * 0.06, 0.5 + rnd() * 0.28);
        city.setColorAt(k, col);
        k++;
      }
    }
    city.count = k;
    this.scene.add(city);
    this.city = city;
  }

  // ---------------- 구름 ----------------
  _puffTexture(streak) {
    // 적운 퍼프 텍스처 (여러 원형 그라디언트 + 노이즈 침식)
    const S = 256, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');
    const rnd = mulberry32(streak ? 19 : 8);
    const blobs = streak ? 16 : 62;
    for (let i = 0; i < blobs; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 70;
      const x = 128 + Math.cos(a) * rr * (streak ? 1.9 : 1);
      const y = 128 + Math.sin(a) * rr * (streak ? 0.4 : 0.75) + (streak ? 10 : 0);
      const r = (streak ? 20 + rnd() * 30 : 24 + rnd() * 44);
      const gr = c.createRadialGradient(x, y, 0, x, y, r);
      const coreA = streak ? 0.3 : 0.5, midA = streak ? 0.12 : 0.22;
      gr.addColorStop(0, `rgba(255,255,255,${coreA})`);
      gr.addColorStop(0.55, `rgba(255,255,255,${midA})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gr;
      c.fillRect(0, 0, S, S);
    }
    const id = c.getImageData(0, 0, S, S), nf = makeNoise2D(streak ? 47 : 31);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = 0.6 * nf(x * 0.03, y * 0.03) + 0.4 * nf(x * 0.09, y * 0.09);
      const ex = Math.hypot((x - 128) / (streak ? 128 : 128), (y - 128) / (streak ? 70 : 128));
      id.data[i + 3] = clamp(id.data[i + 3] * (1 + 0.55 * n) * (1 - ex * ex), 0, 255);
    }
    c.putImageData(id, 0, 0);
    return new THREE.CanvasTexture(cv);
  }

  _makePuffLayer(puffs, tex, opts) {
    const count = puffs.length;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    const off = new Float32Array(count * 3), size = new Float32Array(count), shade = new Float32Array(count);
    const fade = new Float32Array(count).fill(1), flatA = new Float32Array(count);
    geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(off, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iShade', new THREE.InstancedBufferAttribute(shade, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iFade', new THREE.InstancedBufferAttribute(fade, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iFlat', new THREE.InstancedBufferAttribute(flatA, 1).setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount = count;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        map: { value: tex }, uSunView: { value: new THREE.Vector3() },
        uLit: { value: new THREE.Color(opts.lit[0], opts.lit[1], opts.lit[2]) },
        uShadow: { value: new THREE.Color(opts.shadow[0], opts.shadow[1], opts.shadow[2]) },
        uGain: { value: opts.gain }, uAspect: { value: new THREE.Vector2(opts.aspectX, opts.aspectY) },
        uSilver: { value: opts.silver }, uAlpha: { value: opts.alpha },
      }]),
      vertexShader: /* glsl */`
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 iOffset; attribute float iSize; attribute float iShade; attribute float iFade; attribute float iFlat;
        uniform vec3 uSunView; uniform vec2 uAspect;
        varying vec2 vUv; varying float vShade; varying float vFade; varying float vFadeA; varying float vSun;
        void main(){
          vUv = uv;
          vec4 mvPosition = viewMatrix * vec4( iOffset, 1.0 );
          float d = -mvPosition.z;
          mvPosition.xy += position.xy * iSize * uAspect * vec2( 1.0 + iFlat * 0.9, 1.0 - iFlat * 0.45 );
          vShade = iShade;
          vFade = smoothstep( iSize * 0.15, iSize * 0.9, d );
          vFadeA = iFade;
          vSun = dot( normalize( vec3( position.xy * 2.0, 0.6 ) ), normalize( uSunView ) );
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D map; uniform vec3 uLit; uniform vec3 uShadow;
        uniform float uGain; uniform float uSilver; uniform float uAlpha;
        varying vec2 vUv; varying float vShade; varying float vFade; varying float vFadeA; varying float vSun;
        void main(){
          #include <logdepthbuf_fragment>
          vec4 t = texture2D( map, vUv );
          float a = t.a * vFade * vFadeA;
          if ( a < 0.004 ) discard;
          // 평평하고 어두운 밑면 + 위로 솟은 밝은 윗면 (콜리플라워), 태양 반대쪽은 회청색 음영
          float sunAmt = clamp( vSun * 0.5 + 0.5, 0.0, 1.0 );
          float light = ( 0.12 + 0.95 * vUv.y * vUv.y ) * ( 0.38 + 0.62 * sunAmt ) * vShade;
          light += 0.35 * max( vSun, 0.0 ) * vUv.y;   // 윗면 직사광
          // 태양 쪽 가장자리 은빛 테두리 (앞쪽 산란 실버라이닝)
          float edge = 1.0 - smoothstep( 0.03, 0.3, t.a );
          light += edge * pow( max( vSun, 0.0 ), 2.0 ) * uSilver;
          // 정면 산란 글로우 (태양 주변 구름이 밝아짐)
          light += pow( max( vSun, 0.0 ), 6.0 ) * 0.4 * t.a;
          gl_FragColor = vec4( mix( uShadow, uLit, clamp( light, 0.0, 1.25 ) ) * uGain, a * uAlpha );
          #include <fog_fragment>
        }`,
      transparent: true, depthWrite: false, fog: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return mesh;
  }

  _buildClouds() {
    const rnd = mulberry32(8);
    // 적운층: 수십 km 규모 구름 무리 + 빈 하늘. 무리마다 수백 m~수 km 퍼프 수십 장 겹침
    const puffs = [];
    const gauss = () => (rnd() + rnd() + rnd()) / 3 - 0.5;   // -0.5~0.5 중심 쏠림 분포
    const addCluster = (cx, cz, cy, radius, count, dark) => {
      for (let j = 0; j < count; j++) {
        const dx = gauss() * 2 * radius, dz = gauss() * 2 * radius * 0.7;
        const dist = Math.min(1, Math.hypot(dx, dz) / radius);
        const dy = (1 - dist) * (rnd() * rnd() * 750) + rnd() * 120;   // 밑면은 평평, 윗면은 솟음
        let size = 300 * Math.exp(rnd() * Math.log(2600 / 300));       // 300 m~2.6 km 로그 균등
        if (rnd() < 0.12) size *= 1.8;                                // 가끔 초대형 덩어리
        const shade = (0.5 + 0.4 * clamp(dy / 600, 0, 1)) * dark;
        const flat = clamp((size - 900) / 1700, 0, 1);                // 클수록 납작하게
        puffs.push({ x: cx + dx, y: cy + dy, z: cz + dz, size, shade, flat });
      }
      // 무리 바닥에 깔리는 대형 데크 (멀리서 보면 납작한 구름 바다)
      for (let j = 0; j < 3; j++) {
        const size = 3000 + rnd() * 3000;
        puffs.push({
          x: cx + gauss() * radius, y: cy + rnd() * 80, z: cz + gauss() * radius * 0.7,
          size, shade: 0.55 * dark, flat: 0.85,
        });
      }
    };
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, r = 4000 + Math.pow(rnd(), 0.7) * 62000;
      addCluster(Math.cos(a) * r, Math.sin(a) * r, 2200 + rnd() * 1200, 5000 + rnd() * 11000, 18 + Math.floor(rnd() * 26), 1);
    }
    for (let i = 0; i < 8; i++) {   // 낮은 조각구름 (1.2~1.7 km, 밑면이 어두움)
      const a = rnd() * Math.PI * 2, r = 3000 + rnd() * 50000;
      addCluster(Math.cos(a) * r, Math.sin(a) * r, 1200 + rnd() * 500, 3000 + rnd() * 4000, 8 + Math.floor(rnd() * 8), 0.7);
    }
    const mesh = this._makePuffLayer(puffs, this._puffTexture(false), {
      gain: 2.5, aspectX: 1.5, aspectY: 1.0, silver: 0.55, alpha: 1.0,
      lit: [1.0, 0.97, 0.92], shadow: [0.38, 0.44, 0.58],
    });
    this.cloudPuffs = puffs;
    this.cloudMesh = mesh;
    this.cloudOrder = puffs.map((_, i) => i);
    this.cloudFrame = 0;
    this.clouds = mesh;
    this.scene.add(mesh);
    this._sortClouds(new THREE.Vector3(0, 3000, 0));

    // 권운층 (고도 8~10 km): 얇고 넓게 퍼진 줄무늬, 은은하게
    const cir = [];
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2, r = 8000 + Math.sqrt(rnd()) * 70000;
      cir.push({
        x: Math.cos(a) * r, y: 8000 + rnd() * 2200, z: Math.sin(a) * r,
        size: 2600 + rnd() * 4200, shade: 0.95 + rnd() * 0.1, flat: 0,
      });
    }
    const cirrus = this._makePuffLayer(cir, this._puffTexture(true), {
      gain: 1.15, aspectX: 2.6, aspectY: 0.42, silver: 0.35, alpha: 0.32,
      lit: [1.02, 1.0, 0.97], shadow: [0.72, 0.75, 0.82],
    });
    cirrus.renderOrder = 4;
    this.cirrusPuffs = cir;
    this.cirrusMesh = cirrus;
    this.cirrusOrder = cir.map((_, i) => i);
    this.scene.add(cirrus);
    this._sortLayer(cirrus, cir, this.cirrusOrder, new THREE.Vector3(0, 8000, 0));
  }

  /** 반투명 퍼프를 카메라 기준 원→근으로 정렬해 인스턴스 버퍼 재작성 */
  _sortLayer(mesh, P, o, cam) {
    for (const p of P) p.d = (p.x - cam.x) ** 2 + (p.y - cam.y) ** 2 + (p.z - cam.z) ** 2;
    o.sort((a, b) => P[b].d - P[a].d);
    const g = mesh.geometry;
    const off = g.attributes.iOffset.array, size = g.attributes.iSize.array, shade = g.attributes.iShade.array;
    const fadeA = g.attributes.iFade.array, flatA = g.attributes.iFlat.array;
    for (let k = 0; k < o.length; k++) {
      const p = P[o[k]];
      off[k * 3] = p.x; off[k * 3 + 1] = p.y; off[k * 3 + 2] = p.z;
      size[k] = p.size; shade[k] = p.shade; flatA[k] = p.flat || 0;
      // 지형 소프트 페이드: 산이 구름을 뚫을 때 경계가 부드럽게 사라지게
      fadeA[k] = smoothstep(60, 600, p.y - Math.max(this.terrainHeight(p.x, p.z), 0));
    }
    g.attributes.iOffset.needsUpdate = g.attributes.iSize.needsUpdate = true;
    g.attributes.iShade.needsUpdate = g.attributes.iFade.needsUpdate = g.attributes.iFlat.needsUpdate = true;
  }
  _sortClouds(cam) {
    this._sortLayer(this.cloudMesh, this.cloudPuffs, this.cloudOrder, cam);
  }
  _sortCirrus(cam) {
    this._sortLayer(this.cirrusMesh, this.cirrusPuffs, this.cirrusOrder, cam);
  }

  /** 렌더 직전 카메라 기반 갱신 (구름 정렬/조명, 연무색) */
  updateCamera(camera) {
    if (!this.cloudMesh) return;
    if ((this.cloudFrame++ % 6) === 0) {
      this._sortClouds(camera.position);
      this._sortCirrus(camera.position);
    }
    const sv = this.cloudMesh.material.uniforms.uSunView.value.copy(this.sunDir).transformDirection(camera.matrixWorldInverse);
    this.cirrusMesh.material.uniforms.uSunView.value.copy(sv);
    // 연무색을 하늘 지평선과 일치: 카메라 시선과 태양 방위각 차이로 온기 조절
    camera.getWorldDirection(this._fogDir);
    this._fogDir.y = 0;
    if (this._fogDir.lengthSq() > 1e-6) {
      this._fogDir.normalize();
      const t = Math.pow(Math.max(0, this._fogDir.x * this._sunH.x + this._fogDir.z * this._sunH.z), 2);
      this.fogColor.copy(this.hazeCool).lerp(this.hazeWarm, t * 0.65);
      this.waterUniforms.uHaze.value.copy(this.fogColor);
    }
  }

  /** 카메라/대상 위치에 따른 갱신 (그림자 카메라 추적, 안개 농도, 수면 애니메이션) */
  update(dt, focus, camAlt) {
    this.time += dt;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 1200);
    this.waterUniforms.uTime.value = this.time;
    this.windUniforms.uTime.value = this.time;
    this.terrainUniforms.uTimeC.value = this.time;
    // 구름을 상층풍 방향으로 천천히 이동 (범위 순환)
    const dx = this.windX * dt, dz = this.windZ * dt, R = 68000;
    for (const arr of [this.cloudPuffs, this.cirrusPuffs]) {
      for (const p of arr) {
        p.x += dx; p.z += dz;
        if (p.x > R) p.x -= R * 2; else if (p.x < -R) p.x += R * 2;
        if (p.z > R) p.z -= R * 2; else if (p.z < -R) p.z += R * 2;
      }
    }
    // 관제탑 비컨 점멸
    if (this.beaconMat) this.beaconMat.color.setHex((this.time % 1.6) < 0.12 ? 0xff3030 : 0x551010);
  }

  /** PAPI 색상 갱신: 관측자 위치에서 본 진입각에 따라 백/적 */
  updatePAPI(eye) {
    const dx = eye.x - this.papiPos.x, dz = eye.z - this.papiPos.z;
    const dist = Math.hypot(dx, dz);
    const ang = Math.atan2(eye.y - this.papiPos.y, dist) * 180 / Math.PI;
    for (const p of this.papi) p.mesh.material.color.set(ang > p.angle ? 0xffffff : 0xff2010);
  }
}
