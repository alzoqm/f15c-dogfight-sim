// WebAudio 합성 사운드: 엔진(코어/팬/A·B 럼블), 바람, 기관포, 미사일 톤/경보, 폭발 (샘플 파일 없음)
export class AudioSys {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.listener = null;
  }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    // 노이즈 버퍼
    const len = ctx.sampleRate * 2;
    const white = ctx.createBuffer(1, len, ctx.sampleRate), brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }
    this.white = white; this.brown = brown;
    const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };

    // 엔진 코어 (대역통과 노이즈)
    this.engBand = ctx.createBiquadFilter(); this.engBand.type = 'bandpass'; this.engBand.Q.value = 0.9;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    loop(white).connect(this.engBand).connect(this.engGain).connect(this.master);
    // 저역 럼블 (A/B)
    this.rumbleLP = ctx.createBiquadFilter(); this.rumbleLP.type = 'lowpass'; this.rumbleLP.frequency.value = 160;
    this.rumbleGain = ctx.createGain(); this.rumbleGain.gain.value = 0;
    loop(brown).connect(this.rumbleLP).connect(this.rumbleGain).connect(this.master);
    // 터빈 휘슬
    this.whine = ctx.createOscillator(); this.whine.type = 'sawtooth'; this.whine.frequency.value = 2000;
    this.whineF = ctx.createBiquadFilter(); this.whineF.type = 'bandpass'; this.whineF.Q.value = 8;
    this.whineGain = ctx.createGain(); this.whineGain.gain.value = 0;
    this.whine.connect(this.whineF).connect(this.whineGain).connect(this.master); this.whine.start();
    // 바람
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.Q.value = 0.6; this.windF.frequency.value = 700;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    loop(white).connect(this.windF).connect(this.windGain).connect(this.master);
    // 기관포 (100Hz 펄스 변조 노이즈)
    this.gunGain = ctx.createGain(); this.gunGain.gain.value = 0;
    const gunAM = ctx.createGain(); gunAM.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 100;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.5;
    lfo.connect(lfoG).connect(gunAM.gain); lfo.start();
    const gunLP = ctx.createBiquadFilter(); gunLP.type = 'lowpass'; gunLP.frequency.value = 1400;
    loop(white).connect(gunAM).connect(gunLP).connect(this.gunGain).connect(this.master);
    // 미사일 톤 (AIM-9 그로울), 경보음
    this.tone = ctx.createOscillator(); this.tone.type = 'sine'; this.tone.frequency.value = 400;
    this.toneGain = ctx.createGain(); this.toneGain.gain.value = 0;
    this.tone.connect(this.toneGain).connect(this.master); this.tone.start();
    this.warn = ctx.createOscillator(); this.warn.type = 'square'; this.warn.frequency.value = 1000;
    this.warnGain = ctx.createGain(); this.warnGain.gain.value = 0;
    const warnLP = ctx.createBiquadFilter(); warnLP.type = 'lowpass'; warnLP.frequency.value = 2500;
    this.warn.connect(warnLP).connect(this.warnGain).connect(this.master); this.warn.start();
    this.t = 0;
  }
  resume() { this.ctx?.resume(); }
  setEnabled(on) { this.enabled = on; if (this.master) this.master.gain.setTargetAtTime(on ? 0.7 : 0, this.ctx.currentTime, 0.05); }

  /** 연속음(엔진·바람·기관포·톤·경보)을 모두 무음으로. 메뉴로 나가거나 일시정지할 때 호출 */
  silence() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const g of [this.engGain, this.rumbleGain, this.whineGain, this.windGain, this.gunGain, this.toneGain, this.warnGain]) {
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(0, now, 0.08);
    }
  }

  /** 매 프레임 상태 반영 */
  update(dt, st) {
    if (!this.ctx) return;
    const c = this.ctx, now = c.currentTime, T = 0.06;
    this.t += dt;
    const set = (p, v, tc = T) => p.setTargetAtTime(v, now, tc);
    const inside = st.cockpit ? 0.55 : 1.0;
    const n = st.rpm, ab = st.ab, alive = st.alive ? 1 : 0;
    set(this.engBand.frequency, 250 + 900 * n * n + 400 * ab);
    set(this.engGain.gain, alive * (0.05 + 0.35 * Math.pow(Math.max(0, n - 0.5) * 2, 2) + 0.35 * ab) * inside);
    set(this.rumbleGain.gain, alive * (0.15 * n + 0.9 * ab) * (st.cockpit ? 0.8 : 1.3));
    set(this.whine.frequency, 1600 + 4200 * n);
    set(this.whineF.frequency, 1600 + 4200 * n);
    set(this.whineGain.gain, alive * 0.035 * n * (st.cockpit ? 1.0 : 0.4));
    const q = Math.min(1, st.qbar / 60000);
    set(this.windF.frequency, 400 + 1600 * q);
    set(this.windGain.gain, (0.02 + 0.5 * q + 0.25 * st.buffet) * (st.cockpit ? 1 : 0.6));
    set(this.gunGain.gain, st.gun ? 0.9 : 0, 0.02);
    // 미사일 톤: 탐색 중 낮은 그로울, 록온 시 높은 톤
    if (st.tone === 'lock') { set(this.tone.frequency, 1150 + 40 * Math.sin(this.t * 40)); set(this.toneGain.gain, 0.12); }
    else if (st.tone === 'search') { set(this.tone.frequency, 380 + 60 * Math.sin(this.t * 25)); set(this.toneGain.gain, 0.06); }
    else set(this.toneGain.gain, 0);
    // 경보: 미사일 경보(빠른 삑), 실속/G, 저고도
    let wg = 0, wf = 1000;
    if (st.mws) { wf = 1800; wg = (this.t * 8) % 1 < 0.5 ? 0.08 : 0; }
    else if (st.pullUp) { wf = 700; wg = (this.t * 3) % 1 < 0.5 ? 0.07 : 0; }
    else if (st.stall) { wf = 420; wg = (this.t * 10) % 1 < 0.5 ? 0.05 : 0; }
    else if (st.overG) { wf = 1300; wg = (this.t * 5) % 1 < 0.3 ? 0.05 : 0; }
    else if (st.radarLock) { wf = 1600; wg = (this.t * 2) % 1 < 0.08 ? 0.04 : 0; }
    set(this.warn.frequency, wf, 0.01);
    set(this.warnGain.gain, wg, 0.01);
  }

  _oneShot(buf, { gain = 1, lp = 2000, dur = 1, rate = 1, delay = 0 } = {}) {
    if (!this.ctx) return;
    const c = this.ctx, s = c.createBufferSource();
    s.buffer = buf; s.playbackRate.value = rate;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
    const g = c.createGain();
    const t0 = c.currentTime + delay;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t0); s.stop(t0 + dur + 0.1);
  }
  _distGain(pos) {
    if (!pos || !this.listener) return 1;
    const d = pos.distanceTo(this.listener);
    return Math.min(1, 300 / Math.max(300, d)) ** 1.2;
  }
  explosion(pos, size = 1) {
    const g = this._distGain(pos);
    if (g < 0.02) return;
    const d = pos && this.listener ? pos.distanceTo(this.listener) : 0;
    this._oneShot(this.brown, { gain: 1.6 * g * size, lp: 900, dur: 2.5, rate: 0.6, delay: Math.min(3, d / 340) });
    this._oneShot(this.white, { gain: 0.5 * g * size, lp: 3000, dur: 0.5, delay: Math.min(3, d / 340) });
  }
  hit(pos) { this._oneShot(this.white, { gain: 0.5 * this._distGain(pos), lp: 4000, dur: 0.12 }); }
  missileLaunch(pos) { const g = this._distGain(pos); this._oneShot(this.white, { gain: 0.8 * g, lp: 1500, dur: 1.8, rate: 0.8 }); this._oneShot(this.brown, { gain: 1.0 * g, lp: 500, dur: 1.2 }); }
  flare() { this._oneShot(this.white, { gain: 0.25, lp: 2500, dur: 0.15 }); }
  thump(gain = 0.6) { this._oneShot(this.brown, { gain, lp: 300, dur: 0.4, rate: 0.7 }); }
  click() { this._oneShot(this.white, { gain: 0.15, lp: 5000, dur: 0.03 }); }
}
