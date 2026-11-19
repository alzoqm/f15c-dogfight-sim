// 커스텀 조작 설정 화면: 동작마다 키·마우스 버튼 2개까지 지정, 마우스 비행·스로틀 방식 설정
// 설정은 input.custom에 바로 반영되고 localStorage에 저장된다 (input.js saveCustom)
import { ACTIONS, presetCustom, saveCustom, keyLabel } from './input.js';

const $ = (id) => document.getElementById(id);
const NAME = Object.fromEntries(ACTIONS.map(([id, label]) => [id, label]));

/**
 * @param input  Input 인스턴스
 * @param shared { sens: HTMLInputElement, invert: HTMLInputElement } 메뉴의 공통 마우스 감도·반전 (같은 값을 공유)
 * @param onChange 설정이 바뀔 때마다 호출 (메뉴 키 안내표 갱신 등)
 */
export function setupKeybind(input, shared, onChange) {
  const root = $('keybind'), table = $('kb-table');
  let wait = null;   // { action, slot, btn }

  const C = () => input.custom;
  const save = () => { saveCustom(C()); onChange?.(); };
  const msg = (t) => { $('kb-msg').textContent = t || ''; };

  function render() {
    let html = '', group = '';
    for (const [id, label, g] of ACTIONS) {
      if (g !== group) { group = g; html += `<tr><th colspan="3">${g}</th></tr>`; }
      const b = C().binds[id] || [];
      const slot = (i) => `<button type="button" class="kb-slot${b[i] ? '' : ' empty'}" data-a="${id}" data-s="${i}">${b[i] ? keyLabel(b[i]) : '—'}</button>`;
      html += `<tr><td>${label}</td><td>${slot(0)}</td><td>${slot(1)}</td></tr>`;
    }
    table.innerHTML = html;
    const M = C().mouse;
    $('kb-throttle').value = C().throttle;
    $('kb-mflight').checked = !!M.flight;
    $('kb-xaxis').value = M.xAxis;
    $('kb-ysens').value = M.ySens; $('kb-ysens-val').textContent = (+M.ySens).toFixed(1) + '×';
    $('kb-recenter').value = M.recenter; $('kb-recenter-val').textContent = +M.recenter === 0 ? '없음 (유지)' : (+M.recenter).toFixed(1);
    $('kb-sens').value = shared.sens.value; $('kb-sens-val').textContent = (+shared.sens.value).toFixed(1) + '×';
    $('kb-invert').checked = shared.invert.checked;
  }

  function stopWait() {
    if (wait) wait.btn.classList.remove('wait');
    wait = null; input.capturing = false;
  }

  function assign(code) {
    const { action, slot } = wait;
    stopWait();
    const B = C().binds;
    const moved = [];
    if (code) {
      // 다른 동작에 같은 키가 있으면 그 동작에서 뺌 (한 키 = 한 동작)
      for (const [id] of ACTIONS) {
        if (id === action) continue;
        const i = (B[id] || []).indexOf(code);
        if (i >= 0) { B[id].splice(i, 1); moved.push(NAME[id]); }
      }
    }
    const cur = (B[action] || []).slice(0, 2);
    const other = cur.filter((_, i) => i !== slot).filter((c) => c !== code);
    const next = slot === 0 ? [code, ...other] : [...other, code];
    B[action] = next.filter(Boolean).slice(0, 2);
    msg(code ? `${NAME[action]}: ${keyLabel(code)}` + (moved.length ? ` (‘${moved.join('’, ‘')}’에서 옮김)` : '') : `${NAME[action]}: 지움`);
    save(); render();
  }

  table.addEventListener('click', (e) => {
    const btn = e.target.closest('button.kb-slot');
    if (!btn) return;
    if (wait) stopWait();
    wait = { action: btn.dataset.a, slot: +btn.dataset.s, btn };
    btn.classList.add('wait'); btn.textContent = '키 입력…';
    input.capturing = true;
    msg(`${NAME[wait.action]} — 지정할 키나 마우스 버튼을 누르세요 (Esc 취소)`);
  });
  // 캡처 단계에서 가로채 게임·메뉴의 다른 키 처리보다 먼저 받음
  window.addEventListener('keydown', (e) => {
    if (!wait) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.code === 'Escape') { stopWait(); msg('취소'); render(); return; }
    if (e.code === 'Backspace' || e.code === 'Delete') { assign(null); return; }
    assign(e.code);
  }, true);
  let skipClick = false;
  window.addEventListener('mousedown', (e) => {
    if (!wait) return;
    // 키 표 바깥(완료 버튼·다른 설정)을 누르면 지정 취소하고 그 클릭은 그대로 둠
    if (!e.target.closest('.kb-table-wrap')) { stopWait(); msg('취소'); render(); return; }
    e.preventDefault(); e.stopImmediatePropagation();
    skipClick = true;   // 이 누름에 이어지는 click이 새 칸 지정을 시작하지 않도록
    assign('Mouse' + e.button);
  }, true);
  window.addEventListener('click', (e) => { if (skipClick) { skipClick = false; e.stopImmediatePropagation(); } }, true);
  window.addEventListener('mouseup', () => { setTimeout(() => { skipClick = false; }, 0); }, true);
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  root.addEventListener('auxclick', (e) => e.preventDefault());

  $('kb-preset').addEventListener('change', (e) => {
    const v = e.target.value; if (!v) return;
    const p = presetCustom(v);
    input.custom.binds = p.binds; input.custom.throttle = p.throttle; Object.assign(input.custom.mouse, p.mouse);
    e.target.value = '';
    msg(`‘${e.target.querySelector(`option[value=${v}]`).textContent}’ 배치를 불러왔습니다`);
    save(); render();
  });
  $('kb-throttle').addEventListener('change', (e) => { C().throttle = e.target.value; save(); });
  $('kb-mflight').addEventListener('change', (e) => { C().mouse.flight = e.target.checked; save(); });
  $('kb-xaxis').addEventListener('change', (e) => { C().mouse.xAxis = e.target.value; save(); });
  $('kb-ysens').addEventListener('input', (e) => { C().mouse.ySens = +e.target.value; save(); render(); });
  $('kb-recenter').addEventListener('input', (e) => { C().mouse.recenter = +e.target.value; save(); render(); });
  // 감도·반전은 메뉴의 공통 설정과 같은 값
  $('kb-sens').addEventListener('input', (e) => { shared.sens.value = e.target.value; shared.sens.dispatchEvent(new Event('input', { bubbles: true })); render(); });
  $('kb-invert').addEventListener('change', (e) => { shared.invert.checked = e.target.checked; shared.invert.dispatchEvent(new Event('input', { bubbles: true })); });

  const close = () => { stopWait(); msg(''); root.classList.add('hidden'); onChange?.(); };
  $('kb-close').addEventListener('click', close);
  return {
    open() { render(); msg(''); root.classList.remove('hidden'); },
    close,
    get isOpen() { return !root.classList.contains('hidden'); },
  };
}

/** 메뉴의 커스텀 키 안내표 (두 동작씩 한 줄) */
export function renderCustomKeys(input, el) {
  const B = input.custom.binds, M = input.custom.mouse;
  const fmt = (id) => (B[id] || []).map(keyLabel).join(' · ') || '—';
  const rows = ACTIONS.filter(([id]) => (B[id] || []).length);
  let html = `<tr><th colspan="4">커스텀 조작${M.flight ? ` — 마우스 비행 (좌우 = ${M.xAxis === 'yaw' ? '러더' : '롤'}, 상하 = 피치)` : ''} · 스로틀 ${input.custom.throttle === 'detent' ? '연속' : 'MIL + A/B 키'}</th></tr>`;
  for (let i = 0; i < rows.length; i += 2) {
    const a = rows[i], b = rows[i + 1];
    html += `<tr><td>${fmt(a[0])}</td><td>${a[1]}</td><td>${b ? fmt(b[0]) : ''}</td><td>${b ? b[1] : ''}</td></tr>`;
  }
  el.innerHTML = html;
}
