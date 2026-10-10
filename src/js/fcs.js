'use strict';
// ---------------------------------------------------------------------------
// Flight control system. Maps stick inputs to control-surface deflections.
//  direct : stick -> surface (mechanical linkage)
//  fbw    : rate-command / attitude-hold with G and AoA limiting. Control
//           power is measured numerically from the aero model at load time,
//           then gain-scheduled with dynamic pressure (dynamic inversion).
// Channel sign conventions: pitch + = nose up, roll + = right wing down,
// yaw + = nose right.
// ---------------------------------------------------------------------------
class FCS {
  constructor(fm) {
    this.fm = fm; this.spec = fm.spec; this.cfg = fm.spec.fcs;
    this.iq = 0; this.ip = 0; this.ir = 0;
    this.items = [];
    this.probe();
    this.mode = this.cfg.type;
    this.out = { pitch: 0, roll: 0, yaw: 0 };
    this.trim = 0;
  }

  // numerically measure moment produced by each control at a reference condition
  probe() {
    const fm = this.fm, spec = this.spec;
    const V = spec.vref, rho = 1.225, alpha = 3 * DEG;
    const vb = new V3(0, -V * Math.sin(alpha), -V * Math.cos(alpha));
    fm.w.set(0, 0, 0); fm.out.agl = 1000; fm.gustScale = 0; Atmos.at(0, fm.atm);
    const F = new V3(), M0 = new V3(), M = new V3();
    const evalM = (out) => { F.set(0, 0, 0); out.set(0, 0, 0); for (const s of fm.segs) { s.vind.set(0, 0, 0); s.gamma = 0; } fm.aeroPanels(1 / 120, vb, V / 340, rho, F, out, null); return out; };
    evalM(M0);
    const d = 4 * DEG;
    const add = (obj, kind) => {
      obj.defl = d; evalM(M); obj.defl = 0;
      const k = obj.max / d;
      this.items.push({ obj, kind, dPitch: (M.x - M0.x) * k, dRoll: -(M.z - M0.z) * k, dYaw: -(M.y - M0.y) * k });
    };
    for (const s of fm.segs) {
      for (const c of s.ctls) add(c, c.kind);
      if (s.am) add(s.am, s.am.kind);
    }
    // channel allocation weights
    let Pp = 0, Pr = 0, Py = 0;
    for (const it of this.items) {
      const k = it.kind;
      it.wPitch = (k === 'elevator' || k === 'stab' || k === 'canard' || k === 'elevon') ? Math.sign(it.dPitch) : 0;
      it.wRoll = (k === 'aileron' || k === 'flaperon' || k === 'elevon') ? Math.sign(it.dRoll) : (k === 'stab' ? Math.sign(it.dRoll) * 0.4 : 0);
      it.wYaw = k === 'rudder' ? Math.sign(it.dYaw) : 0;
      it.wFlap = (k === 'flap' || k === 'flaperon') ? 1 : 0;
      if (k === 'canard') it.wPitch *= 0.8;
      if (k === 'elevon') { it.wPitch *= 0.7; it.wRoll *= 0.75; }
      Pp += Math.abs(it.dPitch * it.wPitch); Pr += Math.abs(it.dRoll * it.wRoll); Py += Math.abs(it.dYaw * it.wYaw);
    }
    this.qref = 0.5 * rho * V * V;
    this.Pp = Math.max(Pp, 1); this.Pr = Math.max(Pr, 1); this.Py = Math.max(Py, 1);
    for (const s of fm.segs) { s.vind.set(0, 0, 0); s.gamma = 0; }
  }

  // inp: {pitch, roll, yaw} -1..1 ; assist: bool
  update(dt, inp, assist) {
    const fm = this.fm, cfg = this.cfg, o = fm.out, w = fm.w;
    const V = Math.max(fm.out.tas, 1);
    const q = w.x, p = -w.z, r = -w.y;  // pitch-up, roll-right, yaw-right rates
    const qbar = Math.max(o.qbar, 30);
    const useFbw = cfg.type === 'fbw' || assist;
    let up = 0, ur = 0, uy = 0;
    const ground = o.wow;
    if (!useFbw) {
      up = clamp(inp.pitch + this.trim, -1, 1); ur = inp.roll; uy = inp.yaw;
      this.iq = 0; this.ip = 0;
    } else {
      // effectiveness now (moment per unit command)
      let effP = this.Pp * qbar / this.qref, effR = this.Pr * qbar / this.qref, effY = this.Py * qbar / this.qref;
      // prop slipstream adds control power at low speed
      if (fm.prop && fm.eng.vi > 0) { const k = 1 + Math.min(4, (fm.eng.vi * fm.eng.vi * 2 + fm.eng.vi * V * 2) / (V * V + 1)); effP *= k; effY *= k; }
      // thrust vectoring power
      const E = this.spec.engine;
      if (E.tvc) effP += fm.eng.thrust * Math.abs(fm.nozzle.z) * Math.sin(E.tvc * DEG);
      const I = fm.I;
      // ---- pitch: rate command with G / AoA limiting ----
      const qmax = Math.min(cfg.qmax, cfg.gLimit * G0 / V);
      const qmin = Math.max(-cfg.qmax, cfg.gMin * G0 / V);
      let qc = inp.pitch >= 0 ? inp.pitch * qmax : -inp.pitch * qmin;
      const alpha = o.alpha * DEG, aLim = cfg.aoaLimit * DEG;
      if (!ground) {
        if (alpha > aLim - 4 * DEG) qc = Math.min(qc, (aLim - alpha) * 2.2 + 0.05);
        if (alpha < -12 * DEG) qc = Math.max(qc, (-12 * DEG - alpha) * 2.2);
        // G-limit protection using measured load factor
        if (o.G > cfg.gLimit) qc = Math.min(qc, q - (o.G - cfg.gLimit) * 0.15);
        if (o.G < cfg.gMin) qc = Math.max(qc, q + (cfg.gMin - o.G) * 0.15);
      }
      const eq = qc - q;
      const Kq = ground ? 3 : 5.5, Ki = ground ? 0 : 7;
      this.iq = clamp(this.iq + eq * Ki * dt, -effP / I.x * 1.2, effP / I.x * 1.2);
      if (ground) this.iq *= 0.9;
      up = I.x * (Kq * eq + this.iq) / effP;
      if (ground) up = inp.pitch;
      // ---- roll ----
      const pmax = cfg.pmax * smooth(this.spec.vstall * 0.7, this.spec.vstall * 1.6, V);
      const pc = inp.roll * Math.max(pmax, 0.4);
      const ep = pc - p;
      this.ip = clamp(this.ip + ep * 2.5 * dt, -2, 2);
      ur = I.z * (6 * ep + this.ip) / effR;
      if (ground) ur = inp.roll * 0.6;
      // ---- yaw: damper + turn coordination ----
      const fwd = fm.fwd(_t1), rt = fm.right(_t2);
      const roll = Math.atan2(-rt.y, fm.up(_t3).y);
      const beta = o.beta * DEG;
      let rc = inp.yaw * 0.4;
      if (!ground && V > this.spec.vstall * 0.8) rc += G0 * Math.sin(roll) * Math.sqrt(Math.max(0, 1 - fwd.y * fwd.y)) / V * 0.9 + beta * 2.0;
      const er = rc - r;
      uy = I.y * (4 * er) / effY;
      if (ground) uy = inp.yaw;
      up = clamp(up, -1, 1); ur = clamp(ur, -1, 1); uy = clamp(uy, -1, 1);
    }
    this.out.pitch = up; this.out.roll = ur; this.out.yaw = uy;
    fm.cmd.pitch = up; fm.cmd.roll = ur; fm.cmd.yaw = uy;
    fm.ctl.yawInput = inp.yaw;
    this.applySurfaces(dt);
  }

  applySurfaces(dt) {
    const fm = this.fm, ctl = fm.ctl;
    const rate = (this.cfg.type === 'fbw' ? 90 : 70) * DEG * dt;
    const flaps = ctl.flaps;
    // ground spoilers for airliner when on ground & throttle idle
    const lift = (fm.out.wow && ctl.throttle < 0.1 && fm.out.tas > 15) ? 1 : 0;
    const spoiler = Math.max(ctl.airbrake, lift);
    for (const it of this.items) {
      const o = it.obj, mx = o.max;
      let tgt = 0;
      if (it.kind === 'spoiler') tgt = spoiler * mx;
      else {
        tgt = (this.out.pitch * it.wPitch + this.out.roll * it.wRoll + this.out.yaw * it.wYaw) * mx + it.wFlap * flaps * mx * (it.kind === 'flaperon' ? 0.75 : 1);
        tgt = clamp(tgt, -mx, mx);
      }
      o.defl += clamp(tgt - o.defl, -rate, rate);
    }
  }
}
