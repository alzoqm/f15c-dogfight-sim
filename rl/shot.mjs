// PM 리뷰용 헤드리스 크롬 스크린샷 (CDP, 의존성 없음)
// 사용: node rl/shot.mjs <out-prefix> <w> <h> <steps.json>
//   steps: [{ "js": "await pmStart()" }, { "wait": 1000 }, { "shot": "name" }, ...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [, , outDir, W = '1280', H = '720', stepsFile] = process.argv;
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'pmshot-'));
const ch = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--headless=new',
  `--window-size=${W},${H}`, '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); target = l.find((t) => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else if (m.method === 'Runtime.exceptionThrown') console.log('PAGE EXC', m.params.exceptionDetails?.exception?.description?.slice(0, 300)); else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('PAGE ERR', JSON.stringify(m.params.args.map((a) => a.value ?? a.description)).slice(0, 300)); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8615/' });
  for (let i = 0; i < 120; i++) { await sleep(250); const r = await send('Runtime.evaluate', { expression: "document.getElementById('load-text')?.textContent", returnByValue: true }); if (r.result.value === '완료') break; }
  await sleep(1500);
  await send('Runtime.evaluate', { expression: `import('/rl/pm_view.js?${Date.now()}')`, awaitPromise: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of steps) {
    if (s.wait) await sleep(s.wait);
    if (s.js) { const r = await send('Runtime.evaluate', { expression: `(async()=>{${s.js}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) console.log('JS ERR', r.exceptionDetails.exception?.description?.slice(0, 200)); else if (r.result.value !== undefined) console.log('JS', JSON.stringify(r.result.value).slice(0, 4000)); }
    if (s.shot) { const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 }); const f = path.join(outDir, s.shot + '.jpg'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); console.log('SHOT', f); }
  }
} catch (e) { console.log('FAIL', e.message); }
finally { try { ws?.close(); } catch {} ch.kill(); }
process.exit(0);
