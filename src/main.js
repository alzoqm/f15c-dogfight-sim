// 진입점: 렌더러/씬 구성, UI 연결, 메인 루프
import * as THREE from 'three';
import { World, BASE_ELEV } from './world.js';
import { Effects } from './effects.js';
import { Weapons } from './weapons.js';
import { AudioSys } from './audio.js';
import { HUD } from './hud.js';
import { Input } from './input.js';
import { Game, MISSILE_DIFFS } from './game.js';
import { setupKeybind, renderCustomKeys } from './keybind.js';
import { buildF15, preloadF15 } from './aircraftModel.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

// 그래픽 품질 프리셋
const DPR = window.devicePixelRatio || 1;
// pr: 해상도 배율 / bloom: 블룸 세기(0 이면 끔) / shadow: 그림자 맵 해상도
// msaa: HDR 렌더 타깃 멀티샘플 수(0 이면 FXAA 로 대체) / grain: 필름 그레인 배율
const QUALITY = {
  low:    { label: '낮음',   pr: 1,                  bloom: 0,    shadow: 1024, msaa: 0, grain: 0 },
  medium: { label: '중간',   pr: 1,                  bloom: 0.5,  shadow: 2048, msaa: 2, grain: 0.5 },
  high:   { label: '높음',   pr: Math.min(DPR, 1.5), bloom: 0.55, shadow: 2048, msaa: 4, grain: 1 },
  ultra:  { label: '울트라', pr: Math.min(DPR, 2),   bloom: 0.6,  shadow: 4096, msaa: 4, grain: 1 },
};
const SETTINGS_KEY = 'f15sim.settings.v1';
const loadSettings = () => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } };
const saveSettings = (o) => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(o)); } catch { /* 저장 불가 환경 */ } };

// ---------------- 렌더 파이프라인 상수 (화면 밸런스를 바꾸려면 여기만 만진다) ----------------
// PMREM 반사 블러. 크게 주면 금속 반사가 뭉개지고, 0 이면 하늘의 태양 원반이 그대로 얼룩으로 남는다
const ENV_SIGMA = 0.045;
// 하늘 IBL 세기. 월드가 hemi 광을 함께 쓰므로 1.0 보다 낮춰 간접광 이중 계산을 완화한다
const ENV_INTENSITY = 0.8;
// PMREM 하반구(지평선 아래) 휘도. 하늘만 구우면 아래에서 올라오는 반사가 없어, 태양 그늘진
// 기체 하면이 순검정이 된다. 값은 '햇빛 받은 지면'의 선형 휘도(0.45) = 상반구 하늘 평균(0.6)의 0.75배.
// 기체 skin 은 envMapIntensity 0.5 · environmentIntensity 0.8 을 곱해 받으므로 이 값이
// 하면 radiance 의 84% 를 만든다(나머지는 world.js 반구광 지면색).
const ENV_GROUND_COLOR = 0xa8b997;
// 위 측정(measureSkyLum)용 색은 예전 값 그대로 둔다. 노출 = EXPOSURE_K / skyLum 이라
// 지면 원판을 밝히면 하늘 평균 휘도가 올라가 노출이 같이 떨어진다(밝히면 오히려 어두워진다).
// 측정은 이 색으로 하고, PMREM 굽기 직전에만 ENV_GROUND_COLOR 로 바꾼다 → 노출·블룸 임계 불변.
const ENV_GROUND_MEASURE_COLOR = 0x3d4436;
// 노출 역산 상수: 하늘 평균 선형 휘도를 ACES 출력 0.60(표시 sRGB 약 0.80)에 두는 값.
// three 의 ACES 는 색에 exposure/0.6 을 곱한 뒤 필름 곡선을 적용하므로
//   ACES 출력 0.60 ← 곡선 입력 0.95 ← exposure = 0.95 * 0.6 / L = 0.57 / L
const EXPOSURE_K = 0.57;
const EXPOSURE_MIN = 0.18, EXPOSURE_MAX = 0.9, EXPOSURE_FALLBACK = 0.5;
// 블룸 임계값은 측정한 하늘 휘도의 배수로 잡는다(맑은 하늘·구름은 억제, 태양·애프터버너·폭발만 번짐)
const BLOOM_THRESHOLD_MULT = 2.2, BLOOM_THRESHOLD_MIN = 1.5, BLOOM_THRESHOLD_MAX = 6.5, BLOOM_THRESHOLD_FALLBACK = 2.4;
const BLOOM_RADIUS = 0.45, BLOOM_SMOOTH = 0.8;
// 필름 그레인 진폭(선형 공간 곱셈 노이즈)
const GRAIN_AMPLITUDE = 0.05;
// 하늘 채도 보정(가장 정확한 원인 수정): three 의 Sky 셰이더는 마지막에 pow(texColor, 1/2.4) 로
// 표시용(gamma) 인코딩을 해 둔 값을 반환한다. 그 값을 선형 HDR 로 취급해 ACES+노출을 걸면
// 채도가 두 번 압축되어 하늘이 회백색이 된다(실측: 20도 고도에서 채널차 B-R 28/255).
// 인코딩 지수의 역(≈2.4)을 곱해 선형으로 되돌리고, 평균 휘도는 부팅 때 측정해 상쇄하므로
// 노출·블룸·지면·기체 밝기는 그대로이고 하늘의 채도와 계조만 정상화된다.
// (셰이더 문자열이 바뀌어 패치가 적용되지 않으면 자동으로 기존 동작을 유지한다)
const SKY_LINEARIZE = true;
// 그림자: 플레이어 주변 ±SHADOW_HALF m 만 계산해 텍셀 밀도를 확보한다
const SHADOW_HALF = 40;
const SHADOW_DIST = 900;        // 광원과 초점 사이 거리
const SHADOW_RANGE = 250;       // near/far 여유 → 깊이 정밀도 확보(그림자 아크네 감소)
const SHADOW_BIAS = -0.00012;
const NORMAL_BIAS_TEXELS = 1.25; // 법선 방향 바이어스를 텍셀 단위로 준다(기체 자기그림자 줄무늬 제거)
const UP_Y = new THREE.Vector3(0, 1, 0);

// 색보정/비네트/필름 그레인. 반드시 OutputPass(톤매핑) 앞, 즉 선형 HDR 에서 적용한다.
// 여기서 톤매핑이나 색공간 변환을 하지 않는다(이중 적용 금지). 밝기 곱만 하는 효과들이다.
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0 },
    uSat: { value: 1.05 },
    uTint: { value: new THREE.Vector3(1.015, 1.0, 0.985) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uSat;
    uniform vec3 uTint;
    varying vec2 vUv;

    // 값 노이즈(그레인). 프레임마다 위상이 바뀐다
    float hash21( vec2 p ) {
      p = fract( p * vec2( 123.34, 456.21 ) );
      p += dot( p, p + 45.32 );
      return fract( p.x * p.y );
    }

    void main() {
      vec3 c = max( texture2D( tDiffuse, vUv ).rgb, 0.0 );
      // 채도: 선형 휘도 기준으로 보간
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( l ), c, uSat );
      // 색온도: 태양광의 따뜻한 틴트(아주 약하게)
      c *= uTint;
      // 비네트: 렌즈 낙차처럼 선형광을 곱으로 감쇠
      vec2 q = vUv - 0.5;
      c *= mix( 1.0, clamp( 1.0 - dot( q, q ) * 1.15, 0.0, 1.0 ), uVignette );
      // 필름 그레인: 선형 공간에서는 곱셈 노이즈가 어두운 곳과 밝은 곳에 고르게 보인다
      if ( uGrain > 0.0 ) {
        float n = hash21( vUv * uResolution + vec2( uTime * 37.0, uTime * 11.0 ) ) - 0.5;
        c *= 1.0 + n * uGrain;
      }
      gl_FragColor = vec4( c, 1.0 );
    }`,
};

// ---------------- 렌더 파이프라인 보조 함수 ----------------
/** 월드의 태양 방향을 갱신한다. 다른 워커가 sunDir 를 아직 안 넣었을 수 있어 광원에서 역산하는 폴백을 둔다. */
function readSunDir(world, out) {
  const sd = world && world.sunDir;
  if (sd && sd.isVector3 && sd.lengthSq() > 1e-8) { out.copy(sd).normalize(); return out; }
  const sun = world && world.sun;
  if (sun && sun.isDirectionalLight) {
    out.copy(sun.position).sub(sun.target.position);
    if (out.lengthSq() > 1e-8) return out.normalize();
  }
  out.set(0.35, 0.64, 0.68).normalize();   // 기본: 남남동 + 40도 고도 근사
  return out;
}

/** 하늘 메시를 찾는다(world.skyMesh 공개 API 우선, 없으면 씬에서 sunPosition 유니폼을 가진 메시). */
function findSkyObject(world, scene) {
  const cand = (world && (world.skyMesh || world.sky || world.skyDome)) || null;
  if (cand && cand.isObject3D) return cand;
  let found = null;
  scene.traverse((o) => {
    if (found || !o.isMesh || !o.material) return;
    const un = o.material.uniforms;
    if (un && un.sunPosition) found = o;
  });
  return found;
}

/** 하늘 메시가 없을 때의 폴백: 하늘색 그라데이션 + 태양 원반(별도 애드온 없이 직접 만든다). */
function makeGradientSky(sunDir) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: {
      uSun: { value: sunDir.clone() },
      uZenith: { value: new THREE.Vector3(0.10, 0.28, 0.70) },
      uHorizon: { value: new THREE.Vector3(0.55, 0.66, 0.80) },
      uGround: { value: new THREE.Vector3(0.055, 0.065, 0.045) },
      uSunColor: { value: new THREE.Vector3(1.0, 0.93, 0.80) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize( vDir );
        float up = clamp( d.y, -1.0, 1.0 );
        vec3 col = mix( uHorizon, uZenith, pow( clamp( up, 0.0, 1.0 ), 0.55 ) );
        col = mix( col, uGround, smoothstep( 0.0, -0.12, up ) );
        float s = max( dot( d, uSun ), 0.0 );
        col += uSunColor * ( pow( s, 400.0 ) * 60.0 + pow( s, 8.0 ) * 0.35 );
        gl_FragColor = vec4( col, 1.0 );
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.scale.setScalar(1e5);   // 하늘은 카메라를 감싸기만 하면 된다
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * PMREM 용 별도 씬을 만든다.
 * 하늘 메시는 실제 하늘과 같은 재질(유니폼)을 공유하는 clone 을 원점에 두어,
 * 하늘이 거대하거나 카메라를 따라다니는 경우에도 큐브 카메라가 그 안에 들어오게 한다.
 * 원본의 스케일/회전은 그대로 두고 위치만 0 으로 맞춘다(스케일을 줄이면 구름 고도 같은
 * 월드 좌표 기반 효과가 왜곡되므로 건드리지 않고, 대신 fromScene 에 큰 far 를 넘긴다).
 */
function buildEnvScene(world, scene, sunDir) {
  const envScene = new THREE.Scene();
  const src = findSkyObject(world, scene);
  if (src) {
    const sky = src.clone(true);
    sky.visible = true;
    sky.frustumCulled = false;
    sky.position.set(0, 0, 0);
    envScene.add(sky);
  } else {
    envScene.add(makeGradientSky(sunDir));
  }
  // 하반구 지면 반사판: 하늘만 구우면 아래에서 올라오는 반사가 없어 금속과 수면이 어색해진다.
  // 색은 측정용(ENV_GROUND_MEASURE_COLOR)으로 만들고, PMREM 굽기 직전에 ENV_GROUND_COLOR 로 바꾼다.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(20000, 24),
    new THREE.MeshBasicMaterial({ color: ENV_GROUND_MEASURE_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -60;
  envScene.add(ground);
  return { envScene, hasSky: !!src, ground };
}

/** 하늘의 평균 선형 휘도를 측정한다(노출/블룸을 HDR 기준으로 맞추기 위해). 실패하면 0. */
function measureSkyLum(renderer, envScene) {
  const N = 16;
  let rt = null, sum = 0, cnt = 0;
  const prevRT = renderer.getRenderTarget();
  try {
    rt = new THREE.WebGLRenderTarget(N, N, { type: THREE.FloatType, depthBuffer: false, stencilBuffer: false });
    const cam = new THREE.PerspectiveCamera(75, 1, 1, 2.0e6);
    const buf = new Float32Array(N * N * 4);
    // 태양 쪽과 반대쪽을 섞어 '전형적인 시야'의 하늘 평균을 잡는다
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI * 0.5;
      cam.position.set(0, 0, 0);
      cam.lookAt(Math.cos(a), 0.4, Math.sin(a));   // 지평선 위로 살짝
      renderer.setRenderTarget(rt);
      renderer.render(envScene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
      for (let k = 0; k < buf.length; k += 4) {
        const L = 0.2126 * buf[k] + 0.7152 * buf[k + 1] + 0.0722 * buf[k + 2];
        if (Number.isFinite(L) && L >= 0) { sum += L; cnt++; }
      }
    }
  } catch (e) {
    cnt = 0;   // FLOAT 렌더 타깃/리드백 미지원 환경 → 상수 폴백
  } finally {
    if (rt) rt.dispose();
    renderer.setRenderTarget(prevRT);
  }
  return cnt > N * N * 2 ? sum / cnt : 0;
}

/**
 * three 의 Sky 셰이더 출력을 선형 HDR 로 되돌리는 래퍼를 world 의 하늘 재질에 건다.
 * 월드가 이미 걸어 둔 onBeforeCompile(지평선 안개 블렌드)은 그대로 보존하고 뒤에 덧붙인다.
 * uSkyLinExp=1, uSkyScale=1 이면 원본과 완전히 동일하므로 안전한 폴백이 된다.
 */
function installSkyLinearize(world) {
  const mesh = world && (world.skyMesh || world.sky);
  const mat = mesh && mesh.material;
  if (!mat || !mat.isShaderMaterial || !mat.uniforms || typeof mat.fragmentShader !== 'string') return null;
  // 셰이더의 vSunfade/지수와 같은 식: 1/(1.2 + 1.2*sunfade), 낮에는 1/2.4
  const sunY = world.sunDir ? world.sunDir.y : 0.6;
  const sunfade = 1 - THREE.MathUtils.clamp(1 - Math.exp(sunY / 450000), 0, 1);
  const invExp = 1.2 + 1.2 * sunfade;        // 인코딩 지수의 역(≈2.4)
  const uExp = { value: 1 };
  const uScale = { value: 1 };
  mat.uniforms.uSkyLinExp = uExp;
  mat.uniforms.uSkyScale = uScale;
  mat.userData.skyLinearized = false;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    const src = sh.fragmentShader;
    sh.fragmentShader = src
      .replace('uniform float mieDirectionalG;', 'uniform float mieDirectionalG;\nuniform float uSkyLinExp;\nuniform float uSkyScale;')
      .replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( pow( max( retColor, vec3( 0.0 ) ), vec3( uSkyLinExp ) ) * uSkyScale, 1.0 );');
    mat.userData.skyLinearized = sh.fragmentShader !== src && sh.fragmentShader.indexOf('uSkyLinExp') !== -1;
    if (mat.userData.skyLinearized && sh.uniforms) { sh.uniforms.uSkyLinExp = uExp; sh.uniforms.uSkyScale = uScale; }
  };
  mat.needsUpdate = true;
  return { uExp, uScale, invExp, ok: () => mat.userData.skyLinearized === true };
}

const $ = (id) => document.getElementById(id);
const setLoad = (t, p) => { $('load-text').textContent = t; $('load-bar').style.width = p + '%'; };
const nextFrame = () => new Promise((r) => setTimeout(r, 30));   // 백그라운드 탭에서도 진행되도록 rAF 대신 타이머

async function boot() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  // 캔버스 색공간은 sRGB. 다만 씬은 선형 HDR 렌더 타깃에 그려지고, three 는 렌더 타깃으로 그릴 때
  // 톤매핑과 출력 색공간 변환을 생략한다(WebGLPrograms: currentRenderTarget !== null → NoToneMapping / LinearSRGB).
  // 따라서 ACES 톤매핑과 sRGB 인코딩은 마지막 OutputPass 에서 정확히 한 번만 일어난다.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE_FALLBACK;   // 하늘 휘도 측정 후 재계산한다
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  $('view').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 600000);

  // 후처리: 반정밀도 HDR + MSAA 렌더 타깃.
  // samples 는 품질 단계별로 applyQuality 에서 바꾼다(0 이면 FXAA 로 안티앨리어싱).
  const rt = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType, samples: 4, depthBuffer: true, stencilBuffer: false,
  });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));

  // 블룸: 임계값/세기는 측정한 하늘 휘도 기준으로 잡는다(아래 calibrate 에서 덮어쓴다)
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, BLOOM_RADIUS, BLOOM_THRESHOLD_FALLBACK);
  bloom.highPassUniforms.smoothWidth.value = BLOOM_SMOOTH;   // 임계값 무릎을 넓게 → 깜빡임/밴딩 완화
  composer.addPass(bloom);
  // SSAO/GTAO 는 넣지 않는다: 지형 음영은 지형 메시가 미리 구워 두고(vShade), 비행 중에는 화면 대부분이
  // 하늘/먼 지형이라 비용 대비 이득이 없다(공통 브리프 4번 성능 예산).

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  const output = new OutputPass();   // 톤매핑 + sRGB 변환 (여기가 유일한 지점)
  composer.addPass(output);

  const fxaa = new ShaderPass(FXAAShader);   // MSAA 가 없는 단계(low)에서만 켠다
  fxaa.enabled = false;
  composer.addPass(fxaa);

  // ---------------- 환경맵(하늘 PMREM) 상태 ----------------
  let envRT = null, envReady = false, skyLum = 0;
  const envSun = new THREE.Vector3(0, 1, 0);
  const sunDirCur = new THREE.Vector3(0, 1, 0);
  let shadowTexel = (2 * SHADOW_HALF) / 2048;
  // 하늘 선형화 상태(부팅 시 skyLum/skyScale 이 채워진다)
  let skyLin = null, skyScale = 1;

  /** 하늘 휘도 기준으로 노출과 블룸 임계값을 다시 계산한다. */
  const calibrateHDR = () => {
    const lum = skyLum;
    const exposure = lum > 1e-4 ? THREE.MathUtils.clamp(EXPOSURE_K / lum, EXPOSURE_MIN, EXPOSURE_MAX) : EXPOSURE_FALLBACK;
    renderer.toneMappingExposure = exposure;
    bloom.threshold = lum > 1e-4
      ? THREE.MathUtils.clamp(lum * BLOOM_THRESHOLD_MULT, BLOOM_THRESHOLD_MIN, BLOOM_THRESHOLD_MAX)
      : BLOOM_THRESHOLD_FALLBACK;
    console.info(`[gfx] 하늘 평균 휘도 ${lum.toFixed(3)} → 노출 ${exposure.toFixed(3)}, 블룸 임계 ${bloom.threshold.toFixed(2)}`);
  };

  /**
   * 하늘에서 환경맵을 굽는다. 태양 방향이 그대로면 다시 굽지 않고(1회 생성),
   * 품질 변경과는 무관하다(해상도/샘플 수만 바뀌므로 재생성 불필요).
   */
  const rebuildEnvironment = (force = false) => {
    readSunDir(world, sunDirCur);
    if (envReady && !force && sunDirCur.dot(envSun) > 0.99995) return;
    const { envScene, hasSky, ground } = buildEnvScene(world, scene, sunDirCur);
    // (1) 원본(표시 인코딩된) 하늘의 평균 휘도. 이 값이 노출·블룸 임계값·지면 밝기의 기준이 된다
    if (skyLin) { skyLin.uExp.value = 1; skyLin.uScale.value = 1; }
    skyLum = measureSkyLum(renderer, envScene);
    // (2) 선형으로 되돌린 하늘의 평균을 재고, 평균 휘도가 (1)과 같아지도록 스케일을 상쇄한다.
    //     → 노출/블룸/지면 밝기는 그대로 두고 하늘의 채도와 계조만 정상화된다
    skyScale = 1;
    if (skyLin && skyLum > 1e-4) {
      skyLin.uExp.value = skyLin.invExp;
      const linLum = measureSkyLum(renderer, envScene);
      if (skyLin.ok() && linLum > 1e-4 && Number.isFinite(linLum)) {
        skyScale = THREE.MathUtils.clamp(skyLum / linLum, 0.02, 1);
        skyLin.uScale.value = skyScale;
        console.info(`[gfx] 하늘 선형화 적용: 지수 ${skyLin.invExp.toFixed(2)}, 스케일 ${skyScale.toFixed(3)} (평균 휘도 유지)`);
      } else {
        skyLin.uExp.value = 1;   // 패치 미적용/측정 실패 → 기존 동작 유지
        console.info('[gfx] 하늘 선형화 미적용(셰이더 패치 실패) — 기존 동작 유지');
      }
    }
    // (3) 측정이 끝난 뒤에야 하반구를 '햇빛 받은 지면' 휘도로 올린다.
    //     측정(1)(2)은 예전 색으로 했으므로 skyLum·노출·블룸 임계값은 수정 전과 완전히 같다.
    //     이 색은 PMREM 하반구에만 들어가므로 지형(법선 +Y 는 하반구를 코사인 가중 0 으로 받는다)
    //     과 지평선 위 하늘의 화면 모습도 바뀌지 않는다.
    if (ground) ground.material.color.setHex(ENV_GROUND_COLOR);
    const pmrem = new THREE.PMREMGenerator(renderer);
    if (pmrem.compileCubemapShader) pmrem.compileCubemapShader();
    // near/far: 하늘 메시의 스케일(수십만 단위)을 잘라내지 않도록 far 를 크게 준다.
    // 기본 far(100)로는 거대한 하늘 돔이 전부 클리핑되어 환경맵이 검게 나온다.
    const baked = pmrem.fromScene(envScene, ENV_SIGMA, 1, 2.0e6);
    pmrem.dispose();
    // 임시 씬에서 새로 만든 것만 정리한다(하늘 clone 은 원본의 지오메트리/재질을 공유하므로 건드리지 않는다)
    if (ground) { ground.geometry.dispose(); ground.material.dispose(); }
    if (envRT) envRT.dispose();
    envRT = baked;
    scene.environment = baked.texture;
    scene.environmentIntensity = ENV_INTENSITY;
    envSun.copy(sunDirCur);
    envReady = true;
    calibrateHDR();
    window.__gfx = {
      skyLum, exposure: renderer.toneMappingExposure, bloomThreshold: bloom.threshold,
      env: envReady, envSource: hasSky ? 'skyMesh' : 'gradient', envIntensity: ENV_INTENSITY,
      envGround: ENV_GROUND_COLOR,
      skyLinear: !!(skyLin && skyLin.ok() && skyLin.uExp.value !== 1), skyLinearExp: skyLin ? skyLin.invExp : 1, skyScale,
      passes: composer.passes.map((p) => p.constructor.name), toneMapping: 'ACESFilmic', outputColorSpace: 'srgb',
    };
    return baked;
  };

  setLoad('지형 생성 중 (120 km × 120 km)…', 20);
  await nextFrame();
  await preloadF15();
  const world = new World(scene, renderer);
  if (SKY_LINEARIZE) skyLin = installSkyLinearize(world);   // 환경맵 굽기 전에 하늘 재질을 선형화 모드로
  rebuildEnvironment(true);   // 하늘/태양 방향이 확정된 직후 1회 생성(이때 스케일까지 자동 상쇄)
  setLoad('기체와 시스템 초기화 중…', 75);
  await nextFrame();

  const effects = new Effects(scene);
  const audio = new AudioSys();
  const weapons = new Weapons(scene, effects, audio);
  const hud = new HUD($('hud'));
  const input = new Input(renderer.domElement);
  const game = new Game({ scene, camera, renderer, world, hud, audio, input, effects, weapons });

  // 계류장의 정적 F-15 (장식)
  const dummy = { surf: { de: 0, da: 0, dr: 0 }, flapPos: 0, gearPos: 1, sbPos: 0, steer: 0, gearContact: [0.1, 0.13, 0.13], engines: [{ ab: 0, n: 0, nozzle: 0.5 }, { ab: 0, n: 0, nozzle: 0.5 }] };
  for (let i = 0; i < 4; i++) {
    const m = buildF15({ cockpit: false });
    m.position.set(330, BASE_ELEV + 2.2 - 0.13, -150 + i * 70);
    m.rotation.y = Math.PI / 2;   // 활주로(서쪽)를 향함
    m.userData.update(dummy, 0, { stores: { aim9: i % 2 ? 4 : 0, aim120: i % 2 ? 4 : 0 }, lights: false });
    m.userData.parts.pilotGroup.visible = false;
    scene.add(m);
  }

  // ---------------- 그림자: 플레이어 주변에 촘촘히 맞춘다 ----------------
  const applyShadowQuality = (q) => {
    const sun = world.sun;
    if (!sun || !sun.shadow) return;   // 월드가 광원을 안 만들었으면 조용히 건너뛴다
    const sh = sun.shadow;
    if (sh.mapSize.x !== q.shadow) {
      sh.mapSize.set(q.shadow, q.shadow);
      if (sh.map) { sh.map.dispose(); sh.map = null; }   // 해상도 변경은 그림자 맵 재할당 필요
    }
    const sc = sh.camera;
    sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
    // near/far 를 초점 주변으로 좁혀 깊이 정밀도를 올린다(아크네의 근본 원인은 깊이 범위 과다)
    sc.near = Math.max(1, SHADOW_DIST - SHADOW_RANGE);
    sc.far = SHADOW_DIST + SHADOW_RANGE;
    sc.updateProjectionMatrix();
    shadowTexel = (2 * SHADOW_HALF) / q.shadow;
    // 바이어스는 텍셀 크기에 맞춰 잡는다(과하면 그림자가 떠 보이고, 모자라면 자기그림자 줄무늬).
    // normalBias 상한은 얇은 날개/조종석 틀이 들뜨지 않도록 둔다
    sh.bias = SHADOW_BIAS;
    sh.normalBias = THREE.MathUtils.clamp(shadowTexel * NORMAL_BIAS_TEXELS, 0.015, 0.08);
  };

  // 텍셀 스냅: 그림자 카메라 위치를 텍셀 격자에 맞춰 이동 시 가장자리 깜빡임을 없앤다
  const _lm = new THREE.Matrix4(), _lr = new THREE.Vector3(), _lu = new THREE.Vector3();
  const _focus = new THREE.Vector3(), _sunPos = new THREE.Vector3();
  const fitSunShadow = (focus, sunDirV) => {
    const sun = world.sun;
    if (!sun || !sun.shadow || !focus || !focus.isVector3) return;
    _sunPos.copy(focus).addScaledVector(sunDirV, SHADOW_DIST);
    _lm.lookAt(_sunPos, focus, UP_Y);              // 그림자 카메라의 right/up 기저
    _lr.setFromMatrixColumn(_lm, 0);
    _lu.setFromMatrixColumn(_lm, 1);
    const a = focus.dot(_lr), b = focus.dot(_lu);
    const sa = Math.round(a / shadowTexel) * shadowTexel;
    const sb = Math.round(b / shadowTexel) * shadowTexel;
    _focus.copy(focus).addScaledVector(_lr, sa - a).addScaledVector(_lu, sb - b);
    sun.target.position.copy(_focus);
    sun.position.copy(_focus).addScaledVector(sunDirV, SHADOW_DIST);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  };

  let quality = null;
  const applyQuality = (key) => {
    quality = QUALITY[key] || QUALITY.high;
    renderer.setPixelRatio(quality.pr);
    composer.setPixelRatio(quality.pr);   // 패스 해상도 = 창 크기 x pr (resize 에서 setSize 로 반영)
    bloom.enabled = quality.bloom > 0;
    bloom.strength = quality.bloom;
    // MSAA 샘플 수는 생성 후 바꿀 수 없어 타깃을 폐기 후 재할당한다
    for (const t of [composer.renderTarget1, composer.renderTarget2]) {
      if (t.samples !== quality.msaa) { t.samples = quality.msaa; t.dispose(); }
    }
    fxaa.enabled = quality.msaa === 0;   // MSAA 가 없는 단계만 FXAA
    grade.uniforms.uGrain.value = quality.grain * GRAIN_AMPLITUDE;
    applyShadowQuality(quality);
    resize();
    if (window.__gfx) Object.assign(window.__gfx, { quality: key, msaa: quality.msaa, shadowMapSize: quality.shadow, bloomStrength: quality.bloom, fxaa: fxaa.enabled });
  };
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);   // pixelRatio 는 applyQuality 가 설정한 값을 쓴다(패스 해상도도 함께 갱신됨)
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 픽셀 단위 해상도를 쓰는 패스 유니폼(그레인/ FXAA 텍셀 크기)을 같이 맞춘다
    const pr = renderer.getPixelRatio();
    const bw = Math.max(1, Math.round(w * pr)), bh = Math.max(1, Math.round(h * pr));
    grade.uniforms.uResolution.value.set(bw, bh);
    fxaa.uniforms.resolution.value.set(1 / bw, 1 / bh);
    hud.resize(w, h);
  };
  window.addEventListener('resize', resize);

  // 월드 갱신 직후 태양 그림자 카메라를 플레이어 주변으로 맞춘다.
  // (world.update 가 매 프레임 광원 위치를 잡으므로 감싸서 그 뒤에 스냅 결과로 덮어쓴다)
  const baseWorldUpdate = world.update.bind(world);
  world.update = (dt, focus, camAlt) => {
    baseWorldUpdate(dt, focus, camAlt);
    readSunDir(world, sunDirCur);
    if (envReady && sunDirCur.dot(envSun) < 0.99995) rebuildEnvironment(true);   // 태양이 움직인 경우에만 재생성
    fitSunShadow(focus, sunDirCur);
    // 필름 그레인 위상을 갱신한다(24Hz 로 양자화해 필름 같은 느낌을 준다)
    grade.uniforms.uTime.value = Math.floor(performance.now() / 41.667) % 2048;
  };
  resize();

  // ---------------- UI ----------------
  let lastMode = 'bfm';
  let menuOpen = true;
  const opts = () => ({
    difficulty: document.querySelector('input[name=diff]:checked').value,
    scheme: document.querySelector('input[name=scheme]:checked').value,
    cas: $('opt-cas').checked, gEffects: $('opt-g').checked, infiniteFuel: $('opt-fuel').checked, infiniteAmmo: $('opt-ammo').checked, sound: $('opt-sound').checked,
    cockpitOnly: $('opt-cockpit').checked, targetToggle: $('opt-target-toggle').checked,
    sens: parseFloat($('opt-sens').value), invertY: $('opt-invert').checked, quality: $('opt-quality').value,
  });
  // 저장된 설정 복원
  const saved = loadSettings();
  if (saved.difficulty) { const el = document.querySelector(`input[name=diff][value=${saved.difficulty}]`); if (el) el.checked = true; }
  if (saved.scheme) { const el = document.querySelector(`input[name=scheme][value=${saved.scheme}]`); if (el) el.checked = true; }
  for (const [id, key] of [['opt-cas', 'cas'], ['opt-g', 'gEffects'], ['opt-fuel', 'infiniteFuel'], ['opt-ammo', 'infiniteAmmo'], ['opt-sound', 'sound'], ['opt-invert', 'invertY'], ['opt-cockpit', 'cockpitOnly'], ['opt-target-toggle', 'targetToggle']]) if (key in saved) $(id).checked = saved[key];
  if (saved.sens) $('opt-sens').value = saved.sens;
  if (saved.quality) $('opt-quality').value = saved.quality;
  const syncOptions = () => {
    const o = opts();
    input.scheme = o.scheme; input.sens = o.sens; input.invertY = o.invertY; input.targetToggle = o.targetToggle;
    $('sens-val').textContent = o.sens.toFixed(1) + '×';
    for (const k of ['bf', 'bfmouse', 'classic', 'custom']) $('keys-' + k).classList.toggle('hidden', o.scheme !== k);
    if (o.scheme === 'custom') renderCustomKeys(input, $('keys-custom'));
    document.querySelectorAll('.bf-only').forEach((el) => el.classList.toggle('dim', o.scheme === 'classic'));
    document.querySelectorAll('.mouse-only').forEach((el) => el.classList.toggle('dim', !input.mouseFlight));
    $('bfm-wpn').textContent = MISSILE_DIFFS.has(o.difficulty) ? '· 미사일 + 기관포' : '· 기관포';
    if (!input.mouseFlight) input.releaseLock();
    if (QUALITY[o.quality] !== quality) applyQuality(o.quality);
    saveSettings(o);
  };
  document.querySelectorAll('.menu-box input, .menu-box select').forEach((el) => el.addEventListener('input', syncOptions));
  // 커스텀 키·마우스 설정 화면 (열면 조작 방식을 커스텀으로)
  const keybind = setupKeybind(input, { sens: $('opt-sens'), invert: $('opt-invert') }, syncOptions);
  $('btn-keybind').addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelector('input[name=scheme][value=custom]').checked = true;
    syncOptions();
    keybind.open();
  });
  const startMode = (mode) => {
    lastMode = mode;
    audio.init(); audio.resume();
    syncOptions();
    const o = opts();
    audio.setEnabled(o.sound);
    game.start(mode, o);
    ['menu', 'pause', 'end', 'help'].forEach((id) => $(id).classList.add('hidden'));
    menuOpen = false;
    input.wantLock = true;
    if (input.mouseFlight) input.requestLock();
    renderer.domElement.focus();
  };
  const showMenu = () => {
    input.wantLock = false; input.releaseLock();
    menuOpen = true;
    game.running = false;
    audio.silence();   // 메뉴 루프에서는 audio.update 가 돌지 않으므로 엔진음 등을 직접 끈다
    ['pause', 'end', 'help'].forEach((id) => $(id).classList.add('hidden'));
    $('menu').classList.remove('hidden');
    game.start('runway', opts());
    game.running = false;
  };
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => startMode(b.dataset.mode)));
  $('btn-restart').onclick = () => startMode(lastMode);
  $('btn-menu').onclick = showMenu;
  $('btn-end-restart').onclick = () => startMode(lastMode);
  $('btn-end-menu').onclick = showMenu;
  game.onPause = (p) => {
    $('pause').classList.toggle('hidden', !p);
    input.wantLock = !p;
    if (p) input.releaseLock(); else if (input.mouseFlight) input.requestLock();
  };
  $('btn-resume').onclick = () => { game.paused = false; game.onPause(false); };
  game.onHelp = () => {
    const h = $('help'); const show = h.classList.contains('hidden');
    h.classList.toggle('hidden', !show); game.paused = show;
    input.wantLock = !show;
    if (show) input.releaseLock(); else if (input.mouseFlight) input.requestLock();
  };
  $('btn-help-close').onclick = () => game.onHelp();
  // 포인터 록이 풀리면(Esc 등) 배틀필드처럼 일시정지
  input.onLockLost = () => {
    input.lockLostAt = performance.now();
    if (!menuOpen && game.running && !game.paused && input.mouseFlight && $('end').classList.contains('hidden') && $('help').classList.contains('hidden')) {
      game.paused = true; game.onPause(true);
    }
  };
  game.onEnd = (sum) => {
    input.wantLock = false; input.releaseLock();
    $('end-title').textContent = sum.title;
    $('end-reason').textContent = sum.reason;
    const mm = Math.floor(sum.time / 60), ss = Math.floor(sum.time % 60);
    $('end-stats').textContent = `비행 시간 ${mm}분 ${ss}초 · 최대 하중 ${sum.maxG.toFixed(1)} G` + (sum.mode === 'bfm' ? `\n1:1 ${game.bfmMissiles ? '공중전' : '기총전'} · 격추 ${sum.kills}대` : '');
    $('end').classList.remove('hidden');
  };
  window.addEventListener('keydown', (e) => {
    if (keybind.isOpen) return;
    if (e.code === 'Enter' && !$('end').classList.contains('hidden')) startMode(lastMode);
  });

  // 창을 닫거나 새로고침할 때 진행 중이던 대결 기록 저장
  addEventListener('pagehide', () => game.rec?.flush('abort', true));

  // 메뉴 배경: 활주로의 기체
  syncOptions();
  game.start('runway', opts());
  game.running = false;
  setLoad('완료', 100);
  await nextFrame();
  $('loading').classList.add('hidden');
  $('menu').classList.remove('hidden');

  // ---------------- 루프 ----------------
  const clock = new THREE.Clock();
  let menuT = 0, fpsT = 0, frames = 0;
  window.__game = game;
  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (menuOpen) {
      menuT += dt;
      const p = game.player;
      game.updateAircraftState(0);
      const r = 26, a = menuT * 0.12 + 2.2;
      camera.position.set(p.fm.pos.x + Math.sin(a) * r, p.fm.pos.y + 3 + Math.sin(menuT * 0.2) * 1.2, p.fm.pos.z + Math.cos(a) * r);
      camera.lookAt(p.fm.pos.x, p.fm.pos.y + 0.5, p.fm.pos.z);
      if (camera.fov !== 50) { camera.fov = 50; camera.updateProjectionMatrix(); }
      world.update(dt, p.fm.pos, camera.position.y);
      effects.update(dt, world, window.innerHeight, camera.fov * Math.PI / 180);
      camera.updateMatrixWorld();
      world.updateCamera(camera);
      if (window.innerWidth > 0 && window.innerHeight > 0) composer.render(dt);   // 창 크기 0(최소화 등)이면 렌더 생략
      hud.ctx.setTransform(1, 0, 0, 1, 0, 0);
      hud.ctx.clearRect(0, 0, hud.cv.width, hud.cv.height);
      input.endFrame();
      return;
    }
    input.update(dt, game.player ? game.player.fm.ctl.throttle : 0);
    game.update(dt);
    const focus = game.player.fm.pos;
    world.update(dt, focus, camera.position.y);
    effects.update(game.paused ? 0 : dt, world, window.innerHeight, camera.fov * Math.PI / 180);
    world.updateCamera(camera);
    if (window.innerWidth > 0 && window.innerHeight > 0) composer.render(dt);
    hud.draw(game, camera, dt);
    $('damage-flash').style.opacity = Math.min(1, game.flashDamage * 2).toFixed(2);
    input.endFrame();
    frames++; fpsT += dt;
    if (fpsT > 1) { window.__fps = frames / fpsT; frames = 0; fpsT = 0; }
  }
  frame();

  // ?debug 전용: 고정 간격으로 시뮬레이션 진행 + 화면 캡처 (백그라운드 탭 검증용)
  if (new URLSearchParams(location.search).has('debug')) {
    window.__dbg = {
      advance(secs, fn) {
        for (let i = 0, n = Math.round(secs * 60); i < n; i++) {
          if (fn) fn(game, i / 60);
          input.update(1 / 60, game.player.fm.ctl.throttle);
          if (menuOpen) game.updateAircraftState(0); else game.update(1 / 60);
          world.update(1 / 60, game.player.fm.pos, camera.position.y);
          effects.update(1 / 60, world, window.innerHeight, camera.fov * Math.PI / 180);
          input.endFrame();
        }
      },
      async shot(name) {
        camera.updateMatrixWorld();
        world.updateCamera(camera);
        composer.render(1 / 60);
        if (!menuOpen) hud.draw(game, camera, 1 / 60);
        const src = renderer.domElement, c = document.createElement('canvas');
        c.width = src.width; c.height = src.height;
        const g = c.getContext('2d');
        g.drawImage(src, 0, 0); if (!menuOpen) g.drawImage(hud.cv, 0, 0, c.width, c.height);
        await fetch('/__shot?name=' + encodeURIComponent(name), { method: 'POST', body: c.toDataURL('image/jpeg', 0.92) });
      },
      start: (m) => startMode(m),
      input, composer, world, camera, gfx: window.__gfx,
    };
  }
}

boot().catch((e) => {
  console.error(e);
  $('load-text').textContent = '오류: ' + e.message;
});
