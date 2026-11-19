// HUD (헤드업 표시기) + MFD 패널 + 레이더 스코프 + 텔레메트리 (2D 캔버스 오버레이)
// 전면 재디자인: F-15C 스타일 단색 그린 HUD, MFD 1기(좌하단), 베젤 레이더(우하단), 한 줄 메시지 띠
import * as THREE from 'three';
import { R2D, D2R, MS2KT, M2FT, KG2LB, clamp, G0 } from './math.js';
import { gunLead, MISSILES } from './weapons.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _p = new THREE.Vector3();
const NM = 1852;

// 단색 HUD 그린 (약 #7dff9a, 알파 0.9). MFD는 배경 어둡게 + 그린/흰/앰버/빨강만 쓴다.
const H_GREEN = 'rgba(125,255,154,0.92)';
const H_DIM = 'rgba(125,255,154,0.45)';
const H_FAINT = 'rgba(125,255,154,0.22)';
const C_WHITE = 'rgba(232,242,236,0.92)';
const C_WHITE_DIM = 'rgba(232,242,236,0.38)';
const C_AMBER = 'rgba(232,163,61,0.95)';
const C_RED = 'rgba(255,90,74,0.95)';
const MONO = '"IBM Plex Mono","JetBrains Mono",Consolas,"D2Coding",monospace';
const SANS = '"Pretendard","IBM Plex Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif';

export class HUD {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = 0; this.H = 0; this.dpr = 1;
    this.showTelemetry = false;
    this.radarRange = 40000;
    this.radarAuto = false;
    this.blink = 0;
    this.color = H_GREEN;
    this.ui = 1; // 해상도 대응 UI 스케일 (CSS 픽셀 기준)
  }
  resize(w, h) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = w; this.H = h;
    this.cv.width = w * this.dpr; this.cv.height = h * this.dpr;
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.ui = clamp(Math.min(w, h) / 860, 0.72, 1.35);
  }

  /** 월드 점 → 화면 좌표 */
  project(p, cam) {
    _w.copy(p).applyMatrix4(cam.matrixWorldInverse);
    const front = _w.z < 0;
    _v.copy(p).project(cam);
    return { x: (_v.x + 1) * 0.5 * this.W, y: (1 - _v.y) * 0.5 * this.H, front };
  }
  projDir(d, cam) { return this.project(_p.copy(cam.position).addScaledVector(d, 1000), cam); }

  draw(game, cam, dt) {
    const ctx = this.ctx;
    this.blink = (this.blink + dt) % 1;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    const pl = game.player;
    if (!pl) return;
    const cockpit = game.camMode === 'cockpit';
    this.f = this.H / (2 * Math.tan((cam.fov * D2R) / 2));

    // 태양 렌즈 플레어 (지형에 가려지면 표시 안 함)
    this.drawSunFlare(game, cam);
    // G 효과(시야 협착/블랙아웃/레드아웃)
    this.drawGEffects(game);

    if (pl.alive && game.hudOn) {
      if (cockpit) this.drawConformal(game, cam);
      else this.drawExternal(game, cam);
      this.drawTargets(game, cam);
    }
    this.drawPanel(game);
    this.drawRadar(game);
    if (this.showTelemetry) this.drawTelemetry(game);
    this.drawMessages(game);
  }

  // 작은 글자 하한: 화면 높이 600px → 11px, 1080px → 14px 사이 선형 보간
  fz(px) {
    const f = this.H <= 600 ? 11 : this.H >= 1080 ? 14 : 11 + (this.H - 600) * 3 / 480;
    return Math.max(px * this.ui, f * Math.min(1, px / 11));
  }
  // HUD 공통 스타일: 얇은 선 + 단색 그린. shadowBlur 없이 halo 래퍼로 가독성 확보.
  hudStyle(u) {
    const ctx = this.ctx;
    ctx.strokeStyle = H_GREEN; ctx.fillStyle = H_GREEN;
    ctx.lineWidth = 1.1 * u;
    ctx.shadowBlur = 0;
    this.haloOn();
  }
  hudClear() { this.haloOff(); }
  // halo: 이후 stroke/fillText/fillRect 호출마다 어두운 외곽을 먼저 그린다 (밝은 하늘 대응)
  haloOn() {
    const ctx = this.ctx;
    if (ctx._halo) return;
    ctx._halo = true;
    ctx._stroke0 = ctx.stroke;
    ctx._fillText0 = ctx.fillText;
    ctx._fillRect0 = ctx.fillRect;
    ctx._strokeText0 = ctx.strokeText;
    const self = this;
    ctx.stroke = function (...a) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(0,20,10,0.6)';
      ctx.lineWidth = (ctx.lineWidth || 1) + 1.8 * self.ui;
      ctx._stroke0(...a);
      ctx.restore();
      ctx._stroke0(...a);
    };
    ctx.fillText = function (t, x, y, ...a) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(0,20,10,0.6)';
      ctx.lineWidth = 3 * self.ui;
      ctx.lineJoin = 'round';
      try { ctx._strokeText0(t, x, y, ...a); } catch (e) { /* 구형 캔버스 대비 */ }
      ctx.restore();
      ctx._fillText0(t, x, y, ...a);
    };
    ctx.fillRect = function (...a) {
      ctx._fillRect0(...a);
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(0,20,10,0.6)';
      ctx.lineWidth = 1.5 * self.ui;
      try { ctx.strokeRect(...a); } catch (e) { /* 무시 */ }
      ctx.restore();
    };
  }
  haloOff() {
    const ctx = this.ctx;
    if (!ctx._halo) return;
    ctx.stroke = ctx._stroke0; ctx.fillText = ctx._fillText0; ctx.fillRect = ctx._fillRect0;
    delete ctx._stroke0; delete ctx._fillText0; delete ctx._fillRect0; delete ctx._strokeText0; delete ctx._halo;
  }

  // ------------------------------------------------------------------ 조종석 HUD (정합형, HUD 유리 영역 안만)
  drawConformal(game, cam) {
    const ctx = this.ctx, pl = game.player, fm = pl.fm, s = fm.s, f = this.f;
    const u = this.ui, W = this.W, H = this.H;
    // 유리: 보어사이트 투영점 기준. 위 = bs.y-0.20H, 아래 = min(bs.y+0.15H, 0.62H).
    const fwd = _r.set(0, 0, -1).applyQuaternion(fm.quat).clone();
    const bs = this.projDir(fwd, cam);
    if (!bs.front) return;
    const gy1 = Math.min(bs.y + H * 0.15, H * 0.62);
    const gy0 = Math.max(8, Math.min(bs.y - H * 0.20, gy1 - 120 * u));
    const gh = gy1 - gy0, gw = gh * 1.18;
    const gcx = clamp(bs.x, gw / 2 + 8, W - gw / 2 - 8);
    const gx0 = gcx - gw / 2, gx1 = gcx + gw / 2;
    // 조준 심볼은 실제 보어사이트 투영점 기준 (화면 고정점 사용 금지)
    const cx = bs.x, cy = bs.y;
    const hw = gw / 2, top = gy0, bot = gy1;
    ctx.save();
    ctx.beginPath(); ctx.rect(gx0, gy0, gw, gh); ctx.clip();

    this.hudStyle(u);
    ctx.font = `${Math.round(this.fz(11))}px ${MONO}`;
    ctx.textBaseline = 'middle';

    // --- 피치 래더 (속도벡터 방위 기준, 양수 실선 / 음수 점선)
    const vel = fm.vel.clone();
    const spd = vel.length();
    const trk = spd > 15 ? Math.atan2(vel.x, -vel.z) : s.heading;
    const gam = spd > 15 ? s.gamma : s.theta;
    const right = new THREE.Vector3(Math.cos(trk), 0, Math.sin(trk));
    const dirAt = (p) => new THREE.Vector3(Math.sin(trk) * Math.cos(p), Math.sin(p), -Math.cos(trk) * Math.cos(p));
    const pt = (dir, off) => this.projDir(_f.copy(dir).addScaledVector(right, off).normalize(), cam);
    const g0 = Math.round(gam * R2D / 5) * 5;
    ctx.lineWidth = 0.9 * u; // 래더는 외부 시점보다 약간 얇게
    for (let p = g0 - 30; p <= g0 + 30; p += 5) {
      if (p < -90 || p > 90) continue;
      const d = dirAt(p * D2R);
      if (p === 0) {
        const a = pt(d, -0.55), b = pt(d, -0.05), c = pt(d, 0.05), e = pt(d, 0.55);
        if (!a.front || !e.front) continue;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(e.x, e.y); ctx.stroke();
        continue;
      }
      const w0 = 0.03, w1 = 0.07;
      const a = pt(d, -w1), b = pt(d, -w0), c = pt(d, w0), e = pt(d, w1);
      if (!a.front || !e.front) continue;
      // 유리 밖 바는 그리지 않음
      const mx = (a.x + e.x) / 2, my = (a.y + e.y) / 2;
      if (mx < gx0 + 4 || mx > gx1 - 4 || my < gy0 + 4 || my > gy1 - 4) continue;
      ctx.setLineDash(p < 0 ? [5 * u, 4 * u] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.moveTo(c.x, c.y); ctx.lineTo(e.x, e.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // 숫자는 우측에만 작게 (유리 안에 들어갈 때만)
      if (Math.abs(p) >= 10) {
        const dx = e.x - a.x, dy = e.y - a.y;
        const ang = Math.atan2(dy, dx);
        const nx = e.x + Math.cos(ang) * 10 * u, ny = e.y + Math.sin(ang) * 10 * u - 6 * u;
        if (nx > gx0 + 4 && nx < gx1 - 4 && ny > gy0 + 4 && ny < gy1 - 4) {
          ctx.font = `${Math.round(this.fz(9))}px ${MONO}`;
          ctx.fillText(String(Math.abs(p)), nx, ny);
          ctx.font = `${Math.round(this.fz(11))}px ${MONO}`;
        }
      }
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 1.1 * u;

    // --- 비행경로 표시기 (FPM)
    let fpmX = cx, fpmY = cy;
    if (spd > 15) {
      const fp = this.projDir(vel.normalize(), cam);
      if (fp.front) { fpmX = fp.x; fpmY = fp.y; }
    }
    const m = 22 * u;
    const caged = fpmX < cx - hw + m || fpmX > cx + hw - m || fpmY < top + m || fpmY > bot - m;
    fpmX = clamp(fpmX, cx - hw + m, cx + hw - m); fpmY = clamp(fpmY, top + m, bot - m);
    ctx.beginPath(); ctx.arc(fpmX, fpmY, 6.5 * u, 0, Math.PI * 2);
    ctx.moveTo(fpmX - 6.5 * u, fpmY); ctx.lineTo(fpmX - 18 * u, fpmY);
    ctx.moveTo(fpmX + 6.5 * u, fpmY); ctx.lineTo(fpmX + 18 * u, fpmY);
    ctx.moveTo(fpmX, fpmY - 6.5 * u); ctx.lineTo(fpmX, fpmY - 13 * u); ctx.stroke();
    if (caged) {
      ctx.beginPath();
      ctx.moveTo(fpmX - 8 * u, fpmY - 8 * u); ctx.lineTo(fpmX + 8 * u, fpmY + 8 * u);
      ctx.moveTo(fpmX + 8 * u, fpmY - 8 * u); ctx.lineTo(fpmX - 8 * u, fpmY + 8 * u);
      ctx.stroke();
    }

    // --- 워터라인 (기수 기준선)
    ctx.beginPath();
    ctx.moveTo(cx - 26 * u, cy); ctx.lineTo(cx - 8 * u, cy); ctx.lineTo(cx - 4 * u, cy + 5 * u);
    ctx.moveTo(cx + 26 * u, cy); ctx.lineTo(cx + 8 * u, cy); ctx.lineTo(cx + 4 * u, cy + 5 * u);
    ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + 5 * u);
    ctx.stroke();

    // --- 좌 속도 / 우 고도 박스 (유리 상단 모서리, 래더와 분리)
    const boxY = top + 10 * u, bw = 62 * u, bh = 20 * u;
    this.hudBox(gx0 + 8 * u, boxY, bw, bh, String(Math.round(s.cas * MS2KT)));
    this.hudBox(gx1 - 8 * u - bw, boxY, bw, bh, this.fmtAlt(fm.pos.y * M2FT));
    // 상시 숫자는 속도·고도·G만 (M·VVI·R·받음각 삭제)
    ctx.textAlign = 'left';
    ctx.fillText(`G ${s.nz.toFixed(1)}`, gx0 + 8 * u, boxY + bh + 13 * u);

    // --- 방위 테이프 (하단)
    const hdg = ((s.heading * R2D) % 360 + 360) % 360;
    const ty = bot - 16 * u;
    ctx.textAlign = 'center';
    for (let dd = -20; dd <= 20; dd += 5) {
      const h = Math.round(hdg / 5) * 5 + dd;
      const x = cx + (h - hdg) * 6 * u;
      const hh = ((h % 360) + 360) % 360;
      ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x, ty - (hh % 10 === 0 ? 8 * u : 4 * u)); ctx.stroke();
      if (hh % 10 === 0) ctx.fillText(String(hh / 10).padStart(2, '0'), x, ty - 13 * u);
    }
    ctx.beginPath();
    ctx.moveTo(cx, ty + 1); ctx.lineTo(cx - 4 * u, ty + 7 * u); ctx.lineTo(cx + 4 * u, ty + 7 * u);
    ctx.closePath(); ctx.stroke();

    // --- 선택 무장 (짧게, 하단 좌측 — 테이프와 분리)
    ctx.textAlign = 'left';
    ctx.fillText(this.wShort(game), gx0 + 8 * u, bot - 46 * u);
    // 기관포 잔탄 막대 (GUN 선택 시만)
    if (game.player.weapon === 'GUN' || game.player.gunAlways) {
      const gbw = 46 * u, gfrac = clamp(fm.ammo / 940, 0, 1);
      ctx.fillStyle = 'rgba(232,242,236,0.16)';
      ctx.fillRect(gx0 + 8 * u, bot - 40 * u, gbw, 3.5 * u);
      ctx.fillStyle = gfrac < 0.2 ? C_AMBER : H_GREEN;
      ctx.fillRect(gx0 + 8 * u, bot - 40 * u, gbw * gfrac, 3.5 * u);
    }

    // --- 무장 조준 심볼
    this.drawWeaponSymbology(game, cam, { cx, cy, hw, top, bot });
    // --- 경고 (HUD 안)
    this.drawWarnings(game, cx, cy + 58 * u);
    this.haloOff();
    ctx.restore();
  }

  fmtAlt(ft) {
    ft = Math.round(ft / 10) * 10;
    if (ft >= 1000) return `${Math.floor(ft / 1000)},${String(ft % 1000).padStart(3, '0')}`;
    return String(ft);
  }
  // 작은 HUD 숫자 박스 (단정한 헤어라인)
  hudBox(x, y, w, h, txt) {
    const ctx = this.ctx, u = this.ui;
    ctx.strokeRect(x, y, w, h);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.font = `600 ${Math.round(this.fz(14))}px ${MONO}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, x + w - 5 * u, y + h / 2 + 1);
    ctx.restore();
  }
  // 예전 box API 유지 (외부 시점용 별칭)
  box(x, y, w, h, txt) { this.hudBox(x, y, w, h, txt); }
  // 선택 무장 짧게 (예: 'SRM 4')
  wShort(game) {
    const pl = game.player;
    if (pl.weapon === 'GUN') return 'GUN';
    if (pl.weapon === 'SRM') return `SRM ${pl.stores.aim9}`;
    return `MRM ${pl.stores.aim120}`;
  }

  // ------------------------------------------------------------------ 외부/추적 시점: 중앙 축소·간소화 HUD
  drawExternal(game, cam) {
    const ctx = this.ctx, pl = game.player, fm = pl.fm, s = fm.s, u = this.ui;
    const W = this.W, H = this.H;
    const cx = W / 2, cy = H * 0.44;
    ctx.save();
    this.hudStyle(u);
    ctx.font = `${Math.round(this.fz(11))}px ${MONO}`;
    ctx.textBaseline = 'middle';
    // 중앙 워터라인 십자 (간소)
    ctx.beginPath();
    ctx.moveTo(cx - 22 * u, cy); ctx.lineTo(cx - 7 * u, cy);
    ctx.moveTo(cx + 7 * u, cy); ctx.lineTo(cx + 22 * u, cy);
    ctx.moveTo(cx, cy - 8 * u); ctx.lineTo(cx, cy - 2 * u);
    ctx.stroke();
    // 속도/고도 박스 축소판
    const bw = 58 * u, bh = 19 * u;
    this.hudBox(cx - 150 * u, cy - 10 * u, bw, bh, String(Math.round(s.cas * MS2KT)));
    this.hudBox(cx + 150 * u - bw, cy - 10 * u, bw, bh, this.fmtAlt(fm.pos.y * M2FT));
    ctx.textAlign = 'left';
    ctx.fillText(`G ${s.nz.toFixed(1)}`, cx - 150 * u, cy + 22 * u);
    ctx.fillText(this.wShort(game), cx - 150 * u, cy + 36 * u);
    // 방위 숫자는 박스 줄 위 중앙에 작게 통합
    const hdg = ((s.heading * R2D) % 360 + 360) % 360;
    ctx.font = `${Math.round(this.fz(10))}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(hdg) % 360).padStart(3, '0'), cx, cy - 30 * u);
    // 무장 조준(표적 박스/조준점만)
    this.drawWeaponSymbology(game, cam, { cx, cy: H / 2, hw: W / 2, top: 0, bot: H, external: true });
    this.drawWarnings(game, cx, H * 0.6);
    this.haloOff();
    ctx.restore();
  }

  // ------------------------------------------------------------------ 무장 심볼 (기존 기능 유지, 선만 정갈하게)
  drawWeaponSymbology(game, cam, box) {
    const ctx = this.ctx, pl = game.player, fm = pl.fm, f = this.f, u = this.ui;
    const tgt = pl.lock;
    const wpn = pl.weapon;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(fm.quat);
    const bs = this.projDir(fwd, cam);
    this.hudStyle(u);
    ctx.font = `${Math.round(this.fz(11))}px ${MONO}`;
    // 표적 지정 박스 (TD box)
    if (tgt && tgt.alive) {
      const p = this.project(tgt.fm.pos, cam);
      const range = tgt.fm.pos.distanceTo(fm.pos);
      const los = _r.subVectors(tgt.fm.pos, fm.pos).normalize();
      const vc = -los.dot(_v.subVectors(tgt.fm.vel, fm.vel));
      const inBox = p.front && p.x > box.cx - box.hw && p.x < box.cx + box.hw && p.y > box.top && p.y < box.bot;
      if (inBox) {
        ctx.strokeRect(p.x - 12 * u, p.y - 12 * u, 24 * u, 24 * u);
      } else if (bs.front) {
        const ang = Math.acos(clamp(fwd.dot(los), -1, 1)) * R2D;
        const dir = p.front ? Math.atan2(p.y - bs.y, p.x - bs.x) : Math.atan2(-(p.y - bs.y), -(p.x - bs.x));
        ctx.beginPath(); ctx.moveTo(bs.x, bs.y); ctx.lineTo(bs.x + Math.cos(dir) * 60 * u, bs.y + Math.sin(dir) * 60 * u); ctx.stroke();
        ctx.textAlign = 'center'; ctx.fillText(Math.round(ang) + '°', bs.x + Math.cos(dir) * 74 * u, bs.y + Math.sin(dir) * 74 * u);
      }
      ctx.textAlign = 'right';
      const ry = box.external ? this.H * 0.44 + 40 * u : box.bot - 58 * u;
      const rx = box.external ? this.W / 2 + 150 * u : box.cx + box.hw - 8 * u;
      ctx.fillText(`${(range / NM).toFixed(1)}`, rx, ry);
      ctx.fillText(`${Math.round(vc * MS2KT)}`, rx, ry + 13 * u);
      // 기관포 리드 조준점 (LCOS)
      if ((wpn === 'GUN' || pl.gunAlways) && range < 3000) {
        const lead = gunLead(pl, tgt, new THREE.Vector3());
        const lp = this.projDir(lead.dir, cam);
        if (lp.front) {
          ctx.beginPath(); ctx.arc(lp.x, lp.y, 20 * u, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.arc(lp.x, lp.y, 1.8 * u, 0, Math.PI * 2); ctx.fill();
          const frac = clamp(range / 2200, 0, 1);
          ctx.lineWidth = 3 * u;
          ctx.beginPath(); ctx.arc(lp.x, lp.y, 20 * u, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
          ctx.lineWidth = 1.1 * u;
          const err = Math.hypot(lp.x - bs.x, lp.y - bs.y);
          if (range < 1100 && err < 22 * u) { ctx.textAlign = 'center'; if (this.blink < 0.6) ctx.fillText('SHOOT', bs.x, bs.y + 44 * u); }
        }
      }
    }
    if ((wpn === 'GUN' || pl.gunAlways) && !(tgt && tgt.alive && tgt.fm.pos.distanceTo(fm.pos) < 3000) && bs.front) {
      ctx.beginPath(); ctx.arc(bs.x, bs.y + Math.tan(1.5 * D2R) * f, Math.tan(1.6 * D2R) * f, 0, Math.PI * 2); ctx.stroke();
    }
    if (wpn === 'SRM') {
      const st = pl.seeker;
      if (st.target) {
        const p = this.project(st.target.fm.pos, cam);
        if (p.front) { ctx.beginPath(); ctx.arc(p.x, p.y, 14 * u, 0, Math.PI * 2); ctx.stroke(); }
      } else if (bs.front) {
        ctx.beginPath(); ctx.arc(bs.x, bs.y, Math.tan(3 * D2R) * f, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (wpn === 'MRM' && bs.front) {
      ctx.beginPath(); ctx.arc(bs.x, bs.y, Math.tan(10 * D2R) * f, 0, Math.PI * 2); ctx.stroke();
    }
    if ((wpn === 'MRM' || wpn === 'SRM') && tgt && tgt.alive) {
      const dlz = pl.dlz(wpn, tgt);
      const x = box.external ? this.W / 2 + 176 * u : box.cx + box.hw - 30 * u;
      const y0 = box.external ? this.H * 0.3 : box.top + 64 * u, h = 130 * u;
      const scale = dlz.rMax * 1.3;
      const yOf = (r) => y0 + h - clamp(r / scale, 0, 1) * h;
      ctx.beginPath(); ctx.moveTo(x, yOf(dlz.rMin)); ctx.lineTo(x, yOf(dlz.rMax)); ctx.stroke();
      for (const r of [dlz.rMin, dlz.rMax]) { ctx.beginPath(); ctx.moveTo(x - 5 * u, yOf(r)); ctx.lineTo(x + 5 * u, yOf(r)); ctx.stroke(); }
      ctx.fillRect(x - 3 * u, yOf(dlz.rNe), 6 * u, yOf(dlz.rMin) - yOf(dlz.rNe));
      const ry = yOf(dlz.range);
      ctx.beginPath(); ctx.moveTo(x - 7 * u, ry); ctx.lineTo(x - 15 * u, ry - 4 * u); ctx.lineTo(x - 15 * u, ry + 4 * u); ctx.closePath(); ctx.fill();
      if (dlz.inRange && bs.front && this.blink < 0.6) { ctx.textAlign = 'center'; ctx.fillText('SHOOT', bs.x, bs.y + 44 * u); }
    }
  }

  // 경고는 최대 2개만, 미사일 경보는 크게. 그 외는 조용히.
  drawWarnings(game, x, y) {
    const ctx = this.ctx, u = this.ui, w = game.player.warnings;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const show = this.blink < 0.55;
    const crit = w.filter(k => /MISSILE|PULL/i.test(k.text));
    const rest = w.filter(k => !/MISSILE|PULL/i.test(k.text)).slice(0, 1);
    let yy = y;
    for (const k of [...crit, ...rest]) {
      if (k.blink && !show) { yy += 22 * u; continue; }
      const big = /MISSILE|PULL/i.test(k.text);
      ctx.font = big ? `700 ${Math.round(this.fz(17))}px ${SANS}` : `600 ${Math.round(this.fz(12))}px ${MONO}`;
      ctx.fillStyle = k.color === '#ff4040' ? C_RED : (k.color === '#ffc24a' ? C_AMBER : H_GREEN);
      ctx.fillText(k.text, x, yy);
      yy += (big ? 24 : 17) * u;
    }
    // 미사일 경보 방향 화살 (작게)
    for (const mdir of game.player.threatDirs || []) {
      ctx.save();
      ctx.translate(x, y - 110 * u);
      ctx.rotate(mdir);
      ctx.fillStyle = C_RED;
      ctx.beginPath(); ctx.moveTo(0, -80 * u); ctx.lineTo(-7 * u, -66 * u); ctx.lineTo(7 * u, -66 * u); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ 표적 마커 (식별 보조 — 문자 최소화)
  drawTargets(game, cam, cockpit) {
    const ctx = this.ctx, pl = game.player, u = this.ui;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.1 * u;
    ctx.font = `${Math.round(this.fz(10))}px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const e of game.aircraft) {
      if (e === pl || !e.alive) continue;
      const d = e.fm.pos.distanceTo(pl.fm.pos);
      if (d > 60000) continue;
      const p = this.project(e.fm.pos, cam);
      if (!p.front || p.x < 0 || p.x > this.W || p.y < 0 || p.y > this.H) continue;
      const locked = pl.lock === e;
      const hostile = e.side !== pl.side;
      ctx.strokeStyle = ctx.fillStyle = locked ? C_RED : (hostile ? C_AMBER : H_DIM);
      const r = 6 * u, oy = 10 * u;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - r - oy); ctx.lineTo(p.x + r, p.y - oy); ctx.lineTo(p.x, p.y + r - oy); ctx.lineTo(p.x - r, p.y - oy);
      ctx.closePath(); ctx.stroke();
      // 거리는 록온 표적만
      if (locked) ctx.fillText(`${(d / 1000).toFixed(1)}`, p.x, p.y - oy - r - 9 * u);
    }
    // 미사일: 아군(흰 점), 적(빨강 점멸)
    for (const m of game.weapons.missiles) {
      if (!m.alive) continue;
      const p = this.project(m.pos, cam);
      if (!p.front) continue;
      if (m.owner === pl) { ctx.strokeStyle = C_WHITE_DIM; ctx.beginPath(); ctx.arc(p.x, p.y, 2.5 * u, 0, Math.PI * 2); ctx.stroke(); }
      else if (this.blink < 0.6) { ctx.fillStyle = C_RED; ctx.beginPath(); ctx.arc(p.x, p.y, 3 * u, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ 좌하단 MFD 1기: 엔진·연료·무장·상태
  drawPanel(game) {
    const ctx = this.ctx, pl = game.player, fm = pl.fm, u = this.ui;
    const w = 218 * u, h = 168 * u, x = 12 * u, y = this.H - h - 12 * u;
    ctx.save();
    ctx.shadowBlur = 0;
    this.mfdFrame(x, y, w, h);
    const px = x + 10 * u;
    let yy = y + 12 * u;
    ctx.textBaseline = 'middle';

    // 엔진 RPM 아크 2개 (숫자 없음 — L/R + AB단수/FAIL만)
    for (let i = 0; i < 2; i++) {
      const en = fm.engines[i];
      const gx = px + 26 * u + i * 62 * u, gy = yy + 18 * u, r = 19 * u;
      const col = en.failed ? C_RED : (en.ab > 0.05 ? C_AMBER : H_GREEN);
      ctx.strokeStyle = 'rgba(232,242,236,0.16)'; ctx.lineWidth = 3.5 * u;
      ctx.beginPath(); ctx.arc(gx, gy, r, Math.PI * 0.85, Math.PI * 2.15); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 3.5 * u;
      const frac = clamp(en.n / 1.05, 0, 1);
      ctx.beginPath(); ctx.arc(gx, gy, r, Math.PI * 0.85, Math.PI * 0.85 + frac * Math.PI * 1.3); ctx.stroke();
      ctx.font = `600 ${Math.round(this.fz(9))}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = en.failed ? C_RED : C_WHITE_DIM;
      ctx.fillText(i === 0 ? 'L' : 'R', gx, gy + 1 * u);
      if (en.failed || en.ab > 0.02) {
        ctx.font = `600 ${Math.round(this.fz(8))}px ${MONO}`;
        ctx.fillStyle = en.failed ? (this.blink < 0.5 ? C_RED : C_AMBER) : C_AMBER;
        ctx.fillText(en.failed ? 'FAIL' : `AB${Math.max(1, Math.ceil(en.ab * 5))}`, gx, gy + 12 * u);
      }
    }
    // 스로틀 막대 + 연료 막대 (숫자 없음 — 연료는 저연료 때만 수치)
    const bx = px + 132 * u, bw = 66 * u;
    ctx.fillStyle = 'rgba(232,242,236,0.14)'; ctx.fillRect(bx, yy + 8 * u, bw, 5 * u);
    ctx.fillStyle = fm.ctl.throttle > 0.8 ? C_AMBER : H_GREEN;
    ctx.fillRect(bx, yy + 8 * u, bw * clamp(fm.ctl.throttle, 0, 1), 5 * u);
    ctx.fillStyle = 'rgba(232,242,236,0.4)'; ctx.fillRect(bx + bw * 0.8, yy + 5 * u, 1.5 * u, 11 * u);
    const fuelLb = fm.fuel * KG2LB;
    const fuelFrac = clamp(fuelLb / 13500, 0, 1);
    ctx.fillStyle = 'rgba(232,242,236,0.14)'; ctx.fillRect(bx, yy + 24 * u, bw, 5 * u);
    ctx.fillStyle = fuelLb < 2500 ? (this.blink < 0.5 ? C_RED : C_AMBER) : H_GREEN;
    ctx.fillRect(bx, yy + 24 * u, bw * fuelFrac, 5 * u);
    if (fuelLb < 2500) {
      ctx.font = `600 ${Math.round(this.fz(9))}px ${MONO}`;
      ctx.textAlign = 'left'; ctx.fillStyle = C_AMBER;
      ctx.fillText(`${(fuelLb / 1000).toFixed(1)}k`, bx, yy + 36 * u);
    }
    yy += 56 * u;

    // 무장 평면 실루엣 + 선택무장 짧게 + 잔탄 막대
    const sx = px, sy = yy;
    this.drawStores(ctx, sx + 34 * u, sy + 26 * u, 30 * u, pl);
    const rx = sx + 76 * u;
    // 켜졌을 때만 작은 표시등 (꺼짐은 그리지 않음)
    ctx.font = `600 ${Math.round(this.fz(8))}px ${MONO}`;
    ctx.textAlign = 'left';
    let lx = rx;
    const lamp = (t, col) => { ctx.fillStyle = col; ctx.fillText(t, lx, sy + 6 * u); lx += (t.length * 6.5 + 8) * u; };
    if (fm.gearPos > 0.5) lamp('GEAR', fm.gearPos > 0.99 ? C_WHITE : C_AMBER);
    if (fm.flapPos > 0.5) lamp('FLAP', C_AMBER);
    if (fm.ctl.brake > 0.1) lamp('BRK', C_AMBER);
    if (fm.casOn) lamp('CAS', H_GREEN);
    // 선택 무장 짧게
    ctx.font = `600 ${Math.round(this.fz(11))}px ${MONO}`;
    ctx.fillStyle = C_WHITE;
    ctx.fillText(this.wShort(game), rx, sy + 20 * u);
    // 기관포 잔탄 막대
    ctx.fillStyle = 'rgba(232,242,236,0.14)'; ctx.fillRect(rx, sy + 29 * u, 56 * u, 4 * u);
    ctx.fillStyle = fm.ammo < 190 ? C_AMBER : H_GREEN;
    ctx.fillRect(rx, sy + 29 * u, 56 * u * clamp(fm.ammo / 940, 0, 1), 4 * u);
    // 플레어/채프 막대 2개
    ctx.font = `${Math.round(this.fz(8))}px ${MONO}`;
    const fl = [['F', pl.flares], ['C', pl.chaff]];
    fl.forEach(([t, n], i) => {
      const fy = sy + 39 * u + i * 9 * u;
      ctx.fillStyle = C_WHITE_DIM; ctx.fillText(t, rx, fy);
      ctx.fillStyle = 'rgba(232,242,236,0.14)'; ctx.fillRect(rx + 10 * u, fy - 2 * u, 46 * u, 4 * u);
      ctx.fillStyle = n <= 5 ? C_AMBER : H_GREEN;
      ctx.fillRect(rx + 10 * u, fy - 2 * u, 46 * u * clamp(n / 30, 0, 1), 4 * u);
    });
    ctx.restore();
  }

  // 기체 평면 실루엣 + 미사일 스테이션 점
  drawStores(ctx, cx, cy, sc, pl) {
    const u = sc / 30;
    ctx.save();
    ctx.strokeStyle = H_DIM; ctx.lineWidth = 1.1 * u;
    // 동체
    ctx.beginPath(); ctx.moveTo(cx, cy - 26 * u); ctx.lineTo(cx, cy + 24 * u); ctx.stroke();
    // 주익
    ctx.beginPath(); ctx.moveTo(cx - 24 * u, cy + 6 * u); ctx.lineTo(cx + 24 * u, cy + 6 * u); ctx.stroke();
    // 꼬리날개
    ctx.beginPath(); ctx.moveTo(cx - 9 * u, cy + 22 * u); ctx.lineTo(cx + 9 * u, cy + 22 * u); ctx.stroke();
    // 스테이션: [dx, dy, 종류] — 9X 4발(익단·익하) + 120 4발(동체)
    const st = [
      [-24, 6, '9'], [24, 6, '9'], [-13, 6, '9'], [13, 6, '9'],
      [-3, -2, '1'], [3, -2, '1'], [-3, 8, '1'], [3, 8, '1'],
    ];
    const n9 = pl.stores.aim9, n120 = pl.stores.aim120;
    let c9 = 0, c1 = 0;
    for (const [dx, dy, k] of st) {
      const has = k === '9' ? (c9++ < n9) : (c1++ < n120);
      ctx.fillStyle = has ? H_GREEN : 'rgba(232,242,236,0.18)';
      ctx.beginPath(); ctx.arc(cx + dx * u, cy + dy * u, 2.4 * u, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // MFD 베젤: 사각 테두리 + 모서리 버튼 라벨 흉내
  mfdFrame(x, y, w, h, labels) {
    const ctx = this.ctx, u = this.ui;
    ctx.fillStyle = 'rgba(4,9,7,0.86)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(125,255,154,0.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    // 모서리 버튼 티
    ctx.fillStyle = 'rgba(125,255,154,0.3)';
    const n = 6 * u;
    for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (cx < x + w / 2 ? n : -n), cy); ctx.lineTo(cx, cy + (cy < y + h / 2 ? n : -n)); ctx.closePath(); ctx.fill();
    }
    if (labels) {
      ctx.font = `${Math.round(this.fz(8))}px ${MONO}`;
      ctx.fillStyle = C_WHITE_DIM; ctx.textBaseline = 'middle';
      if (labels.tl) { ctx.textAlign = 'left'; ctx.fillText(labels.tl, x + 6 * u, y + 8 * u); }
      if (labels.tr) { ctx.textAlign = 'right'; ctx.fillText(labels.tr, x + w - 6 * u, y + 8 * u); }
      if (labels.bl) { ctx.textAlign = 'left'; ctx.fillText(labels.bl, x + 6 * u, y + h - 8 * u); }
      if (labels.br) { ctx.textAlign = 'right'; ctx.fillText(labels.br, x + w - 6 * u, y + h - 8 * u); }
    }
  }

  rrect(x, y, w, h, r) {
    const c = this.ctx;
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  // ------------------------------------------------------------------ 우하단 MFD 레이더 (헤딩 업 PPI)
  // 표적은 레이더 트랙 파일(game.radar.tracks)만 표시: 빔이 지나갈 때 갱신되고 오래될수록 흐려진다.
  drawRadar(game) {
    const ctx = this.ctx, pl = game.player, fm = pl.fm, RD = game.radar, u = this.ui;
    const size = clamp(Math.min(this.W, this.H) * 0.27, 148 * u, 218 * u);
    const mx = this.W - size - 12 * u, my = this.H - size - 12 * u;
    const mode = pl.lock ? 'STT' : 'RWS';
    const rangeNm = Math.round(this.radarRange / NM);
    ctx.save();
    ctx.shadowBlur = 0;
    this.mfdFrame(mx, my, size, size, {
      tl: `${this.radarAuto ? 'AUTO ' : ''}${rangeNm}`,
      tr: mode,
      bl: '±60',
      br: 'RDR',
    });
    const pad = 16 * u;
    const cx = mx + size / 2, cy = my + size / 2 + 2 * u;
    const R = size / 2 - pad;
    const LIM = 60 * D2R, hdg = fm.s.heading;
    const pol = (a, r) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    // 거리 링 2개 + 방위선
    ctx.strokeStyle = 'rgba(125,255,154,0.18)'; ctx.lineWidth = 1;
    for (const f of [0.5, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    for (const a of [-60, -30, 30, 60]) {
      ctx.strokeStyle = Math.abs(a) === 60 ? 'rgba(125,255,154,0.35)' : 'rgba(125,255,154,0.14)';
      const [x, y] = pol(a * D2R, R);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    }
    // 스캔 섹터 음영
    ctx.fillStyle = 'rgba(125,255,154,0.04)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, -Math.PI / 2 - LIM, -Math.PI / 2 + LIM); ctx.closePath(); ctx.fill();
    // 안테나 주사선
    if (RD && pl.alive) {
      const [x, y] = pol(RD.az, R);
      ctx.strokeStyle = pl.lock ? 'rgba(255,120,100,0.8)' : 'rgba(125,255,154,0.8)';
      ctx.lineWidth = 1.4 * u;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      ctx.lineWidth = 1;
    }
    const toScope = (p) => {
      const dx = p.x - fm.pos.x, dz = p.z - fm.pos.z;
      const brg = Math.atan2(dx, -dz) - hdg;
      const d = Math.hypot(dx, dz) / this.radarRange * R;
      return { x: cx + Math.sin(brg) * d, y: cy - Math.cos(brg) * d, d };
    };
    // 레이더 트랙: 아군 빈 사각, 적군 채움(앰버) / 록온 빨강
    let lockInfo = null;
    if (RD) for (const tr of RD.tracks.values()) {
      const age = game.time - tr.t;
      const p = toScope(tr.pos);
      if (p.d > R) continue;
      const locked = pl.lock === tr.a;
      const hostile = tr.a.side !== pl.side;
      ctx.globalAlpha = locked ? 1 : clamp(1 - age / 8, 0.2, 1);
      if (locked) { ctx.fillStyle = C_RED; ctx.fillRect(p.x - 3.5 * u, p.y - 3.5 * u, 7 * u, 7 * u); }
      else if (hostile) { ctx.fillStyle = C_AMBER; ctx.fillRect(p.x - 3 * u, p.y - 3 * u, 6 * u, 6 * u); }
      else { ctx.strokeStyle = H_DIM; ctx.strokeRect(p.x - 3 * u, p.y - 3 * u, 6 * u, 6 * u); }
      // 상대 기수 방향 스틱 (읽기만: 속도벡터를 내 기준 상대방위로, 록온은 길게)
      const ev = tr.a.fm.vel, esp = Math.hypot(ev.x, ev.z);
      if (esp > 5) {
        const eb = Math.atan2(ev.x, -ev.z) - hdg;
        const el = locked ? 20 : 14;
        ctx.strokeStyle = locked ? C_RED : (hostile ? C_AMBER : H_DIM);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(eb) * el, p.y - Math.cos(eb) * el); ctx.stroke();
        ctx.lineWidth = 1;
      }
      if (locked) lockInfo = tr;
    }
    ctx.globalAlpha = 1;
    // 육안 접촉(탤리): 10 km 이내 가시 적 — 스코프 밖이면 테두리 화살
    if (RD) for (const a of RD.visual) {
      const p = toScope(a.fm.pos);
      ctx.fillStyle = C_AMBER;
      if (p.d <= R - 4 * u) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 5 * u); ctx.lineTo(p.x + 5 * u, p.y); ctx.lineTo(p.x, p.y + 5 * u); ctx.lineTo(p.x - 5 * u, p.y);
        ctx.closePath(); ctx.strokeStyle = C_AMBER; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
        // 육안 접촉도 기수 스틱 표시
        const vv = a.fm.vel, vsp = Math.hypot(vv.x, vv.z);
        if (vsp > 5) {
          const vb = Math.atan2(vv.x, -vv.z) - hdg;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(vb) * 14, p.y - Math.cos(vb) * 14); ctx.stroke();
          ctx.lineWidth = 1;
        }
      } else {
        const ang = Math.atan2(p.x - cx, -(p.y - cy));
        const [x1, y1] = pol(ang, R - 2), [x2, y2] = pol(ang - 0.09, R - 10 * u), [x3, y3] = pol(ang + 0.09, R - 10 * u);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath(); ctx.fill();
      }
    }
    // 미사일: 아군 흰점, 적 미사일 점멸
    for (const m of game.weapons.missiles) {
      if (!m.alive) continue;
      const p = toScope(m.pos);
      if (p.d > R) continue;
      if (m.owner === pl) { ctx.fillStyle = C_WHITE_DIM; ctx.fillRect(p.x - 1, p.y - 1, 2, 2); }
      else if (this.blink < 0.5) { ctx.fillStyle = C_RED; ctx.beginPath(); ctx.arc(p.x, p.y, 2.4 * u, 0, Math.PI * 2); ctx.fill(); }
    }
    // 자기 위치 (삼각)
    ctx.strokeStyle = H_GREEN; ctx.lineWidth = 1.2 * u;
    ctx.beginPath(); ctx.moveTo(cx, cy - 6 * u); ctx.lineTo(cx - 4.5 * u, cy + 4 * u); ctx.lineTo(cx + 4.5 * u, cy + 4 * u); ctx.closePath(); ctx.stroke();
    ctx.restore();
    // 하단 한 줄: 록온 정보 or 트랙 수
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.font = `${Math.round(this.fz(9))}px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (lockInfo) {
      const t = lockInfo.a.fm, los = t.pos.clone().sub(fm.pos), r = los.length();
      const vc = -t.vel.clone().sub(fm.vel).dot(los.normalize());
      ctx.fillStyle = C_AMBER;
      ctx.fillText(`${(r / NM).toFixed(1)}  ${Math.round(vc * MS2KT)}`, cx, my + size - 9 * u);
    } else {
      const n = RD ? [...RD.tracks.values()].filter(tr => tr.a.side !== pl.side).length : 0;
      ctx.fillStyle = C_WHITE_DIM;
      ctx.fillText(n ? `TRK ${n}` : 'SCAN', cx, my + size - 9 * u);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ 텔레메트리 (디버그용, 단색 정리)
  drawTelemetry(game) {
    const ctx = this.ctx, fm = game.player.fm, s = fm.s, e = fm.engines;
    const L = [
      ['TAS', `${(s.V * MS2KT).toFixed(0)} kt  ${(s.V * 3.6).toFixed(0)} km/h`],
      ['CAS / Mach', `${(s.cas * MS2KT).toFixed(0)} kt  M${s.M.toFixed(3)}`],
      ['ALT / AGL', `${fm.pos.y.toFixed(0)} m  /  ${s.agl.toFixed(0)} m`],
      ['a / b', `${(s.alpha * R2D).toFixed(2)}  ${(s.beta * R2D).toFixed(2)} deg`],
      ['nz ny nx', `${s.nz.toFixed(2)}  ${s.ny.toFixed(2)}  ${s.nx.toFixed(2)} G`],
      ['p q r', `${(fm.omega.x * R2D).toFixed(1)}  ${(fm.omega.y * R2D).toFixed(1)}  ${(fm.omega.z * R2D).toFixed(1)} d/s`],
      ['phi th psi gam', `${(s.phi * R2D).toFixed(1)}  ${(s.theta * R2D).toFixed(1)}  ${(((s.heading * R2D) + 360) % 360).toFixed(1)}  ${(s.gamma * R2D).toFixed(1)}`],
      ['Thrust FF', `${(s.thrust / 1000).toFixed(1)} kN  ${s.ff.toFixed(2)} kg/s`],
      ['Mass', `${fm.mass.toFixed(0)} kg`],
      ['ENG N / AB', `${(e[0].n * 100).toFixed(1)}% ${e[0].ab.toFixed(2)}  |  ${(e[1].n * 100).toFixed(1)}% ${e[1].ab.toFixed(2)}`],
      ['FCS', `${fm.casOn ? 'CAS/NDI' : 'DIRECT'}  blend ${fm.fcs.blend.toFixed(2)} ${fm.fcs.alphaLimited ? 'a-LIMIT' : ''}`],
    ];
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.font = `${Math.round(this.fz(12))}px ${MONO}`;
    ctx.textBaseline = 'top';
    const x = 14, y = 14, w = 330, h = L.length * 16 + 16;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; this.rrect(x, y, w, h, 4); ctx.fill();
    L.forEach(([k, v], i) => { ctx.fillStyle = H_DIM; ctx.fillText(k, x + 10, y + 8 + i * 16); ctx.fillStyle = C_WHITE; ctx.fillText(v, x + 130, y + 8 + i * 16); });
    ctx.restore();
  }

  drawSunFlare(game, cam) {
    const world = game.world, sd = world.sunDir;
    const p = this.projDir(sd, cam);
    const W = this.W, H = this.H;
    if (!p.front || p.x < -W * 0.3 || p.x > W * 1.3 || p.y < -H * 0.3 || p.y > H * 1.3) return;
    for (const d of [150, 600, 2000, 5000, 12000, 25000]) {
      const x = cam.position.x + sd.x * d, y = cam.position.y + sd.y * d, z = cam.position.z + sd.z * d;
      if (y < world.heightAt(x, z)) return;
    }
    const ctx = this.ctx;
    const edge = clamp(1 - Math.max(Math.abs(p.x / W - 0.5), Math.abs(p.y / H - 0.5)) * 1.6, 0, 1);
    if (edge <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = (x, y, r, rgb, a) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    glow(p.x, p.y, H * 0.3, '255,236,200', 0.07 * edge);
    glow(p.x, p.y, H * 0.06, '255,250,235', 0.3 * edge);
    // 별빛 광선
    ctx.strokeStyle = `rgba(255,245,225,${0.12 * edge})`;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3 + 0.2, L = H * (i % 2 ? 0.12 : 0.2);
      ctx.beginPath(); ctx.moveTo(p.x - Math.cos(a) * L, p.y - Math.sin(a) * L); ctx.lineTo(p.x + Math.cos(a) * L, p.y + Math.sin(a) * L); ctx.stroke();
    }
    // 렌즈 고스트 (태양 → 화면 중심 축)
    const vx = W / 2 - p.x, vy = H / 2 - p.y;
    const ghosts = [[0.45, 0.025, '120,200,255', 0.10], [0.75, 0.05, '255,190,120', 0.07], [1.15, 0.018, '160,255,190', 0.12], [1.45, 0.09, '140,150,255', 0.05], [1.9, 0.035, '255,160,220', 0.08]];
    for (const [t, r, rgb, a] of ghosts) glow(p.x + vx * t, p.y + vy * t, H * r * 2, rgb, a * edge);
    ctx.restore();
  }

  drawGEffects(game) {
    const g = game.gEffect;
    if (!g) return;
    const ctx = this.ctx, W = this.W, H = this.H;
    if (g.black > 0.01) {
      const r0 = Math.max(0.02, 1 - g.black) * Math.max(W, H) * 0.55;
      const grd = ctx.createRadialGradient(W / 2, H / 2, r0 * 0.4, W / 2, H / 2, r0 * 1.2 + 1);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, `rgba(0,0,0,${clamp(g.black * 1.4, 0, 1)})`);
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
      if (g.black > 0.85) { ctx.fillStyle = `rgba(0,0,0,${(g.black - 0.85) / 0.15})`; ctx.fillRect(0, 0, W, H); }
    }
    if (g.red > 0.01) { ctx.fillStyle = `rgba(150,0,0,${clamp(g.red * 0.8, 0, 0.85)})`; ctx.fillRect(0, 0, W, H); }
  }

  // ------------------------------------------------------------------ 메시지: 이벤트 때만 최신 1줄 3초, 머지 전은 금지 아이콘+거리
  drawMessages(game) {
    const ctx = this.ctx, u = this.ui;
    if (!this._msgSeen) this._msgSeen = {};
    const now = game.time;
    if (Object.keys(this._msgSeen).length > 40) this._msgSeen = {};
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    this.haloOn();
    const isCrit = (m) => /MISSILE|미사일|피격|FIGHT|격추|PULL|SPIKE|경고/i.test(m.text) || (m.color || '').startsWith('255,60') || (m.color || '').startsWith('255,40');
    let y = 26 * u;
    // 최신 메시지 1개만, HUD 기준 3초 후 사라짐
    if (game.messages.length) {
      const m0 = game.messages[0];
      if (this._msgSeen[m0.text] === undefined) this._msgSeen[m0.text] = now;
      const age = now - this._msgSeen[m0.text];
      const T = 3.0;
      if (age <= T) {
        const crit = isCrit(m0);
        const a = Math.min(clamp(m0.t, 0, 1), clamp((T - age) / 0.7, 0, 1), clamp(age / 0.15 + 0.2, 0, 1));
        ctx.font = crit ? `700 ${Math.round(this.fz(14))}px ${SANS}` : `500 ${Math.round(this.fz(12))}px ${SANS}`;
        // 화면을 넘기면 글자를 줄임
        let text = m0.text;
        while (text.length > 10 && ctx.measureText(text).width > this.W * 0.8) text = text.slice(0, -2);
        if (text !== m0.text) text += '…';
        const tw = ctx.measureText(text).width;
        const pw = tw + 26 * u, ph = 22 * u;
        ctx.globalAlpha = a;
        ctx.fillStyle = 'rgba(4,9,7,0.72)';
        ctx.fillRect(this.W / 2 - pw / 2, y, pw, ph);
        ctx.globalAlpha = 1;
        if (/미사일|피격|MISSILE/i.test(text)) ctx.fillStyle = C_RED;
        else if (crit) ctx.fillStyle = C_AMBER;
        else ctx.fillStyle = `rgba(232,242,236,${a})`;
        ctx.fillText(text, this.W / 2, y + ph / 2 + 1);
        y += ph + 6 * u;
      }
    }
    // 머지 전(BFM ingress): 상태 문구 대신 금지 아이콘 + 거리 숫자. 머지 후·그 외는 표시 안 함.
    if (game.bfm && game.bfm.phase === 'ingress') {
      let bd = -1;
      for (const a of game.aircraft) {
        if (a.side === 'red' && a.alive) {
          const d = a.fm.pos.distanceTo(game.player.fm.pos);
          if (bd < 0 || d < bd) bd = d;
        }
      }
      if (bd >= 0) {
        const iy = y + 9 * u, ir = 7.5 * u, tx = this.W / 2;
        ctx.strokeStyle = C_AMBER; ctx.lineWidth = 1.6 * u;
        ctx.beginPath(); ctx.arc(tx - 30 * u, iy, ir, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx - 30 * u - ir * 0.7, iy + ir * 0.7);
        ctx.lineTo(tx - 30 * u + ir * 0.7, iy - ir * 0.7);
        ctx.stroke();
        ctx.font = `600 ${Math.round(this.fz(12))}px ${MONO}`;
        ctx.fillStyle = C_WHITE;
        ctx.fillText((bd / NM).toFixed(1), tx + 2 * u, iy + 1);
      }
    }
    this.haloOff();
    ctx.restore();
  }
}
