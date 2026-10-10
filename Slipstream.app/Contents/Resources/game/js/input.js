'use strict';
// ---------------------------------------------------------------------------
// Input: keyboard (smoothed virtual stick), mouse-aim, gamepad.
// ---------------------------------------------------------------------------
class Input {
  constructor() {
    this.keys = new Set(); this.pressed = new Set();
    this.stick = { pitch: 0, roll: 0, yaw: 0 };
    this.mouse = { dx: 0, dy: 0, x: 0, y: 0, buttons: 0, wheel: 0, dragging: false, locked: false };
    this.invert = false; this.sens = 1;
    this.mouseAim = false;
    this.pad = null;
    window.addEventListener('keydown', e => {
      const k = e.code, t = e.target;
      // a visible focused slider/select keeps its own navigation keys; everything else is game input
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT') && t.offsetParent !== null &&
          /^(Arrow|Page|Home|End|Tab)/.test(k)) return;
      // the native host's WKWebView passes any keydown the page leaves unhandled on to AppKit,
      // which finds no responder and plays the system alert beep. Consume every key except the
      // Cmd shortcuts the menu bar owns (quit, hide, minimise, full screen).
      if (!(e.metaKey && ['KeyQ', 'KeyH', 'KeyM', 'KeyF', 'Comma'].includes(k))) e.preventDefault();
      if (e.metaKey) return;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
    });
    window.addEventListener('keyup', e => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.buttons = 0; });
    const cv = document.getElementById('gl');
    const hud = document.getElementById('hud');
    const target = document.getElementById('stage');
    let lastX = null, lastY = null;
    target.addEventListener('mousemove', e => {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      if (document.pointerLockElement) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
      else if (lastX !== null) { this.mouse.dx += e.clientX - lastX; this.mouse.dy += e.clientY - lastY; }
      lastX = e.clientX; lastY = e.clientY;
    });
    target.addEventListener('mousedown', e => {
      this.mouse.buttons |= (1 << e.button);
      if (e.button === 0 || e.button === 2) this.pressed.add('Mouse' + e.button);
      if (this.mouseAim && this.captureOK && !document.pointerLockElement && target.requestPointerLock) { try { target.requestPointerLock(); } catch (err) { } }
    });
    window.addEventListener('mouseup', e => { this.mouse.buttons &= ~(1 << e.button); });
    target.addEventListener('contextmenu', e => e.preventDefault());
    target.addEventListener('wheel', e => { this.mouse.wheel += e.deltaY; e.preventDefault(); }, { passive: false });
    window.addEventListener('gamepadconnected', e => { this.pad = e.gamepad.index; });
  }
  down(...codes) { for (const c of codes) if (this.keys.has(c)) return true; return false; }
  hit(...codes) { for (const c of codes) if (this.pressed.has(c)) return true; return false; }
  endFrame() { this.pressed.clear(); this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0; }
  releasePointer() { if (document.pointerLockElement) document.exitPointerLock(); }

  gamepad() {
    if (this.pad === null || !navigator.getGamepads) return null;
    const g = navigator.getGamepads()[this.pad]; if (!g || !g.connected) return null;
    const dz = v => Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92;
    return { lx: dz(g.axes[0] || 0), ly: dz(g.axes[1] || 0), rx: dz(g.axes[2] || 0), ry: dz(g.axes[3] || 0), b: g.buttons.map(b => b.value) };
  }

  // smoothed stick from keyboard (+ gamepad)
  updateStick(dt) {
    const s = this.stick;
    const tgtP = (this.down('KeyS', 'ArrowDown') ? 1 : 0) - (this.down('KeyW', 'ArrowUp') ? 1 : 0);
    const tgtR = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    const tgtY = (this.down('KeyE') ? 1 : 0) - (this.down('KeyQ') ? 1 : 0);
    const ramp = (cur, tgt, up, back) => {
      if (tgt === 0) return damp(cur, 0, back, dt);
      if (Math.sign(tgt) !== Math.sign(cur) && Math.abs(cur) > 0.05) return damp(cur, 0, back * 1.5, dt);
      return clamp(cur + tgt * up * dt, -1, 1);
    };
    s.pitch = ramp(s.pitch, this.invert ? -tgtP : tgtP, 2.4, 7);
    s.roll = ramp(s.roll, tgtR, 3.2, 9);
    s.yaw = ramp(s.yaw, tgtY, 2.5, 6);
    const gp = this.gamepad();
    this.padState = gp;
    if (gp) {
      const ex = v => Math.sign(v) * Math.pow(Math.abs(v), 1.6);
      if (gp.ly) s.pitch = ex(this.invert ? -gp.ly : gp.ly);
      if (gp.lx) s.roll = ex(gp.lx);
      if (gp.rx) s.yaw = ex(gp.rx);
    }
    // keyboard expo: finer response near center
    return { pitch: Math.sign(s.pitch) * Math.pow(Math.abs(s.pitch), 1.25), roll: Math.sign(s.roll) * Math.pow(Math.abs(s.roll), 1.15), yaw: s.yaw };
  }
}
