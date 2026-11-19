// 입력: 조작 방식 → 공통 액션(this.a)으로 변환
//  - bf (배틀필드식 키보드, 기본): 방향키 피치/롤, W/S 스로틀, Shift 애프터버너, A/D 러더,
//        Space 기관포, F 미사일, Q 록온, E 무장 전환, X 플레어, Alt+마우스 둘러보기
//  - bfmouse (배틀필드식 마우스 비행): 마우스(포인터 록)로 피치/롤, 나머지 키는 bf와 동일, 좌/우클릭 무장
//  - classic: 키보드 스틱(W/S/A/D/Q/E), R/F 스로틀, Space 기관포, X 미사일, 우클릭 드래그 시점
//  - custom: 동작마다 키·마우스 버튼을 직접 지정 (ACTIONS, 최대 2개) + 마우스 비행 설정. localStorage에 저장
import { clamp, moveToward } from './math.js';

export const SCHEMES = {
  bf: '배틀필드식 (키보드)',
  bfmouse: '배틀필드식 (마우스 비행)',
  classic: '클래식',
  custom: '커스텀',
};

// 커스텀 조작 동작 목록: [id, 이름, 그룹]
export const ACTIONS = [
  ['pitchUp', '기수 올림 (당김)', '비행'], ['pitchDown', '기수 내림 (밂)', '비행'],
  ['rollLeft', '왼쪽 롤', '비행'], ['rollRight', '오른쪽 롤', '비행'],
  ['yawLeft', '왼쪽 러더', '비행'], ['yawRight', '오른쪽 러더', '비행'],
  ['fine', '정밀 조종 (누르는 동안 40%)', '비행'],
  ['thrUp', '스로틀 증가', '엔진'], ['thrDown', '스로틀 감소 (아이들에서 누름 = 에어브레이크)', '엔진'],
  ['afterburner', '애프터버너 (누르는 동안)', '엔진'], ['airbrake', '에어브레이크 (누르는 동안)', '엔진'],
  ['gun', '기관포', '무장'], ['missile', '미사일 발사', '무장'], ['lock', '레이더 록온 / 표적 전환', '무장'],
  ['cycleWpn', '미사일 종류 전환', '무장'], ['selSRM', 'AIM-9X 선택', '무장'], ['selMRM', 'AIM-120 선택', '무장'],
  ['flares', '플레어 + 채프', '무장'],
  ['speedbrake', '스피드브레이크 (토글)', '시스템'], ['gear', '기어', '시스템'], ['flaps', '플랩', '시스템'],
  ['wheelBrake', '휠 브레이크', '시스템'], ['cas', 'CAS ON/OFF', '시스템'], ['trimDown', '피치 트림 −', '시스템'], ['trimUp', '피치 트림 +', '시스템'],
  ['camera', '시점 전환', '시점'], ['targetView', '적 추적 시점', '시점'], ['freeLook', '자유 시점 (누른 채 마우스)', '시점'],
  ['padlock', '패드락', '시점'], ['telemetry', '텔레메트리', '표시'], ['hud', 'HUD 켜기/끄기', '표시'], ['radarRange', '레이더 거리', '표시'],
  ['pause', '일시정지 (Esc는 항상)', '표시'], ['help', '도움말', '표시'],
];

// 프리셋 키 배치 (커스텀으로 복사할 때 사용). bfmouse는 bf와 같고 마우스 비행만 켬
const BF_BINDS = {
  pitchUp: ['ArrowDown', 'Numpad2'], pitchDown: ['ArrowUp', 'Numpad8'], rollLeft: ['ArrowLeft', 'Numpad4'], rollRight: ['ArrowRight', 'Numpad6'],
  yawLeft: ['KeyA'], yawRight: ['KeyD'], fine: [],
  thrUp: ['KeyW'], thrDown: ['KeyS'], afterburner: ['ShiftLeft', 'ShiftRight'], airbrake: [],
  gun: ['Space', 'Mouse0'], missile: ['KeyF', 'Mouse2'], lock: ['KeyQ'], cycleWpn: ['KeyE'], selSRM: ['Digit1'], selMRM: ['Digit2'], flares: ['KeyX'],
  speedbrake: ['KeyB'], gear: ['KeyG'], flaps: ['KeyV'], wheelBrake: ['KeyN'], cas: ['KeyK'], trimDown: ['BracketLeft'], trimUp: ['BracketRight'],
  camera: ['KeyC'], targetView: ['KeyR'], freeLook: ['AltLeft', 'Mouse1'], padlock: ['KeyY'], telemetry: ['KeyI'], hud: ['KeyO'], radarRange: ['Equal'],
  pause: ['KeyP'], help: ['KeyH'],
};
const CLASSIC_BINDS = {
  ...BF_BINDS,
  pitchUp: ['KeyS', 'ArrowDown'], pitchDown: ['KeyW', 'ArrowUp'], rollLeft: ['KeyA', 'ArrowLeft'], rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'], yawRight: ['KeyE'], fine: ['ShiftLeft', 'ShiftRight'],
  thrUp: ['KeyR'], thrDown: ['KeyF'], afterburner: [],
  gun: ['Space', 'Mouse0'], missile: ['KeyX'], lock: ['KeyT'], cycleWpn: ['KeyM'], selSRM: ['Digit2'], selMRM: ['Digit3'], flares: ['KeyZ'],
  targetView: ['KeyL'], freeLook: ['Mouse2', 'Mouse1'],
};
export const DEFAULT_MOUSE = { flight: false, xAxis: 'roll', recenter: 6.5, ySens: 1.0 };
/** 프리셋 → 커스텀 설정 (throttle: hold = MIL까지 + 애프터버너 키 / detent = MIL에서 멈춘 뒤 다시 누르면 A/B) */
export function presetCustom(name) {
  const binds = JSON.parse(JSON.stringify(name === 'classic' ? CLASSIC_BINDS : BF_BINDS));
  return { binds, throttle: name === 'classic' ? 'detent' : 'hold', mouse: { ...DEFAULT_MOUSE, flight: name === 'bfmouse' } };
}
const PRESET_CACHE = {};
const CUSTOM_KEY = 'f15sim.custom.v1';
export function loadCustom() {
  const c = presetCustom('bf');
  try {
    const s = JSON.parse(localStorage.getItem(CUSTOM_KEY));
    if (s && s.binds) {
      for (const [id] of ACTIONS) if (Array.isArray(s.binds[id])) c.binds[id] = s.binds[id].filter((x) => typeof x === 'string').slice(0, 2);
      if (s.throttle === 'detent' || s.throttle === 'hold') c.throttle = s.throttle;
      if (s.mouse) Object.assign(c.mouse, s.mouse);
    }
  } catch { /* 저장된 값 없음/손상 */ }
  return c;
}
export function saveCustom(c) { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(c)); } catch { /* 저장 불가 환경 */ } }
const KEY_NAMES = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
  CapsLock: 'Caps', Mouse0: '좌클릭', Mouse1: '휠 클릭', Mouse2: '우클릭', Mouse3: '마우스 4', Mouse4: '마우스 5',
  NumpadDecimal: 'Num .', NumpadAdd: 'Num +', NumpadSubtract: 'Num −', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadEnter: 'Num Enter',
};
/** 키 코드 → 표시 이름 */
export function keyLabel(code) {
  if (!code) return '—';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.scheme = 'bf';
    this.sens = 1.0;          // 마우스 감도 배율
    this.invertY = false;     // 마우스 Y 반전 (당기기 = 기수 올림)
    this.keys = new Set();
    this.pressed = new Set();
    this.stick = { pitch: 0, roll: 0, yaw: 0 };
    this.mouseStick = { pitch: 0, roll: 0 };
    this.throttle = 0;
    this.baseThrottle = 0;    // 배틀필드식: A/B 해제 시 돌아갈 스로틀
    this.lookDX = 0; this.lookDY = 0;
    this.freeLook = false;
    this.wheel = 0;
    this.gamepad = null;
    this.mouse = { l: false, r: false, m: false, rHit: false, lHit: false };
    this.flightDX = 0; this.flightDY = 0;
    this.detentHold = false;
    this.targetToggle = false;   // 적 추적 R: true면 누를 때마다 켜짐/꺼짐이 바뀌는 토글
    this._tvOn = false;          // 토글 상태 (켜져 있음)
    this._tvHeld = false;        // 토글 엣지 검출용 (직전 프레임에 눌려 있었는지)
    this.a = {};
    this.locked = false;
    this.wantLock = false;    // 게임 진행 중일 때만 포인터 록 허용
    this.custom = loadCustom();
    this.capturing = false;   // 키 설정 화면에서 키 입력을 받는 중 (게임 입력으로 쓰지 않음)

    window.addEventListener('keydown', (e) => {
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backquote', 'AltLeft', 'AltRight', 'F1'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); if (e.code.startsWith('Alt')) e.preventDefault(); });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.l = this.mouse.r = this.mouse.m = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (this.mouseFlight && this.wantLock && !this.locked) { this.requestLock(); return; }
      if (e.button === 0) { this.mouse.l = true; this.mouse.lHit = true; }
      if (e.button === 1) { this.mouse.m = true; this.mouse.mHit = true; e.preventDefault(); }
      if (e.button === 2) { this.mouse.r = true; this.mouse.rHit = true; }
      if (e.button === 3 || e.button === 4) { this.mouse['b' + e.button] = true; this.mouse['b' + e.button + 'Hit'] = true; e.preventDefault(); }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.l = false;
      if (e.button === 1) this.mouse.m = false;
      if (e.button === 2) this.mouse.r = false;
      if (e.button === 3 || e.button === 4) this.mouse['b' + e.button] = false;
    });
    window.addEventListener('mousemove', (e) => {
      const dx = e.movementX || 0, dy = e.movementY || 0;
      if (this.mouseFlight) {
        if (!this.locked) return;
        if (this.isFreeLook()) { this.lookDX += dx; this.lookDY += dy; }
        else { this.flightDX += dx; this.flightDY += dy; }
      } else if (this.scheme === 'bf' || this.scheme === 'custom') {
        if (this.isFreeLook()) { this.lookDX += dx; this.lookDY += dy; }   // Alt 또는 휠 버튼(커스텀: 자유 시점 키)을 누른 채 마우스 이동
      } else if (this.mouse.r || this.mouse.m) { this.lookDX += dx; this.lookDY += dy; }
    });
    canvas.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    window.addEventListener('gamepadconnected', (e) => { this.gamepad = e.gamepad.index; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.onLockLost?.();
    });
  }
  requestLock() {
    // unadjustedMovement(가속 해제)를 지원하지 않으면 일반 포인터 록으로 재시도. 실패는 조용히 무시(클릭 시 재요청)
    const plain = () => { try { this.canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* 미지원 */ } };
    try { const p = this.canvas.requestPointerLock({ unadjustedMovement: true }); if (p?.catch) p.catch(plain); }
    catch { plain(); }
  }
  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }
  /** 마우스로 비행하는 방식인지 (포인터 록 사용) */
  get mouseFlight() { return this.scheme === 'bfmouse' || (this.scheme === 'custom' && !!this.custom.mouse.flight); }
  isFreeLook() {
    if (this.scheme === 'custom') return this.custom.binds.freeLook.some((c) => this.codeDown(c));
    return this.keys.has('AltLeft') || this.keys.has('AltRight') || this.mouse.m;
  }
  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }
  /** 키 코드 또는 Mouse0~4 가 눌려 있는지 / 이번 프레임에 눌렸는지 */
  codeDown(c) {
    if (c.startsWith('Mouse')) { const b = +c.slice(5); return b === 0 ? this.mouse.l : b === 1 ? this.mouse.m : b === 2 ? this.mouse.r : !!this.mouse['b' + b]; }
    return this.keys.has(c);
  }
  codeHit(c) {
    if (c.startsWith('Mouse')) { const b = +c.slice(5); return b === 0 ? this.mouse.lHit : b === 1 ? this.mouse.mHit : b === 2 ? this.mouse.rHit : !!this.mouse['b' + b + 'Hit']; }
    return this.pressed.has(c);
  }
  /** 적 추적 누름/토글: 토글 모드면 눌렀다 뗄 때마다 켜짐/꺼짐이 바뀐다 */
  _tgl(held) {
    if (!this.targetToggle) return held;
    if (held && !this._tvHeld) this._tvOn = !this._tvOn;
    this._tvHeld = held;
    return this._tvOn;
  }
  /** 현재 조작 방식에서 동작의 첫 키 이름 (안내 메시지용) */
  label(action) {
    const B = this.scheme === 'custom' ? this.custom.binds : (PRESET_CACHE[this.scheme] ||= presetCustom(this.scheme)).binds;
    return keyLabel((B[action] || [])[0]);
  }

  /** 매 프레임: 원시 입력 → 스틱/스로틀/액션 */
  update(dt, throttleNow) {
    const k = (c) => this.keys.has(c), h = (c) => this.pressed.has(c);
    const bf = this.scheme !== 'classic';
    const mouseFlight = this.scheme === 'bfmouse';
    // 키보드 스틱: 누르는 동안 점점 깊게(피치는 천천히 → 짧게 톡 치면 미세 조정), 떼면 빠르게 중립
    const ramp = (ax, t, up = 2.6) => {
      const back = ax === 'pitch' ? 12 : 4.5;   // 피치: 놓으면 곧바로 중립 → 기수가 그 자리에 멈춤 (피치레이트 명령)
      const rate = t === 0 ? back : (Math.sign(t) !== Math.sign(this.stick[ax]) && this.stick[ax] !== 0 ? 7 : up);
      this.stick[ax] = moveToward(this.stick[ax], t, rate * dt);
    };
    let thr = throttleNow;
    const A = this.a;

    if (this.capturing) {
      // 키 설정 중: 조종 입력 없음
      for (const k in A) A[k] = false;
      this.out = { pitch: 0, roll: 0, yaw: 0 };
    } else if (this.scheme === 'custom') {
      const C = this.custom, B = C.binds, M = C.mouse;
      const d = (act) => (B[act] || []).some((c) => this.codeDown(c));
      const hh = (act) => (B[act] || []).some((c) => this.codeHit(c));
      // 마우스 비행: 이동량 = 조종 입력, 중립 복귀 강도(recenter)만큼 스프링처럼 돌아옴 (0이면 그 자리 유지)
      if (this.mouseFlight) {
        const s = 0.011 * this.sens;
        this.mouseStick.roll = clamp(this.mouseStick.roll + this.flightDX * s, -1, 1);
        this.mouseStick.pitch = clamp(this.mouseStick.pitch + (this.invertY ? -1 : 1) * this.flightDY * s * (M.ySens || 1), -1, 1);
        const decay = Math.exp(-dt * (M.recenter ?? 6.5));
        this.mouseStick.roll *= decay; this.mouseStick.pitch *= decay;
      } else { this.mouseStick.roll = 0; this.mouseStick.pitch = 0; }
      const lim = d('fine') ? 0.4 : 1;
      ramp('pitch', ((d('pitchUp') ? 1 : 0) - (d('pitchDown') ? 1 : 0)) * lim, 2.4);
      ramp('roll', ((d('rollRight') ? 1 : 0) - (d('rollLeft') ? 1 : 0)) * lim, 3.2);
      ramp('yaw', ((d('yawRight') ? 1 : 0) - (d('yawLeft') ? 1 : 0)) * lim);
      const kpS = Math.sign(this.stick.pitch) * Math.abs(this.stick.pitch) ** 1.6;
      const mx = this.mouseStick.roll, yawX = M.xAxis === 'yaw';
      this.out = {
        pitch: clamp(kpS - this.mouseStick.pitch, -1, 1),
        roll: clamp(this.stick.roll + (yawX ? 0 : mx), -1, 1),
        yaw: clamp(this.stick.yaw + (yawX ? mx : 0), -1, 1),
      };
      if (C.throttle === 'detent') {
        // 연속 스로틀: MIL(0.8)에서 멈춤 → 다시 누르면 애프터버너. 애프터버너 키는 누르는 동안 최대
        if (!d('thrUp')) this.detentHold = false;
        if (d('thrUp')) {
          if (thr < 0.8 && thr + 0.4 * dt >= 0.8 && !this.detentHold) { thr = 0.8; this.detentHold = true; }
          else if (!(this.detentHold && thr >= 0.799 && thr <= 0.801)) thr = Math.min(1, thr + 0.4 * dt);
        }
        if (d('thrDown')) { thr = Math.max(0, thr - 0.4 * dt); this.detentHold = false; }
        if (d('afterburner')) thr = 1;
        A.airbrake = d('airbrake');
      } else {
        // 배틀필드식: 0~MIL, 애프터버너 키를 누르는 동안 최대, 아이들에서 감소 키 유지 = 에어브레이크
        if (d('thrUp')) this.baseThrottle = Math.min(0.8, this.baseThrottle + 0.45 * dt);
        if (d('thrDown')) this.baseThrottle = Math.max(0, this.baseThrottle - 0.45 * dt);
        thr = d('afterburner') ? 1.0 : this.baseThrottle;
        A.airbrake = d('airbrake') || (d('thrDown') && this.baseThrottle <= 0.001);
      }
      A.gun = d('gun'); A.missile = hh('missile'); A.lock = hh('lock'); A.flares = hh('flares');
      A.flaps = hh('flaps'); A.wheelBrake = A.airbrake || d('wheelBrake');
      A.selSRM = hh('selSRM'); A.selMRM = hh('selMRM'); A.selGun = false; A.cycleWpn = hh('cycleWpn');
      A.freeLook = this.isFreeLook(); A.targetView = this._tgl(d('targetView'));
      A.gear = hh('gear'); A.speedbrake = hh('speedbrake'); A.cas = hh('cas'); A.camera = hh('camera'); A.padlock = hh('padlock');
      A.telemetry = hh('telemetry'); A.hud = hh('hud'); A.radarRange = hh('radarRange');
      A.trimDown = hh('trimDown'); A.trimUp = hh('trimUp'); A.pause = hh('pause'); A.help = hh('help');
    } else if (bf) {
      // ---- 마우스 비행(bfmouse 전용): 이동량 = 조종 입력, 스프링처럼 중립 복귀
      if (mouseFlight) {
        const s = 0.011 * this.sens;
        this.mouseStick.roll = clamp(this.mouseStick.roll + this.flightDX * s, -1, 1);
        this.mouseStick.pitch = clamp(this.mouseStick.pitch + (this.invertY ? -1 : 1) * this.flightDY * s, -1, 1);
        const decay = Math.exp(-dt * 6.5);
        this.mouseStick.roll *= decay; this.mouseStick.pitch *= decay;
      } else { this.mouseStick.roll = 0; this.mouseStick.pitch = 0; }
      // 키보드 피치/롤: 방향키 또는 숫자패드 8/2/4/6 (기본 ↑ = 기수 내림, ↓ = 기수 올림; 피치 반전 옵션)
      const up = k('ArrowUp') || k('Numpad8'), dn = k('ArrowDown') || k('Numpad2') || k('Numpad5');
      let kp = (dn ? 1 : 0) - (up ? 1 : 0);
      if (!mouseFlight && this.invertY) kp = -kp;
      const kr = ((k('ArrowRight') || k('Numpad6')) ? 1 : 0) - ((k('ArrowLeft') || k('Numpad4')) ? 1 : 0);
      ramp('pitch', kp, 2.4); ramp('roll', kr, 3.2);
      ramp('yaw', (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0));
      // 마우스 위 = 기수 올림(조준과 같은 감각): 마우스 dy<0 → pitch +
      // 키보드 피치 곡선: 짧게 톡 = 작은 G, 길게 누름 = 최대 G (|x|^1.6) → 미세 조정 쉬움, 출렁임 감소
      const kpS = Math.sign(this.stick.pitch) * Math.abs(this.stick.pitch) ** 1.6;
      this.out = {
        pitch: clamp(kpS - this.mouseStick.pitch, -1, 1),
        roll: clamp(this.stick.roll + this.mouseStick.roll, -1, 1),
        yaw: this.stick.yaw,
      };
      // ---- 스로틀: W/S로 0~MIL, Shift 누르는 동안 애프터버너, 아이들에서 S 유지 = 에어브레이크
      if (k('KeyW')) this.baseThrottle = Math.min(0.8, this.baseThrottle + 0.45 * dt);
      if (k('KeyS')) this.baseThrottle = Math.max(0, this.baseThrottle - 0.45 * dt);
      const ab = k('ShiftLeft') || k('ShiftRight');
      thr = ab ? 1.0 : this.baseThrottle;
      A.airbrake = k('KeyS') && this.baseThrottle <= 0.001;
      A.gun = this.mouse.l || k('Space') || k('Numpad0');
      A.missile = this.mouse.rHit || h('KeyF') || h('NumpadDecimal');
      A.lock = h('KeyQ');
      A.flares = h('KeyX');
      A.flaps = h('KeyV');
      A.wheelBrake = A.airbrake || k('KeyN');
      A.selSRM = h('Digit1'); A.selMRM = h('Digit2'); A.selGun = false;
      A.cycleWpn = h('KeyE');
      A.freeLook = this.isFreeLook();
      A.targetView = this._tgl(k('KeyR'));        // 적 추적 시점 (누름 또는 메뉴 '추적 R 토글')
    } else {
      const fine = k('ShiftLeft') || k('ShiftRight');
      const lim = fine ? 0.4 : 1;
      ramp('pitch', (((k('KeyS') || k('ArrowDown')) ? 1 : 0) - ((k('KeyW') || k('ArrowUp')) ? 1 : 0)) * lim);
      ramp('roll', (((k('KeyD') || k('ArrowRight')) ? 1 : 0) - ((k('KeyA') || k('ArrowLeft')) ? 1 : 0)) * lim);
      ramp('yaw', ((k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0)) * lim);
      this.out = { ...this.stick };
      // R/F 스로틀, MIL 디텐트(0.8)에서 정지 → R 재입력 시 A/B
      if (!k('KeyR')) this.detentHold = false;
      if (k('KeyR')) {
        if (thr < 0.8 && thr + 0.4 * dt >= 0.8 && !this.detentHold) { thr = 0.8; this.detentHold = true; }
        else if (!(this.detentHold && thr >= 0.799 && thr <= 0.801)) thr = Math.min(1, thr + 0.4 * dt);
      }
      if (k('KeyF')) { thr = Math.max(0, thr - 0.4 * dt); this.detentHold = false; }
      if (h('Digit0')) thr = 0;
      A.airbrake = false;
      A.gun = k('Space') || this.mouse.l;
      A.missile = h('KeyX');
      A.lock = h('KeyT');
      A.flares = h('KeyZ');
      A.flaps = h('KeyV');
      A.wheelBrake = k('KeyN');
      A.selGun = h('Digit1'); A.selSRM = h('Digit2'); A.selMRM = h('Digit3');
      A.cycleWpn = h('KeyM');
      A.freeLook = this.mouse.r || this.mouse.m;
      A.targetView = this._tgl(k('KeyL'));
    }
    if (this.scheme !== 'custom' && !this.capturing) {
      A.gear = h('KeyG');
      A.speedbrake = h('KeyB');
      A.cas = h('KeyK');
      A.camera = h('KeyC');
      A.padlock = h('KeyY');
      A.telemetry = h('KeyI');
      A.hud = h('KeyO');
      A.radarRange = h('Equal');
      A.trimDown = h('BracketLeft'); A.trimUp = h('BracketRight');
      A.pause = h('KeyP'); A.help = h('KeyH');
    }

    // ---- 게임패드 (두 방식 공통)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = this.gamepad !== null ? pads[this.gamepad] : null;
    if (gp && !this.capturing) {
      const dz = (v) => (Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92);
      const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0);
      if (lx || ly) { this.out.roll = lx * Math.abs(lx) ** 0.5; this.out.pitch = ly * Math.abs(ly) ** 0.5; }
      if (rx) this.out.yaw = rx;
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      if (rt || lt) { thr = clamp(thr + (rt - lt) * 0.5 * dt, 0, 1); this.baseThrottle = Math.min(0.8, thr); }
      A.gun = A.gun || !!gp.buttons[0]?.pressed;
      const edge = (i, name) => { const p = !!gp.buttons[i]?.pressed; if (p && !this['_b' + i]) A[name] = true; this['_b' + i] = p; };
      edge(1, 'missile'); edge(2, 'flares'); edge(3, 'lock'); edge(4, 'cycleWpn'); edge(5, 'camera');
      if (gp.buttons[11]?.pressed) A.targetView = this._tgl(true);   // 오른쪽 스틱 누르기 = 적 추적 시점
    }
    this.throttle = thr;
  }
  /** 외부에서 스로틀을 설정할 때 (모드 시작 등) */
  setThrottle(t) { this.throttle = t; this.baseThrottle = Math.min(0.8, t); }
  endFrame() {
    this.pressed.clear();
    this.lookDX = 0; this.lookDY = 0; this.flightDX = 0; this.flightDY = 0; this.wheel = 0;
    this.mouse.rHit = false; this.mouse.lHit = false; this.mouse.mHit = false; this.mouse.b3Hit = false; this.mouse.b4Hit = false;
  }
}
