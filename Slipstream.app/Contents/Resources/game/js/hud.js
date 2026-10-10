'use strict';
// ---------------------------------------------------------------------------
// HUD: conformal flight symbology + combat overlay on a 2D canvas.
// ---------------------------------------------------------------------------
class HUD {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.col = '#86ffb0'; this.warn = '#ff5a48'; this.ally = '#6ec8ff';
    this.msgs = []; this.feed = []; this.mode = 0; // 0 full, 1 minimal, 2 off
    this.units = 'avi';
    this._clip = new Float32Array(4);
    this.maxG = 1;
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.cv.clientWidth * dpr), h = Math.round(this.cv.clientHeight * dpr);
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.dpr = dpr; this.W = w; this.H = h;
  }
  message(text, kind = 'info', time = 2.6) { this.msgs.push({ text, kind, t: time, max: time }); if (this.msgs.length > 4) this.msgs.shift(); }
  kill(text) { this.feed.unshift({ text, t: 7 }); if (this.feed.length > 5) this.feed.pop(); }
  clear() { this.ctx.clearRect(0, 0, this.cv.width, this.cv.height); }

  // project camera-relative direction or point → screen px; returns null if behind
  proj(VP, x, y, z, out) {
    const w = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
    if (w <= 0.01) return null;
    const cx = (VP[0] * x + VP[4] * y + VP[8] * z + VP[12]) / w, cy = (VP[1] * x + VP[5] * y + VP[9] * z + VP[13]) / w;
    out[0] = (cx * 0.5 + 0.5) * this.W; out[1] = (0.5 - cy * 0.5) * this.H; out[2] = w;
    return out;
  }
  projDir(VP, d, out) { return this.proj(VP, d.x * 1e4, d.y * 1e4, d.z * 1e4, out); }
  projPoint(VP, cam, p, out) { return this.proj(VP, p.x - cam.x, p.y - cam.y, p.z - cam.z, out); }

  draw(G, dt) {
    this.resize();
    const c = this.ctx, W = this.W, H = this.H, s = this.dpr;
    c.clearRect(0, 0, W, H);
    this.msgs.forEach(m => m.t -= dt); this.msgs = this.msgs.filter(m => m.t > 0);
    this.feed.forEach(m => m.t -= dt); this.feed = this.feed.filter(m => m.t > 0);
    const ac = G.player; if (!ac) return;
    const fm = ac.fm, o = fm.out, VP = G.renderer.VP, cam = G.camera.pos;
    const col = this.col;
    const sc = Math.min(W, H) / 900; // HUD scale
    const fpx = (n) => Math.round(n * sc) + 'px ui-monospace, "SF Mono", Menlo, monospace';
    c.lineJoin = 'round'; c.lineCap = 'round';
    const glowStroke = (fn, color = col, w = 1.6) => {
      c.strokeStyle = color; c.globalAlpha = 0.22; c.lineWidth = w * sc * 3.2; fn(); c.stroke();
      c.globalAlpha = 1; c.lineWidth = w * sc; fn(); c.stroke();
    };
    const text = (t, x, y, size, align = 'left', color = col, base = 'middle') => {
      c.font = fpx(size); c.textAlign = align; c.textBaseline = base;
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillText(t, x + sc, y + sc);
      c.fillStyle = color; c.fillText(t, x, y);
    };
    if (this.mode === 2) { this.drawMessages(G, c, W, H, sc, text); return; }
    const P = this._clip, Q = [0, 0, 0];
    const fwd = fm.fwd(new V3()), up = fm.up(new V3()), rgt = fm.right(new V3());
    const eul = fm.euler();
    const hdg = eul.hdg, pitch = eul.pitch, roll = eul.roll;
    const kts = this.units === 'avi';
    const spd = o.ias * (kts ? 1.94384 : 3.6), alt = fm.pos.y * (kts ? 3.28084 : 1);
    const vs = fm.vel.y * (kts ? 196.85 : 1);
    this.maxG = Math.max(this.maxG, o.G);
    // ---------- conformal: boresight, FPM, ladder ----------
    const bs = this.projDir(VP, fwd, [0, 0, 0]);
    const vdir = fm.vel.clone(); const vl = vdir.len();
    const fpm = vl > 5 ? this.projDir(VP, vdir.scale(1 / vl), [0, 0, 0]) : null;
    if (bs && this.mode === 0) {
      const r = 10 * sc;
      glowStroke(() => { c.beginPath(); c.moveTo(bs[0] - r * 1.6, bs[1]); c.lineTo(bs[0] - r * 0.5, bs[1]); c.moveTo(bs[0] + r * 0.5, bs[1]); c.lineTo(bs[0] + r * 1.6, bs[1]); c.moveTo(bs[0], bs[1] - r * 1.4); c.lineTo(bs[0], bs[1] - r * 0.5); });
    }
    if (fpm) {
      const r = 8 * sc;
      glowStroke(() => { c.beginPath(); c.arc(fpm[0], fpm[1], r, 0, Math.PI * 2); c.moveTo(fpm[0] - r, fpm[1]); c.lineTo(fpm[0] - r * 2.4, fpm[1]); c.moveTo(fpm[0] + r, fpm[1]); c.lineTo(fpm[0] + r * 2.4, fpm[1]); c.moveTo(fpm[0], fpm[1] - r); c.lineTo(fpm[0], fpm[1] - r * 2); });
    }
    // pitch ladder (world-conformal)
    if (this.mode === 0) {
      const h = hdg * DEG;
      const R = new V3(Math.cos(h), 0, Math.sin(h));
      const center = fpm || bs;
      c.save();
      if (center) { c.beginPath(); c.arc(center[0], center[1], Math.min(W, H) * 0.33, 0, Math.PI * 2); c.clip(); }
      for (let a = -90; a <= 90; a += 5) {
        if (Math.abs(a - pitch) > 28) continue;
        const ar = a * DEG;
        const d = new V3(Math.sin(h) * Math.cos(ar), Math.sin(ar), -Math.cos(h) * Math.cos(ar));
        const half = (a === 0 ? 22 : 8) * DEG, gap = 3 * DEG;
        const pA = this.projDir(VP, d.clone().addScaled(R, -Math.tan(half)).normalize(), [0, 0, 0]);
        const pB = this.projDir(VP, d.clone().addScaled(R, -Math.tan(gap)).normalize(), [0, 0, 0]);
        const pC = this.projDir(VP, d.clone().addScaled(R, Math.tan(gap)).normalize(), [0, 0, 0]);
        const pD = this.projDir(VP, d.clone().addScaled(R, Math.tan(half)).normalize(), [0, 0, 0]);
        if (!pA || !pB || !pC || !pD) continue;
        if (a < 0) c.setLineDash([6 * sc, 5 * sc]); else c.setLineDash([]);
        const tick = 6 * sc * (a > 0 ? 1 : -1);
        const nx = -(pD[1] - pA[1]), ny = (pD[0] - pA[0]); const nl = Math.hypot(nx, ny) || 1;
        glowStroke(() => {
          c.beginPath(); c.moveTo(pA[0], pA[1]); c.lineTo(pB[0], pB[1]); c.moveTo(pC[0], pC[1]); c.lineTo(pD[0], pD[1]);
          if (a !== 0) { c.moveTo(pA[0], pA[1]); c.lineTo(pA[0] + nx / nl * tick, pA[1] + ny / nl * tick); c.moveTo(pD[0], pD[1]); c.lineTo(pD[0] + nx / nl * tick, pD[1] + ny / nl * tick); }
        }, col, a === 0 ? 1.8 : 1.3);
        c.setLineDash([]);
        if (a !== 0) { text(String(Math.abs(a)), pA[0] - 14 * sc, pA[1], 13, 'right'); text(String(Math.abs(a)), pD[0] + 14 * sc, pD[1], 13, 'left'); }
      }
      c.restore();
    }
    // ---------- heading tape ----------
    const tapeY = H * 0.08;
    {
      const cx = W / 2, span = 50, pxPer = W * 0.32 / span;
      c.save(); c.beginPath(); c.rect(cx - W * 0.17, tapeY - 30 * sc, W * 0.34, 60 * sc); c.clip();
      glowStroke(() => {
        c.beginPath();
        for (let d = Math.floor((hdg - span / 2) / 5) * 5; d <= hdg + span / 2; d += 5) {
          const x = cx + (d - hdg) * pxPer, big = d % 10 === 0;
          c.moveTo(x, tapeY); c.lineTo(x, tapeY + (big ? 10 : 6) * sc);
        }
      }, col, 1.2);
      for (let d = Math.ceil((hdg - span / 2) / 10) * 10; d <= hdg + span / 2; d += 10) {
        const x = cx + (d - hdg) * pxPer; const v = ((d % 360) + 360) % 360;
        text(v === 0 ? 'N' : v === 90 ? 'E' : v === 180 ? 'S' : v === 270 ? 'W' : pad(v / 10, 2), x, tapeY - 10 * sc, 13, 'center');
      }
      c.restore();
      glowStroke(() => { c.beginPath(); c.moveTo(cx, tapeY + 14 * sc); c.lineTo(cx - 6 * sc, tapeY + 22 * sc); c.lineTo(cx + 6 * sc, tapeY + 22 * sc); c.closePath(); });
      text(pad(hdg, 3), cx, tapeY + 34 * sc, 15, 'center');
    }
    // ---------- speed & altitude tapes ----------
    const tapeH = H * 0.42, tY = H * 0.5;
    const tape = (x, val, step, label, right) => {
      const pxPer = tapeH / (step * 10);
      c.save(); c.beginPath(); c.rect(x - 70 * sc, tY - tapeH / 2, 140 * sc, tapeH); c.clip();
      glowStroke(() => {
        c.beginPath();
        c.moveTo(x, tY - tapeH / 2); c.lineTo(x, tY + tapeH / 2);
        for (let v = Math.floor((val - step * 6) / step) * step; v <= val + step * 6; v += step) {
          const y = tY - (v - val) * pxPer; c.moveTo(x, y); c.lineTo(x + (right ? 10 : -10) * sc, y);
        }
      }, col, 1.1);
      for (let v = Math.floor((val - step * 6) / (step * 2)) * step * 2; v <= val + step * 6; v += step * 2) {
        const y = tY - (v - val) * pxPer; if (Math.abs(y - tY) < 16 * sc) continue;
        text(String(Math.round(v)), x + (right ? 16 : -16) * sc, y, 13, right ? 'left' : 'right');
      }
      c.restore();
      const bw = 76 * sc, bh = 26 * sc, bx = right ? x + 6 * sc : x - 6 * sc - bw;
      c.fillStyle = 'rgba(0,10,4,0.55)'; c.fillRect(bx, tY - bh / 2, bw, bh);
      glowStroke(() => { c.beginPath(); c.rect(bx, tY - bh / 2, bw, bh); }, col, 1.2);
      text(String(Math.round(val)), bx + bw / 2, tY, 17, 'center');
      text(label, x + (right ? 6 : -6) * sc, tY - tapeH / 2 - 14 * sc, 12, right ? 'left' : 'right');
    };
    tape(W * 0.31, spd, kts ? 10 : 20, kts ? 'KIAS' : 'KM/H', false);
    tape(W * 0.69, alt, kts ? 100 : 50, kts ? 'FT' : 'M', true);
    // readouts under tapes
    const ly = tY + tapeH / 2 + 22 * sc;
    text('M ' + o.mach.toFixed(2), W * 0.31 - 6 * sc, ly, 14, 'right');
    text('G ' + o.G.toFixed(1), W * 0.31 - 6 * sc, ly + 20 * sc, 14, 'right', o.G > ac.spec.fcs.gLimit * 0.95 ? this.warn : col);
    text('α ' + o.alpha.toFixed(1) + '°', W * 0.31 - 6 * sc, ly + 40 * sc, 14, 'right', o.stallFrac > 0.3 ? this.warn : col);
    text((vs >= 0 ? '+' : '') + Math.round(vs) + (kts ? ' FPM' : ' M/S'), W * 0.69 + 6 * sc, ly, 14, 'left');
    if (o.agl < 760) text('R ' + Math.round(Math.max(0, o.agl - 1) * (kts ? 3.28 : 1)), W * 0.69 + 6 * sc, ly + 20 * sc, 14, 'left');
    // ---------- engine / config (bottom-left) ----------
    const bx = W * 0.06, by = H * 0.74;
    {
      const thr = fm.ctl.throttle, hb = 110 * sc;
      glowStroke(() => { c.beginPath(); c.rect(bx, by, 10 * sc, hb); }, col, 1);
      c.fillStyle = fm.eng.ab > 0.3 ? '#ffb347' : col; c.globalAlpha = 0.8; c.fillRect(bx + 2 * sc, by + hb - hb * thr, 6 * sc, hb * thr); c.globalAlpha = 1;
      const E = ac.spec.engine;
      const eng = E.type === 'jet' ? 'N1 ' + Math.round(fm.eng.n * 100) + '%' : E.type === 'prop' ? 'RPM ' + Math.round(fm.eng.rpm) : 'GLIDER';
      text(eng, bx + 20 * sc, by + 8 * sc, 13);
      text('THR ' + Math.round(thr * 100) + '%', bx + 20 * sc, by + 28 * sc, 13);
      if (fm.eng.ab > 0.3) text('AFTERBURNER', bx + 20 * sc, by + 48 * sc, 13, 'left', '#ffb347');
      const gs = fm.gearRetract ? (fm.ctl.gear > 0.98 ? 'GEAR DN' : fm.ctl.gear < 0.02 ? 'GEAR UP' : 'GEAR ···') : 'GEAR FIX';
      text(gs, bx + 20 * sc, by + 68 * sc, 13, 'left', fm.ctl.gear > 0.02 && fm.ctl.gear < 0.98 ? '#ffd166' : col);
      text('FLAPS ' + Math.round(fm.ctl.flaps * 100) + '%', bx + 20 * sc, by + 88 * sc, 13);
      let flags = [];
      if (fm.ctl.brake > 0.1) flags.push('BRK'); if (fm.ctl.airbrake > 0.1) flags.push('SPDBRK'); if (fm.ctl.hook > 0.5) flags.push('HOOK');
      if (!ac.assist && ac.spec.fcs.type !== 'fbw') flags.push('MANUAL');
      text(flags.join(' '), bx + 20 * sc, by + 108 * sc, 13);
      text('T/W ' + (fm.eng.thrust / (fm.mass * G0)).toFixed(2), bx + 20 * sc, by - 14 * sc, 12, 'left', 'rgba(134,255,176,0.75)');
    }
    // ---------- weapons (bottom-right) ----------
    if (ac.spec.guns || ac.wpn.ir || ac.wpn.radar) {
      const wx = W * 0.94, wy = H * 0.76, Wp = ac.wpn;
      const rows = [];
      if (ac.spec.guns) rows.push(['gun', 'GUN', Wp.ammo]);
      if ((ac.spec.weapons || {}).ir) rows.push(['ir', 'IR MSL', Wp.ir]);
      if ((ac.spec.weapons || {}).radar) rows.push(['radar', 'RDR MSL', Wp.radar]);
      if ((ac.spec.weapons || {}).flares) rows.push(['cm', 'FLR/CHF', Wp.flares]);
      rows.forEach((r, i) => {
        const sel = Wp.sel === r[0];
        text((sel ? '▸ ' : '  ') + r[1], wx - 70 * sc, wy + i * 20 * sc, 13, 'right', sel ? '#ffffff' : col);
        text(String(r[2]), wx, wy + i * 20 * sc, 13, 'right', r[2] === 0 ? this.warn : (sel ? '#ffffff' : col));
      });
    }
    // ---------- targets ----------
    this.drawTargets(G, c, W, H, sc, text, glowStroke, VP, cam, fwd);
    // ---------- radar scope ----------
    if (this.mode === 0 && G.mode !== 'free') this.drawRadar(G, c, W, H, sc, text, glowStroke, hdg);
    // ---------- warnings ----------
    let wy = H * 0.66;
    const warnT = (t) => { if ((performance.now() / 300 | 0) % 2 === 0) text(t, W / 2, wy, 22, 'center', this.warn); wy += 28 * sc; };
    if (G.warn.missile) warnT('◆ MISSILE ◆');
    if (G.warn.pullUp) warnT('PULL UP');
    if (G.warn.stall) warnT('STALL');
    if (G.warn.gear) warnT('GEAR');
    if (G.warn.overG) warnT('OVER-G');
    if (fm.catapult && fm.catapult.state === 'hold') text('CATAPULT HOOKED — FULL POWER, PRESS ENTER TO LAUNCH', W / 2, H * 0.62, 15, 'center', '#ffd166');
    if (fm.hookEngaged) text(fm.arrested ? 'TRAPPED' : 'WIRE ENGAGED', W / 2, H * 0.62, 18, 'center', '#ffd166');
    // missile warning direction ring
    if (G.warn.missileDir) {
      const md = G.warn.missileDir.clone().applyQuatInv(fm.q);
      const a = Math.atan2(md.x, -md.z);
      const R = Math.min(W, H) * 0.22;
      c.save(); c.translate(W / 2, H / 2); c.rotate(a);
      c.fillStyle = this.warn; c.globalAlpha = 0.85;
      c.beginPath(); c.moveTo(0, -R - 18 * sc); c.lineTo(-10 * sc, -R); c.lineTo(10 * sc, -R); c.closePath(); c.fill();
      c.restore(); c.globalAlpha = 1;
    }
    // ---------- aero view ----------
    if (G.aeroView) this.drawAero(G, c, W, H, sc, text);
    this.drawMessages(G, c, W, H, sc, text);
  }

  drawTargets(G, c, W, H, sc, text, glowStroke, VP, cam, fwd) {
    const ac = G.player, Wp = ac.wpn;
    const P = [0, 0, 0];
    let nearest = null, nd = 1e9;
    for (const t of G.aircraft) {
      if (t === ac || !t.visible || t.fm.crashed) continue;
      const d = t.pos.distTo(ac.pos);
      if (d > 40000) continue;
      const enemy = t.team !== ac.team;
      if (enemy && t.alive && d < nd) { nd = d; nearest = t; }
      const p = this.projPoint(VP, cam, t.pos, P);
      const color = !t.alive ? 'rgba(255,255,255,0.4)' : enemy ? this.warn : this.ally;
      const onScreen = p && p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H;
      if (onScreen) {
        const r = Math.max(9 * sc, Math.min(40 * sc, t.geo.radius / Math.max(p[2], 1) * H * 0.9));
        if (enemy) glowStroke(() => { c.beginPath(); c.moveTo(p[0], p[1] - r); c.lineTo(p[0] + r, p[1]); c.lineTo(p[0], p[1] + r); c.lineTo(p[0] - r, p[1]); c.closePath(); }, color, 1.2);
        else glowStroke(() => { c.beginPath(); c.moveTo(p[0], p[1] - r); c.lineTo(p[0] + r * 0.9, p[1] + r * 0.6); c.lineTo(p[0] - r * 0.9, p[1] + r * 0.6); c.closePath(); }, color, 1.1);
        const dist = this.units === 'avi' ? (d / 1852).toFixed(d < 1852 * 10 ? 1 : 0) + 'nm' : (d / 1000).toFixed(1) + 'km';
        text(dist, p[0] + r + 6 * sc, p[1] - 6 * sc, 12, 'left', color);
        if (d < 6000) text(t.callsign, p[0] + r + 6 * sc, p[1] + 9 * sc, 11, 'left', color);
        if (Wp.lock === t) {
          const R = r + 10 * sc;
          if (Wp.lockState === 2) {
            glowStroke(() => { c.beginPath(); c.arc(p[0], p[1], R, 0, Math.PI * 2); }, '#ffffff', 1.8);
            text('LOCK', p[0], p[1] + R + 14 * sc, 13, 'center', '#ffffff');
          } else {
            c.setLineDash([5 * sc, 5 * sc]);
            glowStroke(() => { c.beginPath(); c.arc(p[0], p[1], R + 6 * sc * Math.sin(performance.now() / 90), 0, Math.PI * 2); }, col2(this), 1.4);
            c.setLineDash([]);
          }
        }
      }
    }
    // gun lead pipper on nearest enemy
    const Gn = ac.spec.guns;
    if (Gn && nearest && nd < 1800) {
      const tf = nd / (Gn.vel + 40);
      const lead = nearest.pos.clone().addScaled(nearest.vel, tf).addScaled(ac.vel, -tf); lead.y += 0.5 * G0 * tf * tf;
      // pipper shows where the target will be relative to the gun line → draw at bore offset by (target - lead)
      const tp = this.projPoint(VP, cam, nearest.pos, [0, 0, 0]), lp = this.projPoint(VP, cam, lead, [0, 0, 0]);
      const bs = this.projDir(VP, fwd, [0, 0, 0]);
      if (tp && lp && bs) {
        const px = bs[0] + (tp[0] - lp[0]), py = bs[1] + (tp[1] - lp[1]);
        const rr = 14 * sc; const inR = nd < 900;
        glowStroke(() => { c.beginPath(); c.arc(px, py, rr, 0, Math.PI * 2); c.moveTo(px + 2 * sc, py); c.arc(px, py, 2 * sc, 0, Math.PI * 2); }, inR ? '#ffffff' : this.col, 1.4);
        // range arc
        glowStroke(() => { c.beginPath(); c.arc(px, py, rr + 5 * sc, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(1 - nd / 1800, 0, 1)); }, this.col, 1.6);
      }
    }
    // off-screen pointer
    const tgt = (Wp.lock && Wp.lock.alive) ? Wp.lock : nearest;
    if (tgt) {
      const p = this.projPoint(VP, cam, tgt.pos, [0, 0, 0]);
      const on = p && p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H;
      if (!on) {
        const rel = tgt.pos.clone().sub(G.camera.pos).applyQuatInv(G.camera.q);
        const a = Math.atan2(rel.x, rel.y);
        const R = Math.min(W, H) * 0.36;
        c.save(); c.translate(W / 2, H / 2); c.rotate(a);
        glowStroke(() => { c.beginPath(); c.moveTo(0, -R - 16 * sc); c.lineTo(-9 * sc, -R); c.lineTo(9 * sc, -R); c.closePath(); }, this.warn, 1.5);
        c.restore();
      }
    }
  }

  drawRadar(G, c, W, H, sc, text, glowStroke, hdg) {
    const ac = G.player; const R = 74 * sc, cx = W / 2, cy = H - R - 26 * sc;
    const range = ac.wpn.sel === 'radar' ? 30000 : 15000;
    c.fillStyle = 'rgba(0,14,6,0.45)'; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
    glowStroke(() => { c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.moveTo(cx + R * 0.5, cy); c.arc(cx, cy, R * 0.5, 0, Math.PI * 2); }, 'rgba(134,255,176,0.6)', 1);
    glowStroke(() => { c.beginPath(); c.moveTo(cx, cy - 5 * sc); c.lineTo(cx - 4 * sc, cy + 4 * sc); c.lineTo(cx + 4 * sc, cy + 4 * sc); c.closePath(); }, this.col, 1.2);
    const h = hdg * DEG, ch = Math.cos(h), sh = Math.sin(h);
    const plot = (p, color, size, shape) => {
      const dx = p.x - ac.pos.x, dz = p.z - ac.pos.z;
      // rotate into heading-up frame
      const right = dx * ch + dz * sh, fwd = dx * sh - dz * ch;
      const x = cx + right / range * R, y = cy - fwd / range * R;
      if (Math.hypot(x - cx, y - cy) > R) return;
      c.fillStyle = color;
      if (shape === 'm') { c.fillRect(x - 1.5 * sc, y - 1.5 * sc, 3 * sc, 3 * sc); return; }
      c.beginPath(); c.arc(x, y, size * sc, 0, Math.PI * 2); c.fill();
    };
    for (const t of G.aircraft) if (t !== ac && t.alive && t.visible) plot(t.pos, t.team === ac.team ? this.ally : this.warn, ac.wpn.lock === t ? 4 : 3);
    for (const m of G.weapons.missiles) if (m.active) plot(m.pos, m.target === ac ? '#ffffff' : '#ffd166', 2, 'm');
    text((range / 1000) + ' KM', cx + R + 6 * sc, cy + R - 6 * sc, 11, 'left', 'rgba(134,255,176,0.7)');
  }

  drawAero(G, c, W, H, sc, text) {
    const ac = G.player, fm = ac.fm;
    const x = 22 * sc, y0 = H * 0.17;
    const w = 300 * sc;
    c.fillStyle = 'rgba(4,10,14,0.62)'; c.fillRect(x - 10 * sc, y0 - 26 * sc, w, 30 * sc + fm.segs.length * 17 * sc + 120 * sc);
    text('AERO // PANEL LOADS', x, y0 - 10 * sc, 13, 'left', '#ffffff');
    let L = 0, D = 0;
    const vdir = fm.vel.clone().normalize().applyQuatInv(fm.q);
    fm.segs.forEach((s, i) => {
      const y = y0 + 10 * sc + i * 17 * sc;
      const nm = (s.kind === 'vtail' ? 'FIN' : s.kind === 'htail' ? 'TAIL' : s.kind.toUpperCase()) + (s.side < 0 ? ' L' : ' R') + (s.ctls.length ? '·' + s.ctls[0].kind.slice(0, 3).toUpperCase() : s.am ? '·ALL' : '');
      text(nm, x, y, 11, 'left', s.stalled ? '#ff4fa3' : '#cfe8ff');
      const cl = clamp(s.cl, -1.6, 1.6);
      const bx = x + 118 * sc, bw = 90 * sc;
      c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(bx, y - 5 * sc, bw, 10 * sc);
      c.fillStyle = s.stalled ? '#ff4fa3' : (cl >= 0 ? '#ff8a4c' : '#4ca6ff');
      const mid = bx + bw / 2; c.fillRect(Math.min(mid, mid + cl / 1.6 * bw / 2), y - 4 * sc, Math.abs(cl / 1.6 * bw / 2), 8 * sc);
      text((s.alpha * RAD).toFixed(1) + '°', bx + bw + 8 * sc, y, 11, 'left', '#cfe8ff');
      const defl = s.ctls.length ? s.ctls[0].defl : (s.am ? s.am.defl : 0);
      if (s.ctls.length || s.am) text((defl * RAD >= 0 ? '+' : '') + (defl * RAD).toFixed(0) + '°', bx + bw + 52 * sc, y, 11, 'left', '#ffd166');
      // totals in wind axes
      const f = s.force; const drag = -(f.x * vdir.x + f.y * vdir.y + f.z * vdir.z) * -1;
      D += f.x * vdir.x + f.y * vdir.y + f.z * vdir.z; L += f.y;
    });
    const yb = y0 + 20 * sc + fm.segs.length * 17 * sc;
    text('LIFT ' + (L / 1000).toFixed(1) + ' kN   DRAG ' + (Math.abs(D) / 1000).toFixed(1) + ' kN', x, yb, 12, 'left', '#ffffff');
    text('L/D ' + (Math.abs(D) > 1 ? (L / Math.abs(D)).toFixed(1) : '--') + '   THRUST ' + (fm.eng.thrust / 1000).toFixed(1) + ' kN', x, yb + 18 * sc, 12, 'left', '#ffffff');
    text('β ' + fm.out.beta.toFixed(1) + '°   ρ ' + fm.atm.rho.toFixed(3) + '   q ' + (fm.out.qbar / 1000).toFixed(1) + ' kPa', x, yb + 36 * sc, 12, 'left', '#cfe8ff');
    if (fm.prop) text('SLIPSTREAM v_i ' + fm.eng.vi.toFixed(1) + ' m/s', x, yb + 54 * sc, 12, 'left', '#cfe8ff');
    text('red = lift, blue = downforce, magenta = stalled', x, yb + 74 * sc, 11, 'left', 'rgba(255,255,255,0.55)');
  }

  drawMessages(G, c, W, H, sc, text) {
    let y = H * 0.24;
    for (const m of this.msgs) {
      const a = Math.min(1, m.t / 0.4, (m.max - m.t) / 0.15 + 0.2);
      c.globalAlpha = clamp(a, 0, 1);
      text(m.text, W / 2, y, m.kind === 'big' ? 26 : 17, 'center', m.kind === 'warn' ? this.warn : m.kind === 'good' ? '#ffffff' : this.col);
      y += 30 * sc;
    }
    c.globalAlpha = 1;
    let fy = H * 0.07;
    for (const f of this.feed) { c.globalAlpha = Math.min(1, f.t); text(f.text, W - 26 * sc, fy, 13, 'right', '#e8f4ff'); fy += 20 * sc; }
    c.globalAlpha = 1;
  }
}
function col2(h) { return h.col; }
