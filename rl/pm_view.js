// PM 확인용 (그래픽 리뷰): await import('/rl/pm_view.js?'+Date.now())
// pmStart() → 공중전 시작 후 궤도 카메라. pmView(az, el, r) / pmFix(dist) 고정 카메라 / pmBoom(size)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.pmStart = async (hud = false) => {
  for (let i = 0; i < 80 && !window.__game; i++) await wait(250);
  document.querySelector('.mode')?.click();
  await wait(800);
  const g = window.__game;
  window.__view = { az: 1.6, el: 0.15, r: 28 };
  g.updateCamera = function () {
    const c = this.camera;
    if (window.__fix) { c.position.copy(window.__fix.cp); c.up.set(0, 1, 0); c.lookAt(window.__fix.tgt); }
    else {
      const v = window.__view, p = this.player.fm.pos;
      c.position.set(p.x + Math.sin(v.az) * Math.cos(v.el) * v.r, p.y + Math.sin(v.el) * v.r, p.z + Math.cos(v.az) * Math.cos(v.el) * v.r);
      c.up.set(0, 1, 0); c.lookAt(p);
    }
    if (c.fov !== 40) { c.fov = 40; c.updateProjectionMatrix(); }
    c.updateMatrixWorld();
  };
  g.hudOn = hud;
  return 'started';
};
window.pmView = (az, el, r) => { window.__fix = null; window.__view = { az, el, r }; };
window.pmFix = (dist = 250, yawOff = 0) => {
  const g = window.__game, p = g.player.fm.pos.clone();
  const tgt = p.clone(); tgt.x += Math.cos(yawOff) * dist; tgt.z += Math.sin(yawOff) * dist;
  window.__fix = { cp: p, tgt };
};
window.pmBoom = (size = 1.5) => {
  const g = window.__game, f = window.__fix;
  const v0 = g.player.fm.vel.clone().multiplyScalar(0);
  g.effects.explosion(f.tgt.clone(), v0, size, true);
};
window.pmCam = () => { const g = window.__game; delete g.updateCamera; window.__fix = null; g.hudOn = true; };
export {};
