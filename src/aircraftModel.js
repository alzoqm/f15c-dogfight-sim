// 절차적 F-15C 3D 모델 (실치수, m). 로컬 좌표: 기수 -Z, 위 +Y, 우측 +X, 원점 = 무게중심
// 움직이는 조종면(에일러론/플랩/스태빌레이터/러더/스피드브레이크), 랜딩기어, 애프터버너 화염 포함
import * as THREE from 'three';
import { clamp, lerp, mulberry32 } from './math.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// 공력좌표 (x 전방, y 우측, z 위) → three 로컬
const P = (x, y, z) => new THREE.Vector3(y, z, -x);

// ---------------- 텍스처 ----------------
// 높이 캔버스를 노멀맵으로 변환 (소벨 방식, 타일 래핑)
function heightToNormal(src, strength = 2.2) {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  const out = c.createImageData(w, h);
  const hv = (x, y) => sd[((((y + h) % h) * w) + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (hv(x - 1, y) - hv(x + 1, y)) * strength;
      const dy = (hv(x, y - 1) - hv(x, y + 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * w + x) * 4;
      out.data[o] = (-dx * inv * 0.5 + 0.5) * 255;
      out.data[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      out.data[o + 2] = (inv * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  c.putImageData(out, 0, 0);
  return cv;
}

// USAF 에어 슈페리어리티 블루 2톤 위장 + 패널/리벳/풍화 (map + normalMap + roughnessMap)
function makeSkinMaps(seed, paint) {
  const S = 1024; // 논리 해상도 (아래 그리기 코드는 그대로)
  const TS = 2048; // 실제 텍스처 해상도
  const cv = document.createElement('canvas');
  cv.width = cv.height = TS;
  const c = cv.getContext('2d');
  c.scale(TS / S, TS / S); // 이후 그리기는 1024 좌표계, 출력은 2048
  const rnd = mulberry32(seed);
  const aggr = paint === 'aggressor';
  // 기본 2톤: 밝은 쪽과 어두운 쪽
  // 밝은 청회색 2톤 (FS 36375 밝은 회청 / FS 36251 중간 회색 느낌)
  const light = aggr ? '#b3a284' : '#7f8a96';
  const dark = aggr ? '#7d7f6e' : '#646f7b';
  c.fillStyle = light;
  c.fillRect(0, 0, S, S);
  // 위장 무늬: 큰 불규칙 다각형 덩어리 (보로노이 영역 분할, 일부 영역만 진한 색)
  // 타일 래핑을 위해 지터 그리드 + 래핑 거리로 영역을 가름
  {
    const G = 4, VN = 256;
    const vrnd = mulberry32(seed * 31 + 7);
    const jx = new Float64Array(G * G), jy = new Float64Array(G * G), jd = new Uint8Array(G * G);
    for (let k = 0; k < G * G; k++) {
      jx[k] = 0.15 + vrnd() * 0.7;
      jy[k] = 0.15 + vrnd() * 0.7;
      jd[k] = vrnd() < 0.45 ? 1 : 0;
    }
    const vcv = document.createElement('canvas');
    vcv.width = vcv.height = VN;
    const vx = vcv.getContext('2d');
    const img = vx.createImageData(VN, VN);
    const px = img.data;
    const lc = [parseInt(light.slice(1, 3), 16), parseInt(light.slice(3, 5), 16), parseInt(light.slice(5, 7), 16)];
    const dc = [parseInt(dark.slice(1, 3), 16), parseInt(dark.slice(3, 5), 16), parseInt(dark.slice(5, 7), 16)];
    const cell = VN / G, half = VN / 2;
    for (let iy = 0; iy < VN; iy++) {
      const cy0 = Math.floor(iy / cell);
      for (let ix = 0; ix < VN; ix++) {
        const cx0 = Math.floor(ix / cell);
        let best = Infinity, darkWin = 0;
        for (let ay = -1; ay <= 1; ay++) {
          const gy = (((cy0 + ay) % G) + G) % G;
          for (let ax = -1; ax <= 1; ax++) {
            const gx = (((cx0 + ax) % G) + G) % G;
            const k = gy * G + gx;
            let sx = (gx + jx[k]) * cell - ix;
            let sy = (gy + jy[k]) * cell - iy;
            if (sx > half) sx -= VN; else if (sx < -half) sx += VN;
            if (sy > half) sy -= VN; else if (sy < -half) sy += VN;
            const d2 = sx * sx + sy * sy;
            if (d2 < best) { best = d2; darkWin = jd[k]; }
          }
        }
        const o = (iy * VN + ix) * 4;
        const cc = darkWin ? dc : lc;
        px[o] = cc[0]; px[o + 1] = cc[1]; px[o + 2] = cc[2]; px[o + 3] = 255;
      }
    }
    vx.putImageData(img, 0, 0);
    // 256 → 1024 논리(2048 실제) 확대: 경계가 약 8px 부드럽게 섞임
    c.imageSmoothingEnabled = true;
    c.drawImage(vcv, 0, 0, S, S);
  }
  // 저주파 색 번짐만 약하게 (햇빛 바램 느낌)
  for (let i = 0; i < 36; i++) {
    const x = rnd() * S, y = rnd() * S, r = 60 + rnd() * 120;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const warm = rnd() < 0.5;
    g.addColorStop(0, warm ? 'rgba(255,250,235,0.03)' : 'rgba(40,55,65,0.03)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 높이(패널 홈) 캔버스 + 거칠기 캔버스
  const H = 512;
  const hcv = document.createElement('canvas');
  hcv.width = hcv.height = H;
  const hc = hcv.getContext('2d');
  hc.fillStyle = '#ffffff';
  hc.fillRect(0, 0, H, H);
  const rcv = document.createElement('canvas');
  rcv.width = rcv.height = H;
  const rc = rcv.getContext('2d');
  rc.fillStyle = '#b3b3b3'; // 기본 거칠기 0.7 (아랫면 무광)
  rc.fillRect(0, 0, H, H);

  // 구조적인 패널선: 프레임(가로) + 론저론(세로), 성기게 가늘고 은은하게
  const frames = [];
  for (let i = 0; i < 7; i++) frames.push(((i + 0.3 + rnd() * 0.4) * H) / 7);
  const longerons = [];
  for (let i = 0; i < 6; i++) longerons.push(((i + 0.3 + rnd() * 0.4) * H) / 6);
  const drawPanelSet = (ctx, lineStyle, lw) => {
    ctx.strokeStyle = lineStyle;
    ctx.lineWidth = lw;
    for (const p of frames) { ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(H, p); ctx.stroke(); }
    for (const p of longerons) { ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.stroke(); }
  };
  // 색상 맵 패널선
  drawPanelSet(c, 'rgba(35,42,48,0.2)', 1);
  // 높이 맵 패널 홈 (얕게)
  drawPanelSet(hc, '#8a8a8a', 1);
  // 접근 패널 (사각 + 원형, 적게)
  const rects = [];
  for (let i = 0; i < 12; i++) rects.push([rnd() * H, rnd() * H, 20 + rnd() * 50, 14 + rnd() * 34]);
  const circles = [];
  for (let i = 0; i < 7; i++) circles.push([rnd() * H, rnd() * H, 6 + rnd() * 12]);
  for (const [ctx, stroke, lw] of [[c, 'rgba(35,42,48,0.2)', 1], [hc, '#8a8a8a', 1]]) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    for (const [x, y, w, h] of rects) ctx.strokeRect(x, y, w, h);
    for (const [x, y, r] of circles) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
  }
  // 리벳 없음 (멀리서 매끈하게 보이도록 생략)
  // 저주파 그을음만 살짝 (거칠기 맵 위주)
  for (let i = 0; i < 10; i++) {
    const x = rnd() * H, y = rnd() * H, len = 40 + rnd() * 120, w = 6 + rnd() * 14;
    const g = rc.createLinearGradient(x, y, x + len, y);
    g.addColorStop(0, 'rgba(110,110,110,0.35)');
    g.addColorStop(1, 'rgba(110,110,110,0)');
    rc.fillStyle = g;
    rc.fillRect(x, y, len, w);
  }

  const map = new THREE.CanvasTexture(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const ncv = heightToNormal(hcv, 0.8);
  const normalMap = new THREE.CanvasTexture(ncv);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.anisotropy = 8;
  const roughnessMap = new THREE.CanvasTexture(rcv);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  return { map, normalMap, roughnessMap };
}

// 노즐 열변색 그라데이션 (청동 → 자주 → 청색)
function makeNozzleMaps() {
  const W = 256, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  // 캔버스 위(v=1)가 노즐 출구: 출구는 짙은 그을음으로 어둡게
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.0, '#211a15');
  g.addColorStop(0.35, '#3d4a63');
  g.addColorStop(0.6, '#5d4a52');
  g.addColorStop(0.85, '#6e5a44');
  g.addColorStop(1.0, '#544334');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  // 페탈 이음 음영
  c.fillStyle = 'rgba(0,0,0,0.35)';
  for (let x = 0; x < W; x += Math.round(W / 15)) c.fillRect(x, 0, 2, H);
  // 그을음 얼룩
  const rnd = mulberry32(7);
  for (let i = 0; i < 120; i++) {
    c.fillStyle = `rgba(15,12,10,${0.05 + rnd() * 0.12})`;
    c.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 8, 1 + rnd() * 3);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 계기판 MFD 화면 (발광 텍스처)
function makeMfdTexture(seed) {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const c = cv.getContext('2d');
  const rnd = mulberry32(seed);
  c.fillStyle = '#06120c';
  c.fillRect(0, 0, 128, 128);
  c.strokeStyle = '#2aff7a';
  c.lineWidth = 2;
  c.strokeRect(4, 4, 120, 120);
  c.strokeStyle = '#1fd465';
  c.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    c.beginPath();
    c.moveTo(10, 20 + i * 16);
    c.lineTo(10 + 30 + rnd() * 80, 20 + i * 16);
    c.stroke();
  }
  c.beginPath();
  c.arc(88, 88, 22, 0, Math.PI * 2);
  c.stroke();
  c.beginPath();
  c.moveTo(88, 88);
  c.lineTo(88 + 14, 88 - 8);
  c.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 계기판 레이더 화면 (부채꼴 소인 + 거리 고리, 가운데 MFD용)
function makeRadarTexture(seed) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  const rnd = mulberry32(seed);
  c.fillStyle = '#06120c';
  c.fillRect(0, 0, 128, 128);
  c.strokeStyle = '#2aff7a';
  c.lineWidth = 2;
  c.strokeRect(4, 4, 120, 120);
  // 거리 고리 + 부채꼴 방위선
  c.strokeStyle = '#1fd465';
  c.lineWidth = 1;
  for (const r of [18, 32, 46]) { c.beginPath(); c.arc(64, 110, r, Math.PI * 1.15, Math.PI * 1.85); c.stroke(); }
  for (let i = -2; i <= 2; i++) {
    const a = -Math.PI / 2 + i * 0.28;
    c.beginPath(); c.moveTo(64, 110);
    c.lineTo(64 + Math.cos(a) * 48, 110 + Math.sin(a) * 48); c.stroke();
  }
  // 소인선 + 블립
  c.strokeStyle = '#7dffb0';
  c.beginPath(); c.moveTo(64, 110); c.lineTo(64 + 30, 110 - 34); c.stroke();
  c.fillStyle = '#2aff7a';
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (rnd() - 0.5) * 1.6, r = 12 + rnd() * 32;
    c.fillRect(64 + Math.cos(a) * r - 1, 110 + Math.sin(a) * r - 1, 3, 3);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 흡입구 램프면 (위 밝은 회색에서 아래 검정으로 짙어짐)
function makeRampTexture() {
  const W = 64, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.0, '#8b9094');
  g.addColorStop(0.45, '#4a4e52');
  g.addColorStop(1.0, '#060707');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 터빈면 (노즐 안쪽 어두운 회전날개 느낌)
function makeTurbineTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.fillStyle = '#0b0a09';
  c.fillRect(0, 0, S, S);
  c.translate(S / 2, S / 2);
  for (let i = 0; i < 24; i++) {
    c.rotate((Math.PI * 2) / 24);
    const g = c.createLinearGradient(0, 0, 0, S / 2);
    g.addColorStop(0, '#3a3a3c');
    g.addColorStop(1, '#101012');
    c.fillStyle = g;
    c.fillRect(-2, 6, 4, S / 2 - 10);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function textTexture(lines, w = 256, h = 128, color = '#1d2328', font = 'bold 44px Arial') {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.fillStyle = color;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  lines.forEach((ln, i) => { c.font = ln.font || font; c.fillText(ln.text, w / 2, (h / (lines.length + 1)) * (i + 1)); });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 미군 성조기 + 바 (간략 성조 문양)
function starBarsTexture() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, 256, 128);
  // 좌우 바
  c.fillStyle = '#f2f3f0';
  c.fillRect(8, 44, 76, 40);
  c.fillRect(172, 44, 76, 40);
  c.fillStyle = '#2b3a67';
  c.fillRect(8, 44, 76, 9);
  c.fillRect(8, 75, 76, 9);
  c.fillRect(172, 44, 76, 9);
  c.fillRect(172, 75, 76, 9);
  // 중앙 원 + 별
  c.fillStyle = '#f2f3f0';
  c.beginPath(); c.arc(128, 64, 32, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#2b3a67';
  c.beginPath(); c.arc(128, 64, 29, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#f2f3f0';
  c.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 4) / 5;
    const px = 128 + Math.cos(a) * 22, py = 64 + Math.sin(a) * 22;
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath(); c.fill();
  // 빨간 테두리 (저시인성 표시의 붉은 외곽선 느낌)
  c.strokeStyle = '#8a2a22';
  c.lineWidth = 3;
  c.beginPath(); c.arc(128, 64, 31, 0, Math.PI * 2); c.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function glowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner); g.addColorStop(0.25, inner.replace(/[\d.]+\)$/, '0.6)')); g.addColorStop(1, outer);
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

// ---------------- 형상 생성기 ----------------
/** 초타원 단면 로프트. stations: [x, halfWidth, heightTop, heightBottom, zCenter, exponent] */
function loft(stations, segs = 40, uvScale = 3) {
  const ring = segs + 1, pos = [], uv = [], idx = [];
  for (let i = 0; i < stations.length; i++) {
    const [x, w, ht, hb, zc, n] = stations[i];
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * Math.PI * 2, co = Math.cos(th), si = Math.sin(th);
      const y = w * Math.sign(co) * Math.pow(Math.abs(co), 2 / n);
      const z = zc + (si >= 0 ? ht : hb) * Math.sign(si) * Math.pow(Math.abs(si), 2 / n);
      const p = P(x, y, z);
      pos.push(p.x, p.y, p.z);
      uv.push((k / segs) * 2.5, x / uvScale);
    }
  }
  for (let i = 0; i < stations.length - 1; i++) {
    for (let k = 0; k < segs; k++) {
      const a = i * ring + k, b = (i + 1) * ring + k, cc = (i + 1) * ring + k + 1, d = i * ring + k + 1;
      idx.push(a, d, b, b, d, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 양력면(날개/미익) 생성. rootLE/rootTE/tipLE/tipTE: 공력좌표 [x,y,z], tdir: 두께 방향(공력좌표),
 * thick: [뿌리, 끝] 두께비, 범위 u(시위)∈[u0,u1], v(스팬)∈[v0,v1], origin: 빼줄 기준점(힌지)
 */
function surface(o) {
  const { rootLE, rootTE, tipLE, tipTE, tdir, thick, u0 = 0, u1 = 1, v0 = 0, v1 = 1, nu = 12, nv = 6, origin = null, camber = 0.8 } = o;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const prof = (u) => 4 * (Math.sqrt(Math.max(u, 0)) - u);   // 최대 1 @ u=0.25
  const pts = (u, v, side) => {
    const le = lerp3(rootLE, tipLE, v), te = lerp3(rootTE, tipTE, v);
    const p = lerp3(le, te, u);
    const chord = Math.hypot(te[0] - le[0], te[1] - le[1], te[2] - le[2]);
    const t = 0.5 * lerp(thick[0], thick[1], v) * chord * prof(u) * (side > 0 ? 1 : camber);
    let x = p[0] + tdir[0] * t * side, y = p[1] + tdir[1] * t * side, z = p[2] + tdir[2] * t * side;
    if (origin) { x -= origin[0]; y -= origin[1]; z -= origin[2]; }
    const q = P(x, y, z);
    return [q.x, q.y, q.z];
  };
  const pos = [], uv = [], idx = [];
  const W = nu + 1;
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      const v = lerp(v0, v1, j / nv);
      for (let i = 0; i <= nu; i++) {
        const u = lerp(u0, u1, i / nu);
        const p = pts(u, v, side);
        pos.push(...p);
        uv.push(p[2] / 3, p[0] / 3);
      }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * W + i, b = base + j * W + i + 1, cc = base + (j + 1) * W + i + 1, d = base + (j + 1) * W + i;
      if (side > 0) idx.push(a, b, d, b, cc, d); else idx.push(a, d, b, b, d, cc);
    }
  }
  // 가장자리 (앞쪽 절단면 u0, 뒤쪽 u1, 뿌리 v0, 끝 v1, UV는 면과 연속되게)
  const edge = (list) => {
    const base = pos.length / 3;
    for (const [u, v] of list) {
      const q1 = pts(u, v, 1), q2 = pts(u, v, -1);
      pos.push(...q1); uv.push(q1[2] / 3, q1[0] / 3);
      pos.push(...q2); uv.push(q2[2] / 3, q2[0] / 3);
    }
    for (let k = 0; k < list.length - 1; k++) { const a = base + k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  };
  const along = (fixedU, fixedV) => {
    const l = [];
    if (fixedU !== null) for (let j = 0; j <= nv; j++) l.push([fixedU, lerp(v0, v1, j / nv)]);
    else for (let i = 0; i <= nu; i++) l.push([lerp(u0, u1, i / nu), fixedV]);
    return l;
  };
  if (u0 > 0.001) edge(along(u0, null));
  edge(along(null, v0));
  edge(along(null, v1));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 표면 위 한 점 (힌지 계산용) */
function surfPoint(o, u, v) {
  const l = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  return l(l(o.rootLE, o.tipLE, v), l(o.rootTE, o.tipTE, v), u);
}

/** 조종면: 힌지축을 중심으로 회전하는 Object3D 반환. 양의 각 = 뒷전이 아래(+tdir 반대)/우측 */
function controlSurface(spec, u0, v0, v1, mat, flipAxis = false) {
  const h0 = surfPoint(spec, u0, v0), h1 = surfPoint(spec, u0, v1);
  const geo = surface({ ...spec, u0, u1: 1, v0, v1, nu: 6, nv: 4, origin: h0 });
  const mesh = new THREE.Mesh(geo, mat);
  const pivot = new THREE.Object3D();
  pivot.position.copy(P(...h0));
  const axis = P(...h1).sub(P(...h0)).normalize();
  if (flipAxis ? axis.y < 0 : axis.x < 0) axis.negate();
  pivot.userData.axis = axis;
  pivot.add(mesh);
  mesh.castShadow = mesh.receiveShadow = true;
  return pivot;
}

// 미사일 핀 (얇은 사다리꼴 판: x 시위, y 스팬)
function missileFin(span, chordRoot, chordTip, thick, mat) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(chordRoot, 0);
  shape.lineTo(chordRoot - (chordRoot - chordTip) / 2, span);
  shape.lineTo((chordRoot - chordTip) / 2, span);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

/** 기종별 미사일 외형. type: AIM-9X/AIM-9/AIM-120C/AIM-120/MRM/R-73/R-77 */
function makeMissileMesh(type, mats) {
  const t = String(type || 'AIM-9');
  const kind = (t === 'R-73') ? 'R73' : (t === 'R-77') ? 'R77'
    : (t === 'AIM-120' || t === 'AIM-120C' || t === 'MRM') ? 'A120' : 'A9X';
  const M = mats || {};
  const matBody = M.missile || new THREE.MeshStandardMaterial({ color: 0xdedfdc, roughness: 0.5, metalness: 0.2 });
  const matSeeker = M.seeker || new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.1, metalness: 0.6 });
  const matBand = M.band || new THREE.MeshStandardMaterial({ color: 0xd6b23a, roughness: 0.5 });
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  let L;
  if (kind === 'A120') {
    // AIM-120C: 가늘고 긴 탄체, 잘린 삼각 핀
    L = 3.65;
    const r = 0.089;
    const body = add(new THREE.CylinderGeometry(r, r, L * 0.86, 16), matBody, 0, 0, L * 0.02);
    body.rotation.x = Math.PI / 2;
    const nose = add(new THREE.ConeGeometry(r, L * 0.14, 16), matBody, 0, 0, -L * 0.5 + L * 0.07);
    nose.rotation.x = -Math.PI / 2;
    const tip = add(new THREE.SphereGeometry(r * 0.35, 8, 6), matSeeker, 0, 0, -L * 0.5);
    tip.scale.z = 1.6;
    const band = add(new THREE.CylinderGeometry(r * 1.015, r * 1.015, 0.09, 16), matBand, 0, 0, -L * 0.28);
    band.rotation.x = Math.PI / 2;
    const stripe = add(new THREE.CylinderGeometry(r * 1.01, r * 1.01, 0.05, 16), matSeeker, 0, 0, L * 0.3);
    stripe.rotation.x = Math.PI / 2;
    // 전방 조종익 4장 (작은 클립 삼각)
    for (let kIdx = 0; kIdx < 4; kIdx++) {
      const a = (kIdx / 4) * Math.PI * 2;
      const f = missileFin(0.14, 0.22, 0.1, 0.008, matBody);
      f.position.set(Math.cos(a) * r, Math.sin(a) * r, -L * 0.28);
      f.rotation.z = a - Math.PI / 2;
      f.rotation.y = Math.PI / 2;
      g.add(f);
      const f2 = missileFin(0.2, 0.3, 0.12, 0.01, matBody);
      f2.position.set(Math.cos(a) * r, Math.sin(a) * r, L * 0.38);
      f2.rotation.z = a - Math.PI / 2;
      f2.rotation.y = Math.PI / 2;
      g.add(f2);
    }
    const noz = add(new THREE.CylinderGeometry(r * 0.8, r * 0.9, 0.12, 16, 1, true), matSeeker, 0, 0, L * 0.5);
    noz.rotation.x = Math.PI / 2;
  } else if (kind === 'R77') {
    // R-77: 굵은 탄체 + 격자 핀(래티스) 꼬리
    L = 3.6;
    const r = 0.1;
    const body = add(new THREE.CylinderGeometry(r, r, L * 0.84, 16), matBody, 0, 0, L * 0.02);
    body.rotation.x = Math.PI / 2;
    const nose = add(new THREE.SphereGeometry(r, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), matBody, 0, 0, -L * 0.4);
    nose.rotation.x = -Math.PI / 2;
    nose.scale.z = 1.8;
    const band = add(new THREE.CylinderGeometry(r * 1.015, r * 1.015, 0.08, 16), matBand, 0, 0, -L * 0.2);
    band.rotation.x = Math.PI / 2;
    // 전방 소형 핀
    for (let kIdx = 0; kIdx < 4; kIdx++) {
      const a = (kIdx / 4) * Math.PI * 2 + Math.PI / 4;
      const f = missileFin(0.16, 0.2, 0.1, 0.01, matBody);
      f.position.set(Math.cos(a) * r, Math.sin(a) * r, -L * 0.22);
      f.rotation.z = a - Math.PI / 2;
      f.rotation.y = Math.PI / 2;
      g.add(f);
    }
    // 격자 꼬리날개: 기체축-반경 평면의 사각 틀 + 촘촘한 격자 막대
    for (let kIdx = 0; kIdx < 4; kIdx++) {
      const a = (kIdx / 4) * Math.PI * 2;
      const grid = new THREE.Group();
      const w = 0.3, h = 0.26, bar = 0.012;
      const mkBar = (by, bz, hgt, wid) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(bar, hgt, wid), matBody);
        m.position.set(0, by, bz);
        m.castShadow = true;
        grid.add(m);
      };
      mkBar(h / 2, 0, bar, w); mkBar(-h / 2, 0, bar, w);
      mkBar(0, -w / 2, h, bar); mkBar(0, w / 2, h, bar);
      for (let i = 1; i < 4; i++) mkBar(-h / 2 + (h * i) / 4, 0, bar * 0.7, w);
      for (let i = 1; i < 4; i++) mkBar(0, -w / 2 + (w * i) / 4, h, bar * 0.7);
      grid.position.set(Math.cos(a) * (r + h / 2 - 0.02), Math.sin(a) * (r + h / 2 - 0.02), L * 0.36);
      grid.rotation.z = a - Math.PI / 2;
      g.add(grid);
    }
  } else if (kind === 'R73') {
    // R-73: 둥근 노즈 + 긴 스트레이크 + 대형 꼬리날개
    L = 2.93;
    const r = 0.085;
    const body = add(new THREE.CylinderGeometry(r, r * 0.96, L * 0.8, 16), matBody, 0, 0, L * 0.04);
    body.rotation.x = Math.PI / 2;
    const nose = add(new THREE.SphereGeometry(r * 0.96, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), matSeeker, 0, 0, -L * 0.36);
    nose.rotation.x = -Math.PI / 2;
    nose.scale.z = 2.0;
    const spike = add(new THREE.CylinderGeometry(0.006, 0.006, 0.16, 6), matSeeker, 0, 0, -L * 0.5 - 0.07);
    spike.rotation.x = Math.PI / 2;
    const band = add(new THREE.CylinderGeometry(r * 1.015, r * 1.015, 0.08, 16), matBand, 0, 0, -L * 0.18);
    band.rotation.x = Math.PI / 2;
    for (let kIdx = 0; kIdx < 4; kIdx++) {
      const a = (kIdx / 4) * Math.PI * 2;
      // 전방 데스타빌라이저 (긴 스트레이크)
      const s = missileFin(0.1, 0.5, 0.08, 0.008, matBody);
      s.position.set(Math.cos(a) * r, Math.sin(a) * r, -L * 0.18);
      s.rotation.z = a - Math.PI / 2;
      s.rotation.y = Math.PI / 2;
      g.add(s);
      // 대형 꼬리날개
      const f = missileFin(0.26, 0.34, 0.14, 0.01, matBody);
      f.position.set(Math.cos(a) * r, Math.sin(a) * r, L * 0.34);
      f.rotation.z = a - Math.PI / 2;
      f.rotation.y = Math.PI / 2;
      g.add(f);
    }
  } else {
    // AIM-9X: 가늘고 짧은 탄체, 소형 카나드 + 롤러론 꼬리날개
    L = 2.87;
    const r = 0.0635;
    const body = add(new THREE.CylinderGeometry(r, r, L * 0.82, 14), matBody, 0, 0, L * 0.03);
    body.rotation.x = Math.PI / 2;
    // IR 시커: 어두운 유리 돔
    const seekerMat = new THREE.MeshStandardMaterial({ color: 0x3a2a18, roughness: 0.08, metalness: 0.7 });
    const nose = add(new THREE.SphereGeometry(r, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), seekerMat, 0, 0, -L * 0.38);
    nose.rotation.x = -Math.PI / 2;
    nose.scale.z = 1.9;
    const band = add(new THREE.CylinderGeometry(r * 1.02, r * 1.02, 0.07, 14), matBand, 0, 0, -L * 0.24);
    band.rotation.x = Math.PI / 2;
    for (let kIdx = 0; kIdx < 4; kIdx++) {
      const a = (kIdx / 4) * Math.PI * 2 + Math.PI / 4;
      // 전방 카나드 (작은 사각)
      const cn = missileFin(0.09, 0.14, 0.09, 0.007, matBody);
      cn.position.set(Math.cos(a) * r, Math.sin(a) * r, -L * 0.24);
      cn.rotation.z = a - Math.PI / 2;
      cn.rotation.y = Math.PI / 2;
      g.add(cn);
      // 꼬리날개 + 롤러론(끝 원통)
      const f = missileFin(0.17, 0.24, 0.12, 0.008, matBody);
      f.position.set(Math.cos(a) * r, Math.sin(a) * r, L * 0.36);
      f.rotation.z = a - Math.PI / 2;
      f.rotation.y = Math.PI / 2;
      g.add(f);
      const rol = add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 8), matSeeker,
        Math.cos(a) * (r + 0.17), Math.sin(a) * (r + 0.17), L * 0.36 + 0.1);
      rol.rotation.z = a - Math.PI / 2;
    }
    const noz = add(new THREE.CylinderGeometry(r * 0.75, r * 0.9, 0.1, 14, 1, true), matSeeker, 0, 0, L * 0.47);
    noz.rotation.x = Math.PI / 2;
  }
  g.userData.length = L;
  return g;
}
export { makeMissileMesh };

// ---------------- 화염 셰이더 ----------------
function flameMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uSeed: { value: Math.random() * 10 },
      uThrottle: { value: 1 },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uIntensity; uniform float uSeed; uniform float uThrottle;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        #include <logdepthbuf_fragment>
        float along = 1.0 - vUv.y;           // 0 = 노즐 출구
        float fall = pow(clamp(1.0 - along, 0.0, 1.0), 1.35);
        float rim = abs(dot(normalize(vN), normalize(vV)));
        // 다이아몬드 쇼크 콘: 출구 근처가 밝고 촘촘, 뒤로 갈수록 간격이 넓어지며 감쇠
        float cells = 0.5 + 0.5 * cos(along * (26.0 + 10.0 * uThrottle) - 0.8);
        cells = pow(cells, 2.5 + 3.0 * (1.0 - uThrottle));
        float diamonds = (0.45 + 0.55 * cells) * (1.0 - along * 0.75);
        // 밝은 코어: 중심축 근처에서 강함
        float core = smoothstep(0.35, 0.95, rim) * fall;
        float flick = 0.86 + 0.14 * sin(uTime * 53.0 + uSeed + along * 9.0) * sin(uTime * 31.0 + uSeed * 3.0);
        vec3 cCore = vec3(1.0, 0.96, 0.86);
        vec3 cMid = vec3(1.0, 0.55, 0.2);
        vec3 cOuter = vec3(0.4, 0.42, 1.0);
        vec3 cShock = vec3(0.75, 0.85, 1.0);
        vec3 col = mix(cOuter, cMid, smoothstep(0.05, 0.55, rim));
        col = mix(col, cShock, cells * (1.0 - rim) * 0.55 * fall);
        col = mix(col, cCore, clamp(core * 1.25, 0.0, 1.0));
        float a = uIntensity * (fall * diamonds * flick * smoothstep(0.0, 0.4, rim) + core * 0.55);
        gl_FragColor = vec4(col * a * 2.0, clamp(a, 0.0, 1.0));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// ---------------- F-15 모델 ----------------
// ---------------- GLB(F-15C v2) 경로: 노드 이름 매핑표 (v2 쪽 이름이 바뀌면 여기만 고친다) ----------------
const NODE = {
  stabR: 'stab_R', stabL: 'stab_L',
  ailR: 'ail_R', ailL: 'ail_L',
  flapR: 'flap_R', flapL: 'flap_L',
  rudR: 'rud_R', rudL: 'rud_L',
  speedbrake: 'speedbrake',
  gearN: 'gear_N', gearL: 'gear_L', gearR: 'gear_R',
  nozzleL: 'nozzle_L', nozzleR: 'nozzle_R',
  canopy: 'canopy', cockpit: 'cockpit',
  wingL: 'wing_L', wingR: 'wing_R',
  finL: 'fin_L', finR: 'fin_R',
  fuselage: 'fuselage', pylonL: 'pylon_L', pylonR: 'pylon_R',
  intakeL: 'intake_L', intakeR: 'intake_R',
  navLightL: 'navlight_L', navLightR: 'navlight_R', navLightT: 'navlight_T',
};
// GLB 재질 이름 → 역할 (v2 에는 skin_dark 가 없고 dark 로 되어 있음)
const MAT_ROLE = {
  skin: 'skin', skin_dark: 'skin', dark: 'dark',
  glass: 'glass', cockpit: 'cockpit', gear: 'gear', tire: 'tire',
  metal_nozzle: 'nozzle', metal: 'nozzle',
};

const PAINT_MATS = {};
function getPaintMats(paint) {
  if (PAINT_MATS[paint]) return PAINT_MATS[paint];
  const skin = makeSkinMaps(paint === 'aggressor' ? 21 : 5, paint);
  const M = {
    skin: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: skin.map, normalMap: skin.normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughnessMap: skin.roughnessMap, roughness: 1.0, metalness: 0.1, clearcoat: 0.03, clearcoatRoughness: 0.5, envMapIntensity: 0.3, side: THREE.DoubleSide }),
    dark: new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.65, metalness: 0.2, normalMap: skin.normalMap, normalScale: new THREE.Vector2(0.2, 0.2), side: THREE.DoubleSide }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x2e3a44, roughness: 0.05, metalness: 0.05, transmission: 0, transparent: true, opacity: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.1, envMapIntensity: 1.0, side: THREE.DoubleSide, depthWrite: false }),
    glassHud: new THREE.MeshBasicMaterial({ color: 0x9fd8b0, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide }),
    cockpit: new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.85, metalness: 0.1, envMapIntensity: 0.4 }),
    gear: new THREE.MeshStandardMaterial({ color: 0xd9dbd8, roughness: 0.45, metalness: 0.5 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 }),
    nozzle: new THREE.MeshStandardMaterial({ map: makeNozzleMaps(), color: 0x6b6560, roughness: 0.5, metalness: 0.7, envMapIntensity: 0.4, side: THREE.DoubleSide }),
    nozzleIn: new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.55, metalness: 0.6, envMapIntensity: 0.3, side: THREE.DoubleSide }),
  };
  PAINT_MATS[paint] = M;
  return M;
}

let F15_CACHE = null, F15_FAILED = false;
export async function preloadF15() {
  if (F15_CACHE || F15_FAILED) return F15_CACHE;
  try {
    const gltf = await new GLTFLoader().loadAsync('src/models/f15c_v2.glb');
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    F15_CACHE = { scene, hard: computeHardpoints(scene) };
  } catch (e) {
    F15_FAILED = true;
    console.warn('[기체] f15c_v2.glb 로드 실패, 절차적 모델로 대체:', e && e.message ? e.message : e);
  }
  return F15_CACHE;
}

// 하드포인트: GLB 지오메트리에서 직접 계산 (v2 가 바뀌어도 따라감)
function meshWorldBox(obj) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  obj.updateWorldMatrix(true, false);
  obj.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const p = o.geometry.attributes.position;
    if (!p) return;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      box.expandByPoint(v);
    }
  });
  return box;
}
function computeHardpoints(scene) {
  const H = {
    navL: new THREE.Vector3(-6.55, -0.4, 2.6), navR: new THREE.Vector3(6.55, -0.4, 2.6),
    tail: new THREE.Vector3(0, 0.1, 8.7),
    exitL: new THREE.Vector3(-0.7, -0.03, 9.4), exitR: new THREE.Vector3(0.7, -0.03, 9.4),
    pylonL: new THREE.Vector3(-3.8, -0.4, 0.7), pylonR: new THREE.Vector3(3.8, -0.4, 0.7),
    beaconTop: new THREE.Vector3(0, 1.0, -1.5), beaconBelly: new THREE.Vector3(0, -1.0, 0.5),
  };
  try {
    const tip = (name, sgn) => {
      const o = scene.getObjectByName(name);
      if (!o) return null;
      let best = null;
      const v = new THREE.Vector3();
      o.updateWorldMatrix(true, false);
      o.traverse(m => {
        if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) return;
        const p = m.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
          if (!best || Math.abs(v.x) * sgn > Math.abs(best.x) * sgn) best = v.clone();
        }
      });
      return best;
    };
    const wl = tip(NODE.wingL, -1), wr = tip(NODE.wingR, 1);
    if (wl) H.navL.copy(wl).add(new THREE.Vector3(-0.05, 0, 0));
    if (wr) H.navR.copy(wr).add(new THREE.Vector3(0.05, 0, 0));
    const f = scene.getObjectByName(NODE.fuselage);
    if (f) {
      const b = meshWorldBox(f);
      H.tail.set(0, b.max.y - 0.25, b.max.z - 0.05);
      H.beaconTop.set(0, b.max.y + 0.02, -1.0);
      H.beaconBelly.set(0, b.min.y - 0.02, 0.5);
    }
    for (const [key, node] of [['exitL', NODE.nozzleL], ['exitR', NODE.nozzleR]]) {
      const o = scene.getObjectByName(node);
      if (o) { const b = meshWorldBox(o); const c = b.getCenter(new THREE.Vector3()); H[key].set(c.x, c.y, b.max.z + 0.05); }
    }
    for (const [key, node] of [['pylonL', NODE.pylonL], ['pylonR', NODE.pylonR]]) {
      const o = scene.getObjectByName(node);
      if (o) H[key].copy(meshWorldBox(o).getCenter(new THREE.Vector3()));
    }
    // 항법등 노드가 있으면 그 월드 위치를 씀 (없으면 위 지오메트리 계산값 유지)
    for (const [key, node] of [['navL', NODE.navLightL], ['navR', NODE.navLightR], ['tail', NODE.navLightT]]) {
      try {
        const o = scene.getObjectByName(node);
        if (o) H[key].copy(meshWorldBox(o).getCenter(new THREE.Vector3()));
      } catch (e) { /* 해당 노드 없음: 계산값 유지 */ }
    }
  } catch (e) { console.warn('[기체] 하드포인트 계산 실패, 기본값 사용:', e && e.message ? e.message : e); }
  return H;
}

// ---- 조종석 내부 공용 (절차/GLB 공용. C: aero(x전방,y우측,z위)->three 변환, GLB는 눈·박스 기준 앵커 반영)
// 글레어실드 윗변 화면 y≈460, 폭 화면 약 45%, 불투명 내장재만 사용 (보어사이트 y≈328 위는 빈 시야)
function addCockpitInterior(group, C, gearMat) {
  const emis = 0x050607;
  const cpMat = new THREE.MeshStandardMaterial({ color: 0x1a1d20, roughness: 0.9, metalness: 0, emissive: emis });
  const cpLight = new THREE.MeshStandardMaterial({ color: 0x2a2f34, roughness: 0.8, metalness: 0.15, emissive: emis });
  const put = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; group.add(m); return m; };
  // 직선 박스 대신 둥근 상자 (반경은 얇은 변의 절반 미만으로 자동 제한)
  const rbox = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, 0.45 * Math.min(w, h, d)));
  // 조종석 바닥판 (앞으로 늘려 패널 아래를 막음, 낮게 깔아 시야를 가리지 않음)
  const floorPan = put(rbox(0.9, 0.06, 3.0), cpMat);
  floorPan.position.copy(C(4.9, 0, 0.3));
  // 글레어실드: 앞으로 둥글게 굽은 얇은 껍질 (수직축 원통호, 가운데가 앞으로). 윗면을 조종사 쪽으로 살짝 기울여 입체감
  const shellGeo = new THREE.CylinderGeometry(1.1, 1.1, 0.15, 24, 1, true, Math.PI - 0.40, 0.80);
  shellGeo.translate(0, 0, 1.1);  const shell = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({ color: 0x1a1d20, roughness: 0.9, metalness: 0, emissive: emis, side: THREE.DoubleSide }));
  shell.castShadow = shell.receiveShadow = true;
  shell.userData.eyeCheck = false; // 1인칭 검증 제외 (아래 시야 덮개, 설계상 자리)
  shell.position.copy(C(5.82, 0, 0.71));
  shell.rotation.x = 0.12; // 윗면을 조종사 쪽으로 살짝 기울임
  group.add(shell);
  // 글레어 윗변 하이라이트 (얇은 밝은 회색 줄, 껍질 자식으로 붙어 앵커를 따라감)
  {
    const hlGeo = new THREE.TorusGeometry(1.1, 0.005, 6, 32, 0.75);
    hlGeo.rotateZ(Math.PI / 2 - 0.375);
    const hl = new THREE.Mesh(hlGeo, new THREE.MeshBasicMaterial({ color: 0xa8b0b8 }));
    hl.rotation.x = -Math.PI / 2;
    hl.position.set(0, 0.075, 1.1);
    shell.add(hl);
  }
  // 계기판 (둥근 판, 폭 화면 60%. 글레어 바로 아래 안쪽에 밀어 넣고 윗변은 글레어 아래립 속에 숨김. 판면은 조종사 쪽으로 15도 뒤로) + MFD 3면
  const panel = put(rbox(0.82, 0.50, 0.06), cpMat);
  panel.position.copy(C(5.52, 0, 0.55)); panel.rotation.x = -0.26;
  const mfdTexA = makeMfdTexture(11), mfdTexRadar = makeRadarTexture(23), mfdTexC = makeMfdTexture(37);
  const mfdDefs = [[-0.28, mfdTexA], [0, mfdTexRadar], [0.28, mfdTexC]];
  for (const [yy, tex] of mfdDefs) {
    // 어두운 바탕에 은은한 녹색 테두리·간단 표시 (판면에서 0.02 앞으로 띄워 묻힘 방지)
    // 화면 80% 크기 + 테두리 버튼 줄 (위아래 5개씩)
    const mg = new THREE.Group();
    mg.position.copy(C(5.53, yy, 0.72)); mg.rotation.x = -0.26;
    group.add(mg);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.12), new THREE.MeshBasicMaterial({ color: 0x8a8a8a, map: tex }));
    scr.position.set(0, 0, 0.003);
    mg.add(scr);
    for (let bi = 0; bi < 5; bi++) {
      for (const sy of [-1, 1]) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.012), cpLight);
        b.position.set((bi - 2) * 0.028, sy * 0.075, 0.002);
        b.castShadow = b.receiveShadow = true;
        mg.add(b);
      }
    }
  }
  // HUD: 글레어 위 작은 본체 상자 (기존 폭의 60%, 높이 절반) + 아주 가는 프레임 2개 + 거의 투명한 녹청 유리
  const hudBody = put(rbox(0.216, 0.05, 0.20), cpMat);
  hudBody.position.copy(C(5.77, 0, 0.795));
  for (const sgn of [-1, 1]) {
    const frame = put(new THREE.BoxGeometry(0.012, 0.10, 0.012), cpMat);
    frame.position.copy(C(5.72, sgn * 0.07, 0.83));
  }
  {
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.12), new THREE.MeshBasicMaterial({ color: 0x9fd8d0, transparent: true, opacity: 0.04, depthWrite: false, side: THREE.DoubleSide }));
    glass.position.copy(C(5.72, 0, 0.85)); glass.rotation.x = -0.10;
    group.add(glass);
  }
  // 캐노피 레일 (양옆 얇은 띠) + 낮은 사이드 콘솔 (윗면이 화면 아래에 가라�음)
  for (const sgn of [-1, 1]) {
    const rail = put(rbox(0.04, 0.03, 1.5, 0.01), cpLight);
    rail.position.copy(C(5.07, sgn * 0.52, 0.64));
    const console_ = put(rbox(0.30, 0.10, 1.6), cpMat);
    console_.position.copy(C(4.90, sgn * 0.40, 0.51));
    // 콘솔 버튼 점들
    for (let bi = 0; bi < 8; bi++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.05), new THREE.MeshBasicMaterial({ color: bi % 3 ? 0x1d3a22 : 0x3a2a12 }));
      b.position.copy(C(4.6 + (bi % 4) * 0.18, sgn * 0.40, 0.57 + Math.floor(bi / 4) * 0.05));
      group.add(b);
    }
  }
  const stick = put(new THREE.CylinderGeometry(0.03, 0.04, 0.4, 8), cpMat);
  stick.position.copy(C(4.7, 0, 0.45));
  stick.rotation.z = 0.15;
  // 사출좌석 대략형 (버킷 + 등받이 + 헤드레스트 + 레일)
  const seatPan = put(rbox(0.5, 0.5, 0.45, 0.03), cpMat);
  seatPan.position.copy(C(3.95, 0, 0.42));
  const seatBack = put(rbox(0.5, 0.5, 0.16, 0.03), cpLight);
  seatBack.position.copy(C(3.72, 0, 0.62));
  seatBack.rotation.z = -0.15;
  const headrest = put(rbox(0.24, 0.28, 0.16, 0.03), cpMat);
  headrest.position.copy(C(3.68, 0, 0.92));
  for (const sgn of [-1, 1]) {
    const railBar = put(new THREE.BoxGeometry(0.04, 0.04, 1.0), gearMat);
    railBar.position.copy(C(3.66, sgn * 0.2, 0.6));
  }
}

function buildGLBF15({ paint = 'usaf', cockpit = true } = {}) {
  const root = new THREE.Group();
  const M = getPaintMats(paint);
  const model = F15_CACHE.scene.clone(true);
  root.add(model);
  const N = (n) => model.getObjectByName(NODE[n] || n);
  const roleMat = { skin: M.skin, dark: M.dark, glass: M.glass, cockpit: M.cockpit, gear: M.gear, tire: M.tire, nozzle: M.nozzle };
  const matToRole = new Map();
  const applyRole = (o, extra) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const mapped = mats.map(m => {
      let role = MAT_ROLE[(m && m.name || '').trim()];
      if (!role && m && matToRole.has(m)) role = matToRole.get(m);
      if (!role) return null;
      const dst = (extra && extra[role]) || roleMat[role] || null;
      if (dst) matToRole.set(dst, role);
      return dst;
    });
    if (mapped.every(Boolean)) o.material = Array.isArray(o.material) ? mapped : mapped[0];
  };
  model.traverse(o => {
    applyRole(o);
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const isGlass = mats.includes(M.glass) || mats.includes(M.glassHud);
    o.castShadow = o.receiveShadow = !isGlass;
    if (isGlass) o.renderOrder = 2;
  });
  // 캐노피: 유리는 어두운 금빛 반사 유리, 프레임은 동체색
  { const cn = model.getObjectByName(NODE.canopy); if (cn) cn.traverse(o => applyRole(o, { glass: M.glass, dark: M.skin })); }
  // 조종석 HUD 유리: 옅은 발광 느낌
  { const ck = model.getObjectByName(NODE.cockpit); if (ck) ck.traverse(o => applyRole(o, { glass: M.glassHud })); }
  // 이름 모르는 작은 노드(피토·안테나·기관포 개구 등): 블렌더 기본 재질이면 skin으로 (깨짐 방지)
  {
    const known = new Set([...Object.values(roleMat), M.glassHud]);
    const isDefaultMat = (m) => {
      const nm = (m && m.name || '').trim();
      return !nm || nm === 'Principled BSDF' || /^Material(\.|$)/.test(nm);
    };
    model.traverse(o => {
      if (!o.isMesh) return;
      if (Array.isArray(o.material)) {
        let ch = false;
        const arr = o.material.map(m => {
          const f = (m && !known.has(m) && isDefaultMat(m)) ? M.skin : m;
          if (f !== m) ch = true;
          return f;
        });
        if (ch) o.material = arr;
      } else if (o.material && !known.has(o.material) && isDefaultMat(o.material)) {
        o.material = M.skin;
      }
    });
  }
  // 1인칭에서 숨길 유리 메쉬 목록 (프레임은 남김)
  const glassMeshes = [];
  model.traverse(o => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some(m => m && m.transparent)) glassMeshes.push(o);
  });
  const NP = (n) => { const o = N(n); if (!o && !buildGLBF15._warned) console.warn('[기체] GLB 노드 없음:', NODE[n] || n); return o; };
  const surfaces = { stabR: NP('stabR'), stabL: NP('stabL'), ailR: NP('ailR'), ailL: NP('ailL'), flapR: NP('flapR'), flapL: NP('flapL'), rudR: NP('rudR'), rudL: NP('rudL') };
  buildGLBF15._warned = true;
  const sb = NP('speedbrake');
  const canopy = NP('canopy');
  // 조종석 (game.js 가 cockpitGroup.visible 을 토글하므로 래퍼 유지)
  const cockpitGroup = new THREE.Group();
  cockpitGroup.visible = false;
  const cockpitNode = NP('cockpit');
  if (cockpit && cockpitNode) cockpitGroup.add(cockpitNode);
  // 조종석 내부: 절차 공용 내부를 GLB cockpit 노드 바운딩박스 앵커에 맞춰 재사용
  // (GLB가 다시 만들어져 박스가 바뀌어도 앵커가 따라감. 캐노피 위치 오프셋·법선 수정 없음)
  if (cockpit) {
    try {
      const src = cockpitNode || model.getObjectByName(NODE.canopy) || model;
      const box = meshWorldBox(src);
      const eyeY = 1.12, eyeZ = -4.75;
      const cxB = isFinite(box.min.x + box.max.x) ? (box.min.x + box.max.x) / 2 : 0;
      let zG = isFinite(box.min.z) ? box.min.z + 0.15 : eyeZ - 1.05;
      if (!(zG < eyeZ - 0.5)) zG = eyeZ - 1.05;
      const dG = Math.max(0.6, eyeZ - zG);
      const yTopReq = eyeY - 0.287 * dG;   // 투영식 y_top=eye-0.287d → 윗변 화면 y≈460
      const dyQ = (yTopReq - 0.15) - 0.635;
      const dxQ = -zG - 5.82;
      const Q = (x, y, z) => new THREE.Vector3(y + cxB, z + dyQ, -(x + dxQ));
      addCockpitInterior(cockpitGroup, Q, M.gear);
    } catch (e) { console.warn('[기체] GLB 조종석 내부 배치 실패:', e && e.message ? e.message : e); }
  }
  root.add(cockpitGroup);
  // 외부용 조종석 내부 (외부 시점에서만 보임. game.js 가 pilotGroup 을 1인칭에서 숨기므로 카메라를 가리지 않음)
  // 어두운 욕조 + 헤드레스트(노란 손잡이) + 조종사(헬멧·바이저·상체). 위치는 GLB cockpit 박스 + 눈(0,1.12,-4.75) 기준, 저폴리
  const pilotGroup = new THREE.Group();
  root.add(pilotGroup);
  if (cockpit) {
    try {
      const src = cockpitNode || model.getObjectByName(NODE.canopy) || model;
      const box = meshWorldBox(src);
      const eyeY = 1.12, eyeZ = -4.75;
      const cxB = isFinite(box.min.x + box.max.x) ? (box.min.x + box.max.x) / 2 : 0;
      const topY = isFinite(box.max.y) ? box.max.y : 0.75;
      const czB = (isFinite(box.min.z + box.max.z)) ? (box.min.z + box.max.z) / 2 : -4.35;
      const wid = (isFinite(box.max.x - box.min.x) && box.max.x - box.min.x > 0.3) ? box.max.x - box.min.x : 1.0;
      const len = (isFinite(box.max.z - box.min.z) && box.max.z - box.min.z > 0.5) ? box.max.z - box.min.z : 2.6;
      const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; pilotGroup.add(m); return m; };
      // 욕조 (캐노피 실 아래를 막는 어두운 판, 위에서 보면 검은 바닥)
      add(new THREE.BoxGeometry(wid + 0.1, 0.06, len + 0.1), M.cockpit, cxB, topY - 0.05, czB);
      // 사출좌석 헤드레스트 + 노란 손잡이
      add(new THREE.BoxGeometry(0.24, 0.28, 0.16), M.cockpit, cxB, topY + 0.23, eyeZ + 0.45);
      add(new THREE.BoxGeometry(0.10, 0.05, 0.06), new THREE.MeshStandardMaterial({ color: 0xd6b23a, roughness: 0.5 }), cxB, topY + 0.39, eyeZ + 0.45);
      // 조종사: 헬멧(회백색 구 16x12) + 바이저 + 어깨·상체(올리브 둥근 상자), 헬멧 중심이 눈 근처
      const helmetMat = new THREE.MeshStandardMaterial({ color: 0xe0e0d8, roughness: 0.4, metalness: 0.05 });
      const visorMat = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.15, metalness: 0.4 });
      const suitMat = new THREE.MeshStandardMaterial({ color: 0x4b5340, roughness: 0.8, metalness: 0 });
      add(new THREE.SphereGeometry(0.15, 16, 12), helmetMat, cxB, eyeY - 0.10, eyeZ + 0.20);
      const visor = add(new THREE.SphereGeometry(0.145, 16, 12, -Math.PI / 2.6, Math.PI / 1.3, Math.PI / 3.4, Math.PI / 4), visorMat, cxB, eyeY - 0.10, eyeZ + 0.20);
      visor.rotation.y = -Math.PI / 2;
      const torso = add(new THREE.BoxGeometry(0.45, 0.30, 0.28), suitMat, cxB, topY - 0.03, eyeZ + 0.40);
      torso.rotation.x = -0.08;
    } catch (e) { console.warn('[기체] GLB 외부 조종석 배치 실패:', e && e.message ? e.message : e); }
  }
  // 무장 (파일런·동체 표면에 밀착, 레이캐스트로 반매립 위치 계산)
  const H = F15_CACHE.hard;
  root.updateMatrixWorld(true);
  const aim9 = [], aim120 = [];
  for (const sgn of [-1, 1]) {
    const pc = sgn < 0 ? H.pylonL : H.pylonR;
    for (const dx of [-0.16, 0.16]) {
      const m = makeMissileMesh('AIM-9X', undefined);
      m.position.set(pc.x + dx, pc.y - 0.4, pc.z);
      root.add(m);
      aim9.push(m);
    }
  }
  {
    // 동체 아래 AIM-120C x4: 흡입구 덕트 박스 기준 (덕트 아랫면에 윗면 반매립 0.05)
    // x = 덕트 폭 안쪽/바깥쪽 1/4, 앞끝 s≥7.5·중앙 s 8.5~12.5 (s = 노즈 기점, 노즈 z는 동체 박스에서 측정)
    const LM = 3.65, LR = 0.089; // AIM-120C 길이·반경 (makeMissileMesh와 동일)
    let fusMinZ = -10.05;
    try { const f = N('fuselage'); if (f) fusMinZ = meshWorldBox(f).min.z; } catch (e) { /* 폴백값 유지 */ }
    const noseMinZ = fusMinZ + 7.5;
    const cz = Math.min(Math.max(noseMinZ + LM / 2, fusMinZ + 8.5), fusMinZ + 12.5);
    const spots = [];
    for (const key of ['intakeL', 'intakeR']) {
      let nd = null;
      try { nd = N(key); } catch (e) { nd = null; }
      if (!nd) continue;
      const b = meshWorldBox(nd);
      const w = b.max.x - b.min.x;
      if (!(w > 0)) continue;
      for (const fx of [0.25, 0.75]) spots.push({ x: b.min.x + w * fx, y: b.min.y + 0.05 - LR });
    }
    if (spots.length !== 4) {
      // 노드 없음: 기존 고정 배치 폴백 (동체 표면 레이캐스트)
      spots.length = 0;
      const fuse = N('fuselage');
      const rc = new THREE.Raycaster();
      const dn = new THREE.Vector3(0, -1, 0);
      for (const [x, z] of [[1.42, -2.2], [-1.42, -2.2], [1.42, 2.6], [-1.42, 2.6]]) {
        let y = -0.82;
        if (fuse) {
          rc.set(new THREE.Vector3(x, 3, z), dn);
          const hits = rc.intersectObject(fuse, true);
          if (hits.length) {
            let minY = Infinity;
            for (const h of hits) minY = Math.min(minY, h.point.y);
            y = minY - 0.03;
          }
        }
        spots.push({ x, y, z });
      }
    }
    for (const s of spots) {
      const m = makeMissileMesh('AIM-120C', undefined);
      m.position.set(s.x, s.y, s.z !== undefined ? s.z : cz);
      root.add(m);
      aim120.push(m);
    }
  }
  // 랜딩기어 (GLB 노드 그대로 사용, 피벗 = 힌지)
  const gears = [{ pivot: NP('gearN') }, { pivot: NP('gearL') }, { pivot: NP('gearR') }].filter(g => g.pivot);
  // 애프터버너 화염 (노즐 출구에 부착, 기존 셰이더 재사용)
  const flames = [];
  for (const key of ['exitL', 'exitR']) {
    const g = new THREE.Group();
    g.position.copy(H[key]);
    const mat = flameMaterial();
    const geo = new THREE.CylinderGeometry(0.46, 0.06, 1, 20, 8, true);
    geo.translate(0, -0.5, 0);
    geo.rotateX(-Math.PI / 2);
    const outerF = new THREE.Mesh(geo, mat);
    const innerF = new THREE.Mesh(geo, mat);
    innerF.scale.set(0.55, 0.55, 0.6);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false });
    const coreGeo = new THREE.CylinderGeometry(0.2, 0.03, 1, 12, 4, true);
    coreGeo.translate(0, -0.5, 0);
    coreGeo.rotateX(-Math.PI / 2);
    const coreF = new THREE.Mesh(coreGeo, coreMat);
    g.add(outerF, innerF, coreF);
    g.visible = false;
    root.add(g);
    flames.push({ g, mat, outerF, innerF, coreF });
  }
  // 항법등·충돌방지등 (GLB 하드포인트)
  const glowTex = glowTexture();
  const mkLight = (color, p, size) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    sp.scale.setScalar(size);
    sp.position.copy(p);
    root.add(sp);
    return sp;
  };
  const navL = mkLight(0xff2020, H.navL, 0.3);
  const navR = mkLight(0x20ff40, H.navR, 0.3);
  const navTail = mkLight(0xffffff, H.tail, 0.25);
  const strobes = [mkLight(0xffffff, H.navL, 0.55), mkLight(0xffffff, H.navR, 0.55)];
  const beaconTop = mkLight(0xff3020, H.beaconTop, 0.35);
  const beaconBelly = mkLight(0xff3020, H.beaconBelly, 0.35);
  // 노즐 발광판 (AB 때만 켬) + 터키 페더 개폐용 스케일
  const nozzles = [];
  // 노즐 안쪽 그을림 덮개 (GLB 금속 안쪽면의 하늘 반사를 가림, 출구에서 앞으로 1.5)
  const sleeveGeo = new THREE.CylinderGeometry(0.46, 0.40, 1.5, 20, 1, true);
  sleeveGeo.rotateX(Math.PI / 2);
  for (const key of ['nozzleL', 'nozzleR']) {
    const nz = NP(key);
    if (!nz) continue;
    const exit = key === 'nozzleL' ? H.exitL : H.exitR;
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.4, 24), new THREE.MeshBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.set(exit.x, exit.y, exit.z - 0.35);
    root.add(glow);
    const sleeve = new THREE.Mesh(sleeveGeo, M.nozzleIn);
    sleeve.position.set(exit.x, exit.y, exit.z - 0.85);
    root.add(sleeve);
    const cap = new THREE.Mesh(new THREE.CircleGeometry(0.40, 20), M.nozzleIn);
    cap.position.set(exit.x, exit.y, exit.z - 1.58);
    root.add(cap);
    nozzles.push({ group: nz, glow });
  }
  // 표식 데칼 (기존 캔버스 문양, v2 좌표에 맞춤)
  {
    const tex = textTexture([{ text: 'EG', font: 'bold 64px Arial' }, { text: '84-0010', font: 'bold 26px Arial' }, { text: '33 FW', font: 'bold 24px Arial' }], 256, 200, '#2a3036');
    for (const sgn of [-1, 1]) {
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.15), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      decal.position.set(sgn * 1.41, 2.0, 6.95);
      decal.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
      root.add(decal);
    }
    const bars = starBarsTexture();
    for (const sgn of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.85), new THREE.MeshBasicMaterial({ map: bars, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      d.position.set(sgn * 1.63, 0.1, -0.6);
      d.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
      root.add(d);
      const t = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.32), new THREE.MeshBasicMaterial({ map: textTexture([{ text: 'U.S. AIR FORCE', font: 'bold 40px Arial' }], 512, 64, '#2a3036'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      t.position.set(sgn * 1.57, -0.15, -2.6);
      t.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
      root.add(t);
      const r = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.22), new THREE.MeshBasicMaterial({ map: textTexture([{ text: '▶ RESCUE', font: 'bold 34px Arial' }], 256, 64, '#8a1c1c'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      r.position.set(sgn * 0.85, 0.25, -5.2);
      r.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
      root.add(r);
    }
    for (const sgn of [-1, 1]) {
      const slime = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.08), new THREE.MeshBasicMaterial({ color: 0xcfe08a }));
      slime.position.set(sgn * 1.63, 0.45, 1.5);
      slime.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
      root.add(slime);
    }
  }
  const parts = { surfaces, sb, canopy, pilotGroup, cockpitGroup, aim9, aim120, gears, flames, nozzles, navL, navR, navTail, strobes, beaconTop, beaconBelly };
  const D = Math.PI / 180;
  function update(fm, time, opts = {}) {
    const s = fm.surf;
    // 1인칭에서는 캐노피 전체(유리+회색 프레임 아치)를 숨김. game.js 가 cockpitGroup 으로 조종석 시점을 표시
    const hideGlass = cockpitGroup.visible;
    for (let gi = 0; gi < glassMeshes.length; gi++) glassMeshes[gi].visible = !hideGlass;
    if (canopy) canopy.visible = !hideGlass;
    const setRot = (pivot, ang) => { if (pivot) pivot.rotation.x = ang; };
    setRot(surfaces.stabR, -(s.de + 0.45 * s.da));
    setRot(surfaces.stabL, -(s.de - 0.45 * s.da));
    setRot(surfaces.ailR, -s.da);
    setRot(surfaces.ailL, s.da);
    setRot(surfaces.flapR, fm.flapPos * 30 * D);
    setRot(surfaces.flapL, fm.flapPos * 30 * D);
    if (surfaces.rudR) surfaces.rudR.rotation.y = s.dr;
    if (surfaces.rudL) surfaces.rudL.rotation.y = s.dr;
    if (sb) sb.rotation.x = -fm.sbPos * 45 * D;
    for (let i = 0; i < gears.length; i++) {
      const gg = gears[i];
      if (!gg || !gg.pivot) continue;
      gg.pivot.rotation.x = (1 - fm.gearPos) * (Math.PI / 2);
      gg.pivot.visible = fm.gearPos > 0.02;
    }
    for (let i = 0; i < 2; i++) {
      const en = fm.engines ? fm.engines[i] : { ab: 0, n: 0, nozzle: 0.5 };
      const f = flames[i], nz = nozzles[i];
      const ab = en.ab || 0;
      if (f) {
        f.g.visible = ab > 0.02;
        if (f.g.visible) {
          const flick = 1 + 0.06 * Math.sin(time * 47 + i * 2);
          const len = (1.6 + 5.2 * ab) * flick;
          f.outerF.scale.set(0.85 + 0.2 * ab, 0.85 + 0.2 * ab, len);
          f.innerF.scale.set(0.5, 0.5, len * 0.55);
          f.coreF.scale.set(0.9, 0.9, 0.6 + 1.8 * ab);
          f.coreF.material.opacity = clamp(0.35 + 0.6 * ab, 0, 1);
          f.mat.uniforms.uTime.value = time;
          f.mat.uniforms.uIntensity.value = 0.55 + 0.6 * ab;
          if (f.mat.uniforms.uThrottle) f.mat.uniforms.uThrottle.value = clamp(ab, 0.05, 1);
        }
      }
      if (nz) {
        nz.glow.material.opacity = clamp((ab - 0.02) * 1.6, 0, 1);
        const open = 1 + (en.nozzle || 0) * 0.12;
        nz.group.scale.set(open, open, 1);
      }
    }
    if (opts.stores) {
      for (let i = 0; i < 4; i++) { if (aim9[i]) aim9[i].visible = i < opts.stores.aim9; if (aim120[i]) aim120[i].visible = i < opts.stores.aim120; }
    }
    const cyc = time % 1.4;
    const strobeOn = cyc < 0.05 || (cyc > 0.12 && cyc < 0.17);
    for (const st of strobes) st.visible = strobeOn;
    const beaconOn = (time % 1.0) < 0.5;
    beaconTop.visible = beaconBelly.visible = beaconOn;
    const navOn = opts.lights !== false;
    navL.visible = navR.visible = navTail.visible = navOn;
  }
  // 1인칭 검증: 눈(로컬 0, 1.12, -4.75) 근처 0.3 m 안에 시야 중앙(35도 원뿔)을 가리는 메시 경고
  // (캐노피는 1인칭에서 숨으므로 검사 제외, 조종석 내부+노드는 포함)
  if (cockpit) {
    try {
      const eye = new THREE.Vector3(0, 1.12, -4.75);
      const viewDir = new THREE.Vector3(0, -0.07, -1).normalize();
      root.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      const bad = [];
      cockpitGroup.traverse(o => {
        if (!o.isMesh || !o.geometry) return;
        if (!o.visible) return;
        if (o.userData && o.userData.eyeCheck === false) return; // 설계상 아래 덮개(글레어 껍질) 제외
        const oms = Array.isArray(o.material) ? o.material : [o.material];
        if (oms.some(mm => mm && mm.transparent)) return; // 1인칭에서 숨기는 유리는 검사 제외
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const s = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
        v.copy(s.center).sub(eye);
        const dist = Math.max(0, v.length() - s.radius);
        if (dist > 0.6) return;
        const ang = v.lengthSq() > 1e-9 ? v.clone().normalize().angleTo(viewDir) * 180 / Math.PI : 0;
        const col = o.material && o.material.color ? '#' + o.material.color.getHexString() : '?';
        if (dist < 0.3 && ang < 35) bad.push({ d: +dist.toFixed(2), a: +ang.toFixed(1), info: col });
      });
      if (bad.length) console.warn('[기체] 1인칭 눈앞 장애물', bad);
    } catch (e) { /* 검증 실패는 무시 (렌더에 영향 없음) */ }
  }
  root.userData.update = update;
  root.userData.parts = parts;
  return root;
}

export function buildF15({ paint = 'usaf', cockpit = true } = {}) {
  if (F15_CACHE && F15_CACHE.scene) return buildGLBF15({ paint, cockpit });
  if (!F15_CACHE && !F15_FAILED) console.warn('[기체] GLB 캐시 없음: 절차적 모델로 대체 (preloadF15 호출 필요)');
  return buildProceduralF15({ paint, cockpit });
}

function buildProceduralF15({ paint = 'usaf', cockpit = true } = {}) {
  const root = new THREE.Group();
  const scheme = paint === 'aggressor'
    ? { base: 0xffffff, dark: 0x5d6152, tail: 'AGGRESSOR', num: '' }
    : { base: 0xffffff, dark: 0x39424a, tail: 'EG', num: '84-0010' };
  const skin = makeSkinMaps(paint === 'aggressor' ? 21 : 5, paint);
  const nozzleMap = makeNozzleMaps();
  const turbineTex = makeTurbineTexture();
  const M = {
    // 무광 위장도료: 절차적 map + normalMap + roughnessMap
    body: new THREE.MeshPhysicalMaterial({ color: scheme.base, map: skin.map, normalMap: skin.normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughnessMap: skin.roughnessMap, roughness: 1.0, metalness: 0.15, clearcoat: 0.1, clearcoatRoughness: 0.5, envMapIntensity: 0.6, side: THREE.DoubleSide }),
    dark: new THREE.MeshPhysicalMaterial({ color: 0xd6dce2, map: skin.map, normalMap: skin.normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughnessMap: skin.roughnessMap, roughness: 1.0, metalness: 0.15, clearcoat: 0.08, clearcoatRoughness: 0.55, envMapIntensity: 0.6, side: THREE.DoubleSide }),
    radome: new THREE.MeshStandardMaterial({ color: 0x8d9297, roughness: 0.75, metalness: 0.05, envMapIntensity: 0.5 }),
    nozzle: new THREE.MeshStandardMaterial({ map: nozzleMap, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide }),
    nozzleIn: new THREE.MeshStandardMaterial({ color: 0x2c2622, roughness: 0.55, metalness: 0.85, side: THREE.DoubleSide }),
    inside: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9, side: THREE.DoubleSide }),
    turbine: new THREE.MeshBasicMaterial({ map: turbineTex }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xd8c49a, roughness: 0.07, metalness: 0.1, transmission: 0, transparent: true, opacity: 0.12, clearcoat: 0.4, clearcoatRoughness: 0.2, envMapIntensity: 0.5, side: THREE.FrontSide, depthWrite: false }),
    gear: new THREE.MeshStandardMaterial({ color: 0xd9dbd8, roughness: 0.45, metalness: 0.5 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 }),
    missile: new THREE.MeshStandardMaterial({ color: 0xdedfdc, roughness: 0.5, metalness: 0.2 }),
    seeker: new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.1, metalness: 0.6 }),
    band: new THREE.MeshStandardMaterial({ color: 0xd6b23a, roughness: 0.5 }),
    pilot: new THREE.MeshStandardMaterial({ color: 0x4b5340, roughness: 0.8 }),
    helmet: new THREE.MeshStandardMaterial({ color: 0xe0e0d8, roughness: 0.4 }),
    slime: new THREE.MeshBasicMaterial({ color: 0xcfe08a }),
  };
  const add = (geo, mat, parent = root) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; parent.add(m); return m; };

  // ---- 전방 동체 (아래로 약간 처진 오자이브 레이돔)
  add(loft([
    [9.72, 0.012, 0.012, 0.012, -0.3, 2], [9.55, 0.06, 0.055, 0.065, -0.28, 2],
    [9.2, 0.15, 0.14, 0.17, -0.24, 2], [8.8, 0.27, 0.25, 0.3, -0.18, 2],
    [8.3, 0.4, 0.37, 0.43, -0.12, 2.1], [7.8, 0.52, 0.48, 0.55, -0.05, 2.2],
    [7.3, 0.62, 0.56, 0.63, 0.0, 2.4], [7.0, 0.67, 0.6, 0.66, 0.04, 2.6],
  ], 40), M.radome);
  // 피토관 (기수 우측) + 받음각 베인 (기수 좌측)
  const pitot = add(new THREE.CylinderGeometry(0.012, 0.02, 0.85, 6), M.dark);
  pitot.rotation.x = Math.PI / 2 + 0.03;
  pitot.position.copy(P(9.35, 0.17, -0.22));
  const aoa = add(new THREE.BoxGeometry(0.02, 0.12, 0.06), M.dark);
  aoa.position.copy(P(8.6, -0.32, -0.1));
  // ---- 조종석 주변 상부 (캐노피 데크 융기, 아래쪽 볼륨 확대)
  add(loft([
    [7.0, 0.67, 0.6, 0.66, 0.04, 2.6], [6.3, 0.74, 0.66, 0.74, 0.06, 2.8],
    [5.4, 0.8, 0.72, 0.85, 0.02, 3.0], [4.5, 0.86, 0.72, 0.9, 0.0, 3.2],
    [3.6, 0.92, 0.7, 0.94, -0.02, 3.4], [2.6, 0.98, 0.68, 0.96, -0.04, 3.6],
    [1.6, 1.02, 0.66, 0.96, -0.05, 3.7], [0.5, 1.04, 0.64, 0.96, -0.05, 3.8],
  ], 40), M.body);
  // 등뼈 덮개 (캐노피 뒤 볼록한 스파인)
  add(loft([
    [3.4, 0.5, 0.34, 0.1, 0.72, 3], [2.0, 0.62, 0.3, 0.08, 0.7, 3.2],
    [0.0, 0.7, 0.28, 0.06, 0.66, 3.4], [-2.2, 0.68, 0.26, 0.05, 0.62, 3.4], [-4.0, 0.6, 0.24, 0.04, 0.58, 3.2],
  ], 28), M.body);
  // ---- 중앙 동체 (흡입구부터 이어지는 넓고 평평한 리프팅 바디)
  add(loft([
    [4.7, 1.62, 0.5, 0.85, -0.12, 7], [3.2, 1.78, 0.6, 0.92, -0.08, 7],
    [0.5, 1.8, 0.62, 0.92, -0.06, 7], [-2.5, 1.78, 0.6, 0.88, -0.06, 6.5],
    [-5.0, 1.7, 0.56, 0.8, -0.06, 6], [-6.6, 1.52, 0.5, 0.7, -0.06, 5],
    [-7.5, 1.3, 0.44, 0.6, -0.06, 4],
  ], 40), M.body);
  // ---- 동체 측면 콘포멀 라인 (CFT 느낌의 볼록한 측선)
  for (const sgn of [-1, 1]) {
    const cft = add(loft([
      [2.6, 0.28, 0.3, 0.42, -0.28, 3], [1.0, 0.34, 0.36, 0.5, -0.3, 3],
      [-1.5, 0.34, 0.36, 0.5, -0.3, 3], [-4.0, 0.3, 0.32, 0.44, -0.3, 3], [-5.6, 0.2, 0.22, 0.3, -0.28, 3],
    ], 20), M.body);
    cft.position.x = sgn * 1.66;
  }
  // ---- 사각 가변 흡입구 (입구는 조종석 옆 x 4.2, 덕트는 뒤로 동체에 매끈하게 합류)
  const rampTex = makeRampTexture();
  const rampMat = new THREE.MeshStandardMaterial({ map: rampTex, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
  for (const sgn of [-1, 1]) {
    // 경계층 분리판 (동체와 덕트 사이 얇은 판 + 좁은 틈)
    const splitter = add(new THREE.BoxGeometry(0.03, 1.0, 2.6), M.dark);
    splitter.position.copy(P(3.0, sgn * 0.86, -0.1));
    const inlet = add(loft([
      [4.2, 0.44, 0.5, 0.6, -0.15, 8], [3.4, 0.46, 0.54, 0.64, -0.14, 8],
      [2.4, 0.48, 0.56, 0.68, -0.12, 8], [1.4, 0.48, 0.56, 0.7, -0.1, 8],
      [0.8, 0.5, 0.3, 0.7, -0.1, 8],
    ], 24), M.body);
    inlet.position.x = sgn * 1.36;
    // 바깥 윗모서리 둥근 비드 (모서리 각짐 완화)
    const bead = add(new THREE.CylinderGeometry(0.1, 0.1, 2.8, 10), M.body);
    bead.rotation.x = Math.PI / 2;
    bead.position.copy(P(2.8, sgn * 1.7, 0.22));
    // 흡입구 입구 (어두운 개구부, 아래가 앞으로 나온 사선)
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 1.1), M.inside);
    mouth.position.copy(P(4.16, sgn * 1.36, -0.2));
    mouth.rotation.x = 0.25;
    mouth.rotation.y = Math.PI;
    root.add(mouth);
    // 내부 램프 (위 밝은 회색에서 아래 검정으로 짙어지는 경사판)
    const ramp = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 1.0), rampMat);
    ramp.position.copy(P(3.8, sgn * 1.36, 0.28));
    ramp.rotation.x = -Math.PI / 2 + 0.55;
    ramp.rotation.y = Math.PI;
    root.add(ramp);
    // 상단 립 (앞으로 숙인 쐐기, 바깥 모서리가 아래로 기울어짐)
    const lip = add(new THREE.BoxGeometry(0.9, 0.06, 0.95), M.dark);
    lip.position.copy(P(4.3, sgn * 1.36, 0.42));
    lip.rotation.x = -0.15;
    lip.rotation.z = -0.08 * sgn;
    // 하단 립 (앞으로 나온 아랫입술)
    const lipLo = add(new THREE.BoxGeometry(0.95, 0.06, 0.9), M.dark);
    lipLo.position.copy(P(4.32, sgn * 1.36, -0.88));
  }
  // ---- 엔진 나셀 + 터키 페더 노즐 (페탈 디테일 + 어두운 캐비티)
  const nozzles = [];
  for (const sgn of [-1, 1]) {
    const nac = add(new THREE.CylinderGeometry(0.62, 0.64, 3.2, 28, 1, true), M.dark);
    nac.rotation.x = Math.PI / 2;
    nac.position.copy(P(-6.2, sgn * 0.68, -0.06));
    const noz = new THREE.Group();
    noz.position.copy(P(-7.8, sgn * 0.68, -0.06));
    // 노즐 외곽 원뿔면 (앞 넓고 뒤 좁은 수렴형, 티타늄 열변색)
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.63, 1.2, 30, 1, true), M.nozzle);
    cone.rotation.x = Math.PI / 2;
    cone.position.z = 0.6;
    cone.castShadow = true;
    noz.add(cone);
    // 터키 페더 이음 15줄 (원뿔면을 따라 길쭉하게 겹친 가는 띠)
    for (let pi = 0; pi < 15; pi++) {
      const a = (pi / 15) * Math.PI * 2;
      const holder = new THREE.Object3D();
      holder.rotation.z = a;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.055, 1.16), M.nozzle);
      strip.position.set(0.598, 0.028, 0.6);
      strip.rotation.y = -0.067; // 원뿔 수렴각을 따라 기울임
      strip.castShadow = true;
      holder.add(strip);
      noz.add(holder);
    }
    // 내부 어두운 캐비티 + 깊은 터빈면 (뒤에서 봐도 바큇살처럼 보이지 않게)
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.54, 1.1, 24, 1, true), M.nozzleIn);
    inner.rotation.x = Math.PI / 2;
    inner.position.z = 0.55;
    const turb = new THREE.Mesh(new THREE.CircleGeometry(0.48, 24), M.turbine);
    turb.position.z = 0.05;
    const back = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), new THREE.MeshBasicMaterial({ color: 0x0a0908 }));
    back.position.z = 0.04;
    // 애프터버너 발광판 (MIL 이하에서는 꺼둠, update에서 ab 때만 켬)
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.4, 24), new THREE.MeshBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.z = 0.35;
    noz.add(inner, back, turb, glow);
    root.add(noz);
    nozzles.push({ group: noz, inner, glow });
  }
  // 테일 붐 (미익 장착부)
  for (const sgn of [-1, 1]) {
    const boom = add(new THREE.BoxGeometry(0.32, 0.5, 4.8), M.body);
    boom.position.copy(P(-6.6, sgn * 1.62, -0.08));
  }
  // 테일콘 + 감속산 + 어레스팅 후크
  add(loft([
    [-6.6, 1.0, 0.4, 0.5, -0.05, 4], [-7.6, 0.72, 0.34, 0.42, -0.06, 4], [-8.3, 0.4, 0.24, 0.3, -0.06, 3.5],
  ], 24), M.body);
  const hook = add(new THREE.BoxGeometry(0.08, 0.1, 1.4), M.dark);
  hook.position.copy(P(-7.6, 0, -0.62));
  hook.rotation.z = 0.12;

  // ---- 주익 (대형 하이마운트 클립드 델타, 끝단 클립)
  const dih = -Math.tan(1 * Math.PI / 180);
  const wingSpec = (sgn) => ({
    rootLE: [2.9, sgn * 1.35, -0.28], rootTE: [-4.3, sgn * 1.35, -0.28],
    tipLE: [-2.55, sgn * 6.55, -0.28 + 5.2 * dih], tipTE: [-4.25, sgn * 6.55, -0.28 + 5.2 * dih],
    tdir: [0, 0, 1], thick: [0.05, 0.028], camber: 0.7,
  });
  const surfaces = {};
  for (const [sgn, name] of [[1, 'R'], [-1, 'L']]) {
    const spec = wingSpec(sgn);
    // 고정부 (플랩/에일러론 영역 제외)
    add(surface({ ...spec, u0: 0, u1: 1, v0: 0, v1: 0.06, nu: 12, nv: 1 }), M.body);
    add(surface({ ...spec, u0: 0, u1: 0.72, v0: 0.06, v1: 0.52, nu: 12, nv: 5 }), M.body);
    add(surface({ ...spec, u0: 0, u1: 1, v0: 0.52, v1: 0.6, nu: 12, nv: 1 }), M.body);
    add(surface({ ...spec, u0: 0, u1: 0.74, v0: 0.6, v1: 0.92, nu: 12, nv: 4 }), M.body);
    add(surface({ ...spec, u0: 0, u1: 1, v0: 0.92, v1: 1, nu: 12, nv: 1 }), M.body);
    const flap = controlSurface(spec, 0.72, 0.06, 0.52, M.body);
    const ail = controlSurface(spec, 0.74, 0.6, 0.92, M.body);
    root.add(flap, ail);
    surfaces['flap' + name] = flap;
    surfaces['ail' + name] = ail;
    // 윙팁 클립 단면 마감 스트립
    const tipStrip = add(new THREE.BoxGeometry(0.05, 0.09, 1.7), M.dark);
    tipStrip.position.copy(P(-3.4, sgn * 6.55, -0.37));
    // 파일런 + 발사 레일
    const pyl = add(new THREE.BoxGeometry(0.16, 0.5, 2.6), M.body);
    pyl.position.copy(P(-0.6, sgn * 3.4, -0.55));
    const rail = add(new THREE.BoxGeometry(0.1, 0.12, 2.2), M.dark);
    rail.position.copy(P(-0.5, sgn * 3.4, -0.84));
  }
  // 중앙선 파일런 (연료탱크 장착 위치, 평소에는 빈 파일런)
  const clPyl = add(new THREE.BoxGeometry(0.2, 0.5, 3.0), M.body);
  clPyl.position.copy(P(-0.8, 0, -0.95));

  // ---- 전가동 수평안정판 (스태빌레이터, 도그투스 앞전)
  for (const [sgn, name] of [[1, 'R'], [-1, 'L']]) {
    const pivotX = -7.0;
    const spec = {
      rootLE: [-5.2, sgn * 1.8, -0.1], rootTE: [-8.7, sgn * 1.8, -0.1],
      tipLE: [-7.9, sgn * 4.35, -0.1], tipTE: [-9.1, sgn * 4.35, -0.1],
      tdir: [0, 0, 1], thick: [0.045, 0.028], camber: 1,
    };
    const geo = surface({ ...spec, nu: 10, nv: 5, origin: [pivotX, 0, -0.1] });
    const mesh = new THREE.Mesh(geo, M.body);
    mesh.castShadow = mesh.receiveShadow = true;
    const pivot = new THREE.Object3D();
    pivot.position.copy(P(pivotX, 0, -0.1));
    pivot.userData.axis = new THREE.Vector3(1, 0, 0);
    pivot.add(mesh);
    root.add(pivot);
    surfaces['stab' + name] = pivot;
  }

  // ---- 쌍수직미익 + 러더 (바깥 기울기 0, 수직)
  for (const [sgn, name] of [[1, 'R'], [-1, 'L']]) {
    const spec = {
      rootLE: [-4.3, sgn * 1.62, 0.3], rootTE: [-8.15, sgn * 1.62, 0.3],
      tipLE: [-6.7, sgn * 1.62, 3.3], tipTE: [-7.9, sgn * 1.62, 3.5],
      tdir: [0, 1, 0], thick: [0.065, 0.045], camber: 1,
    };
    add(surface({ ...spec, u0: 0, u1: 1, v0: 0.55, v1: 1, nu: 10, nv: 4 }), M.body);
    add(surface({ ...spec, u0: 0, u1: 0.68, v0: 0, v1: 0.55, nu: 10, nv: 4 }), M.body);
    const rud = controlSurface(spec, 0.68, 0.02, 0.55, M.body, true);
    root.add(rud);
    surfaces['rud' + name] = rud;
    // 꼬리 표식 (코드 + 일련번호)
    const tex = textTexture(paint === 'aggressor'
      ? [{ text: '★', font: 'bold 70px Arial' }, { text: '65 AGRS', font: 'bold 30px Arial' }]
      : [{ text: 'EG', font: 'bold 64px Arial' }, { text: scheme.num, font: 'bold 26px Arial' }, { text: '33 FW', font: 'bold 24px Arial' }], 256, 200, paint === 'aggressor' ? '#8a1c1c' : '#2a3036');
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.15), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    decal.position.copy(P(-6.95, sgn * 1.78, 2.0));
    decal.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
    root.add(decal);
    // 미익 끝단 ECM 안테나 페어링 (위쪽 끝을 감싸는 덮개)
    const ecm = add(new THREE.BoxGeometry(0.14, 0.28, 0.8), M.dark);
    ecm.position.copy(P(-7.3, sgn * 1.62, 3.42));
  }

  // ---- 동체 측면 표식 (성조 문양 + USAF + 구조 표시)
  {
    const bars = starBarsTexture();
    for (const sgn of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.85), new THREE.MeshBasicMaterial({ map: bars, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      d.position.copy(P(0.6, sgn * 1.83, 0.1));
      d.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
      root.add(d);
      const t = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.32), new THREE.MeshBasicMaterial({ map: textTexture([{ text: 'U.S. AIR FORCE', font: 'bold 40px Arial' }], 512, 64, '#2a3036'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      t.position.copy(P(2.6, sgn * 1.83, -0.15));
      t.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
      root.add(t);
      // 구조 표시 (사출좌석 경고)
      const r = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.22), new THREE.MeshBasicMaterial({ map: textTexture([{ text: '▶ RESCUE', font: 'bold 34px Arial' }], 256, 64, '#8a1c1c'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      r.position.copy(P(5.2, sgn * 0.88, 0.25));
      r.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
      root.add(r);
    }
  }
  // 편대등 (가는 발광 띠)
  for (const sgn of [-1, 1]) {
    const slime = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.08), M.slime);
    slime.position.copy(P(-1.5, sgn * 1.83, 0.45));
    slime.rotation.y = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
    root.add(slime);
  }

  // ---- 안테나류
  {
    // 등 위 블레이드 안테나 2개 + 배 아래 블레이드
    const blade = (x, y, z, h) => {
      const b = add(new THREE.BoxGeometry(0.06, h, 0.3), M.dark);
      b.position.copy(P(x, y, z));
      return b;
    };
    blade(1.2, 0, 0.95, 0.35);
    blade(-3.2, 0, 0.85, 0.3);
    blade(-1.0, 0, -0.95, 0.3);
    // 기수 아래 IFF 안테나
    const iff = add(new THREE.BoxGeometry(0.3, 0.16, 0.08), M.dark);
    iff.position.copy(P(6.6, 0, -0.62));
    // 꼬리 끝 항법 안테나
    const whip = add(new THREE.CylinderGeometry(0.008, 0.012, 0.5, 6), M.dark);
    whip.rotation.x = Math.PI / 2;
    whip.position.copy(P(-8.5, 0, 0.0));
  }
  // M61 기관포 배출구 (우측 스트레이크)
  {
    const gun = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18), M.inside);
    gun.position.copy(P(3.4, 1.79, 0.1));
    gun.rotation.y = Math.PI / 2;
    root.add(gun);
  }

  // ---- 스피드 브레이크 (동체 상부, 앞쪽 힌지 + 리브)
  const sb = new THREE.Object3D();
  sb.position.copy(P(2.0, 0, 0.68));
  const sbMesh = add(new THREE.BoxGeometry(1.2, 0.05, 2.4), M.body, sb);
  sbMesh.position.set(0, 0, 1.2);
  for (let i = -2; i <= 2; i++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.02, 0.08), M.dark);
    rib.position.set(0, 0.035, 1.2 + i * 0.4);
    sb.add(rib);
  }
  root.add(sb);

  // ---- 버블 캐노피 (프레임 포함) + 조종사
  const canopyGroup = new THREE.Group();
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), M.glass);
  canopy.scale.set(0.62, 0.78, 2.0);
  canopy.position.copy(P(4.3, 0, 0.55));
  canopy.renderOrder = 2;
  canopyGroup.add(canopy);
  // 앞 윈드스크린 (경사진 별도 패널)
  const shield = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.glass);
  shield.scale.set(0.58, 0.7, 0.8);
  shield.position.copy(P(5.75, 0, 0.5));
  shield.rotation.x = 0.0;
  shield.renderOrder = 2;
  canopyGroup.add(shield);
  // 프레임: 좌우 방향(동체 단면) 반원 아치 2개 + 측면 실 (중심선 앞뒤 프레임 없음)
  const frameMat = M.dark;
  const arch = (x, z, r, rake, tube = 0.011) => {
    const f = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 40, Math.PI), frameMat);
    f.position.copy(P(x, 0, z));
    f.rotation.x = rake;
    f.castShadow = true;
    canopyGroup.add(f);
  };
  // 앞 아치는 카메라 바로 위·약간 뒤 (정면 시야에 안 들어옴), 뒤 아치도 얇게
  arch(4.55, 0.6, 0.66, 0.1);
  arch(3.3, 0.58, 0.62, 0.1);
  // 윈드실드 좌우 기둥 (옆 가장자리에 걸치게)
  for (const sgn of [-1, 1]) {
    const a = P(5.95, sgn * 0.58, 0.7), b = P(5.15, sgn * 0.48, 1.18);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, len, 6), frameMat);
    post.position.copy(a).addScaledVector(dir, 0.5);
    post.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    post.castShadow = true;
    canopyGroup.add(post);
  }
  for (const sgn of [-1, 1]) {
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 2.9), frameMat);
    sill.position.copy(P(4.55, sgn * 0.58, 0.6));
    sill.castShadow = true;
    canopyGroup.add(sill);
  }
  root.add(canopyGroup);
  const pilotGroup = new THREE.Group();
  const helmet = add(new THREE.SphereGeometry(0.15, 16, 12), M.helmet, pilotGroup);
  helmet.position.copy(P(4.25, 0, 0.98));
  // 바이저 (어두운 전면)
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12, -Math.PI / 2.6, Math.PI / 1.3, Math.PI / 3.4, Math.PI / 4), new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.15, metalness: 0.4 }));
  visor.position.copy(P(4.25, 0, 0.98));
  visor.rotation.y = -Math.PI / 2;
  pilotGroup.add(visor);
  // 산소 마스크 느낌의 아래턱
  const mask = add(new THREE.BoxGeometry(0.14, 0.14, 0.12), M.pilot, pilotGroup);
  mask.position.copy(P(4.38, 0, 0.88));
  const torso = add(new THREE.BoxGeometry(0.45, 0.55, 0.3), M.pilot, pilotGroup);
  torso.position.copy(P(4.15, 0, 0.62));
  for (const sgn of [-1, 1]) {
    const arm = add(new THREE.BoxGeometry(0.4, 0.16, 0.14), M.pilot, pilotGroup);
    arm.position.copy(P(4.35, sgn * 0.32, 0.62));
    const leg = add(new THREE.BoxGeometry(0.5, 0.18, 0.16), M.pilot, pilotGroup);
    leg.position.copy(P(4.7, sgn * 0.18, 0.5));
  }
  const seat = add(new THREE.BoxGeometry(0.55, 0.9, 0.2), M.inside, pilotGroup);
  seat.position.copy(P(3.9, 0, 0.75));
  root.add(pilotGroup);

  // ---- 조종석 내부 (조종석 시점 전용, GLB와 공용 빌더)
  const cockpitGroup = new THREE.Group();
  if (cockpit) {
    addCockpitInterior(cockpitGroup, P, M.gear);
    cockpitGroup.visible = false;
    root.add(cockpitGroup);
  }

  // ---- 무장 (AIM-9 x4 날개 파일런, AIM-120 x4 동체)
  const aim9 = [], aim120 = [];
  for (const [y, z] of [[3.4 - 0.32, -0.75], [3.4 + 0.32, -0.75]]) {
    for (const sgn of [-1, 1]) {
      const m = makeMissileMesh('AIM-9X', M);
      m.position.copy(P(-0.4, sgn * y, z));
      m.traverse(o => { o.castShadow = true; });
      root.add(m);
      aim9.push(m);
    }
  }
  for (const [x, y] of [[2.2, 1.42], [-2.6, 1.42]]) {
    for (const sgn of [-1, 1]) {
      const m = makeMissileMesh('AIM-120C', M);
      m.position.copy(P(x, sgn * y, -1.02));
      m.traverse(o => { o.castShadow = true; });
      root.add(m);
      aim120.push(m);
    }
  }

  // ---- 랜딩기어 (전방 접힘) + 기어 도어
  const gearDoors = [];
  const mkGear = (hinge, len, wheelR, wheelW, twin) => {
    const pivot = new THREE.Group();
    pivot.position.copy(P(...hinge));
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, len, 10), M.gear);
    strut.position.y = -len / 2;
    pivot.add(strut);
    // 스트럿 토크링크 (가느다란 보조봉)
    const link = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, len * 0.6, 6), M.dark);
    link.position.set(0.09, -len * 0.45, 0);
    link.rotation.z = 0.2;
    pivot.add(link);
    const wheelG = new THREE.Group();
    wheelG.position.y = -len;
    const tGeo = new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 20);
    tGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(wheelR * 0.55, wheelR * 0.55, wheelW * 1.05, 12);
    hubGeo.rotateZ(Math.PI / 2);
    for (const off of twin ? [-0.13, 0.13] : [0]) {
      const t = new THREE.Mesh(tGeo, M.tire); t.position.x = off; t.castShadow = true;
      const h = new THREE.Mesh(hubGeo, M.gear); h.position.x = off;
      wheelG.add(t, h);
    }
    pivot.add(wheelG);
    pivot.traverse(o => { o.castShadow = true; });
    root.add(pivot);
    return { pivot, wheelG, len, wheelR };
  };
  const gearZ = -2.2;
  const nose = mkGear([4.4, 0, -0.62], (-0.62 - (gearZ + 0.29)), 0.29, 0.18, true);
  const gL = mkGear([-0.75, -1.38, -0.7], (-0.7 - (gearZ + 0.42)), 0.42, 0.25, false);
  const gR = mkGear([-0.75, 1.38, -0.7], (-0.7 - (gearZ + 0.42)), 0.42, 0.25, false);
  const gears = [nose, gL, gR];
  // 기어 도어 (스트럿에 붙어 함께 움직임 + 고정식 뒷문)
  {
    const doorMat = M.body;
    const mkDoor = (w, h, x, y, z, parent) => {
      const d = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.03), doorMat);
      d.position.set(x, y, z);
      d.castShadow = true;
      parent.add(d);
      gearDoors.push(d);
      return d;
    };
    // 전륜: 스트럿 양옆 도어
    for (const sgn of [-1, 1]) mkDoor(0.03, 1.1, sgn * 0.2, -0.7, 0, nose.pivot);
    // 주륜: 스트럿 바깥 도어 + 동체 고정 뒷문
    mkDoor(0.03, 0.9, -0.28, -0.55, 0, gL.pivot);
    mkDoor(0.03, 0.9, 0.28, -0.55, 0, gR.pivot);
    for (const sgn of [-1, 1]) {
      const aft = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 1.1), doorMat);
      aft.position.copy(P(-1.7, sgn * 1.38, -0.78));
      aft.castShadow = true;
      root.add(aft);
    }
  }

  // ---- 애프터버너 화염 (다이아몬드 쇼크 콘 + 밝은 코어)
  const flames = [];
  for (let i = 0; i < 2; i++) {
    const sgn = i === 0 ? -1 : 1;
    const g = new THREE.Group();
    g.position.copy(P(-8.75, sgn * 0.68, -0.06));
    const mat = flameMaterial();
    const geo = new THREE.CylinderGeometry(0.46, 0.06, 1, 20, 8, true);
    geo.translate(0, -0.5, 0);
    geo.rotateX(-Math.PI / 2);
    const outerF = new THREE.Mesh(geo, mat);
    const innerF = new THREE.Mesh(geo, mat);
    innerF.scale.set(0.55, 0.55, 0.6);
    // 밝은 코어 (짧고 굵은 내부 화염)
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false });
    const coreGeo = new THREE.CylinderGeometry(0.2, 0.03, 1, 12, 4, true);
    coreGeo.translate(0, -0.5, 0);
    coreGeo.rotateX(-Math.PI / 2);
    const coreF = new THREE.Mesh(coreGeo, coreMat);
    g.add(outerF, innerF, coreF);
    g.visible = false;
    root.add(g);
    flames.push({ g, mat, outerF, innerF, coreF });
  }

  // ---- 항법등 / 충돌방지등 (빨강 좌·초록 우·흰색 꼬리 + 스트로브 + 비컨)
  const glowTex = glowTexture();
  const mkLight = (color, p, size = 1.4) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    sp.scale.setScalar(size);
    sp.position.copy(p);
    root.add(sp);
    return sp;
  };
  // 점광원 크기 작게 (근거리 약 0.3 m), 블룸 과다 방지
  const navL = mkLight(0xff2020, P(-2.6, -6.55, -0.4), 0.3);
  const navR = mkLight(0x20ff40, P(-2.6, 6.55, -0.4), 0.3);
  const navTail = mkLight(0xffffff, P(-8.4, 0, -0.1), 0.25);
  const strobes = [mkLight(0xffffff, P(-7.3, -1.7, 3.45), 0.55), mkLight(0xffffff, P(-7.3, 1.7, 3.45), 0.55)];
  const beaconTop = mkLight(0xff3020, P(-2.0, 0, 0.95), 0.35);
  const beaconBelly = mkLight(0xff3020, P(0.5, 0, -1.0), 0.35);

  root.traverse(o => { if (o.isMesh && o.material !== M.glass) { o.castShadow = true; o.receiveShadow = true; } });

  const parts = { surfaces, sb, canopy, pilotGroup, cockpitGroup, aim9, aim120, gears, flames, nozzles, navL, navR, navTail, strobes, beaconTop, beaconBelly };
  const D = Math.PI / 180;

  /** 비행모델 상태로 시각 요소 갱신 */
  function update(fm, time, opts = {}) {
    const s = fm.surf;
    const setRot = (pivot, ang) => pivot.quaternion.setFromAxisAngle(pivot.userData.axis, ang);
    // 스태빌레이터: 기수올림(de>0) → 뒷전 위. 차동 작동으로 롤 보조
    setRot(surfaces.stabR, -(s.de + 0.45 * s.da));
    setRot(surfaces.stabL, -(s.de - 0.45 * s.da));
    setRot(surfaces.ailR, -s.da);
    setRot(surfaces.ailL, s.da);
    setRot(surfaces.flapR, fm.flapPos * 30 * D);
    setRot(surfaces.flapL, fm.flapPos * 30 * D);
    setRot(surfaces.rudR, s.dr);
    setRot(surfaces.rudL, s.dr);
    sb.rotation.x = -fm.sbPos * 45 * D;   // 뒷전이 위로 열림
    // 기어 (gearPos 1 = 내림)
    for (let i = 0; i < 3; i++) {
      const gg = gears[i];
      gg.pivot.rotation.x = (1 - fm.gearPos) * (Math.PI / 2) * (i === 0 ? 1 : 1);
      gg.pivot.visible = fm.gearPos > 0.02;
      gg.wheelG.position.y = -gg.len + (fm.gearContact?.[i] || 0);
      if (i === 0) gg.wheelG.rotation.y = -fm.steer;
    }
    // 엔진/화염 (스로틀에 따라 길이·밝기 변화)
    for (let i = 0; i < 2; i++) {
      const en = fm.engines ? fm.engines[i] : { ab: 0, n: 0, nozzle: 0.5 };
      const f = flames[i], nz = nozzles[i];
      const ab = en.ab || 0;
      f.g.visible = ab > 0.02;
      if (f.g.visible) {
        const flick = 1 + 0.06 * Math.sin(time * 47 + i * 2);
        const len = (1.6 + 5.2 * ab) * flick;
        f.outerF.scale.set(0.85 + 0.2 * ab, 0.85 + 0.2 * ab, len);
        f.innerF.scale.set(0.5, 0.5, len * 0.55);
        f.coreF.scale.set(0.9, 0.9, 0.6 + 1.8 * ab);
        f.coreF.material.opacity = clamp(0.35 + 0.6 * ab, 0, 1);
        f.mat.uniforms.uTime.value = time;
        f.mat.uniforms.uIntensity.value = 0.55 + 0.6 * ab;
        if (f.mat.uniforms.uThrottle) f.mat.uniforms.uThrottle.value = clamp(ab, 0.05, 1);
      }
      // MIL 이하에서는 발광 없음, 애프터버너일 때만 발광
      nz.glow.material.opacity = clamp((ab - 0.02) * 1.6, 0, 1);
      const open = 1 + (en.nozzle || 0) * 0.12;
      nz.inner.scale.set(open, 1, open);
    }
    // 무장 표시
    if (opts.stores) {
      for (let i = 0; i < 4; i++) { aim9[i].visible = i < opts.stores.aim9; aim120[i].visible = i < opts.stores.aim120; }
    }
    // 등화: 스트로브 이중 점멸 + 비컨 회전등 느낌
    const cyc = time % 1.4;
    const strobeOn = cyc < 0.05 || (cyc > 0.12 && cyc < 0.17);
    for (const st of strobes) st.visible = strobeOn;
    const beaconOn = (time % 1.0) < 0.5;
    beaconTop.visible = beaconBelly.visible = beaconOn;
    const navOn = opts.lights !== false;
    navL.visible = navR.visible = navTail.visible = navOn;
  }

  root.userData.update = update;
  root.userData.parts = parts;
  // 1인칭 검증: 조종사 눈(로컬 0, 1.12, -4.75) 근처 0.3 m 안에 시야 중앙을 가리는 메시가 없는지 확인
  if (cockpit) {
    try {
      const eye = new THREE.Vector3(0, 1.12, -4.75);
      const viewDir = new THREE.Vector3(0, -0.07, -1).normalize();
      const showC = cockpitGroup.visible, showP = pilotGroup.visible;
      cockpitGroup.visible = true;
      pilotGroup.visible = false;
      root.updateMatrixWorld(true);
      const near = [];
      const v = new THREE.Vector3(), vd = new THREE.Vector3();
      root.traverse(o => {
        if (!o.isMesh || !o.visible) return;
        const g = o.geometry;
        if (!g) return;
        if (!g.boundingSphere) g.computeBoundingSphere();
        const s = g.boundingSphere.clone().applyMatrix4(o.matrixWorld);
        vd.copy(s.center).sub(eye);
        const dist = Math.max(0, vd.length() - s.radius);
        if (dist > 0.5) return;
        const ang = vd.lengthSq() > 1e-9 ? vd.normalize().angleTo(viewDir) * 180 / Math.PI : 0;
        const col = o.material && o.material.color ? '#' + o.material.color.getHexString() : '?';
        near.push({ d: dist, a: ang, info: `${g.type} ${col} @(${s.center.x.toFixed(2)},${s.center.y.toFixed(2)},${s.center.z.toFixed(2)})` });
      });
      cockpitGroup.visible = showC;
      pilotGroup.visible = showP;
      const bad = near.filter(e => e.d < 0.3 && e.a < 35);
      if (bad.length) console.warn('[기체모델] 1인칭 눈앞 장애물', bad);
    } catch (e) { /* 검증 실패는 무시 (렌더에 영향 없음) */ }
  }
  return root;
}
