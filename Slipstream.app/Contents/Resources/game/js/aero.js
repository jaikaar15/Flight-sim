'use strict';
// ---------------------------------------------------------------------------
// Flight dynamics: 6-DOF rigid body + per-surface aerodynamics.
//  * Every wing/tail panel is a lifting element with its own local airflow:
//      freestream + rotation (w x r) + wind/gusts + slipstream + induced flow
//  * Each panel sheds a horseshoe vortex; Biot-Savart induced velocities from
//    other lifting groups (wing -> tail downwash, canard -> wing, ...) feed
//    back into local angle of attack. Control surfaces change panel camber
//    (Glauert flap theory) -> they change circulation -> they move air.
//  * Actuator-disk propeller model (momentum theory) with slipstream + swirl,
//    torque, gyroscopic precession and P-factor.
//  * ISA atmosphere, Mach effects (DATCOM lift slope, wave drag, AC shift).
// ---------------------------------------------------------------------------
const Atmos = {
  at(h, out) {
    h = clamp(h, -500, 40000);
    let T, p;
    if (h < 11000) { T = 288.15 - 0.0065 * h; p = 101325 * Math.pow(T / 288.15, 5.25588); }
    else { T = 216.65; p = 22632 * Math.exp(-(h - 11000) / 6341.62); }
    out.T = T; out.p = p; out.rho = p / (287.05 * T); out.a = Math.sqrt(401.87 * T); out.sigma = out.rho / 1.225;
    return out;
  },
};

const _t1 = new V3(), _t2 = new V3(), _t3 = new V3(), _t4 = new V3(), _t5 = new V3(), _t6 = new V3();

// Biot-Savart: induced velocity at X from straight vortex filament P1->P2 with circulation G (core radius rc)
function bsSeg(X, P1x, P1y, P1z, P2x, P2y, P2z, G, rc, out) {
  const r1x = X.x - P1x, r1y = X.y - P1y, r1z = X.z - P1z, r2x = X.x - P2x, r2y = X.y - P2y, r2z = X.z - P2z;
  const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
  const r0x = P2x - P1x, r0y = P2y - P1y, r0z = P2z - P1z;
  const r0l2 = r0x * r0x + r0y * r0y + r0z * r0z;
  const c2 = cx * cx + cy * cy + cz * cz + rc * rc * r0l2;
  if (c2 < 1e-9) return;
  const l1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z) + 1e-9, l2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z) + 1e-9;
  const k = G / (4 * Math.PI * c2) * (r0x * (r1x / l1 - r2x / l2) + r0y * (r1y / l1 - r2y / l2) + r0z * (r1z / l1 - r2z / l2));
  out.x += k * cx; out.y += k * cy; out.z += k * cz;
}

class FlightModel {
  constructor(spec, geo) {
    this.spec = spec; this.geo = geo;
    this.mass = spec.mass;
    this.I = new V3(spec.inertia[0], spec.inertia[1], spec.inertia[2]);
    this.pos = new V3(); this.vel = new V3(); this.q = new Quat(); this.w = new V3();
    this.atm = { T: 288, p: 101325, rho: 1.225, a: 340, sigma: 1 };
    this.wind = new V3();       // world wind
    this.gustScale = 0;
    this.fbody = new V3(); this.mbody = new V3();
    // controls (actual actuator positions)
    this.ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, flapsTarget: 0, gear: 1, gearTarget: 1, brake: 0, airbrake: 0, hook: 0, hookTarget: 0, spoiler: 0, tvc: 0, trim: 0 };
    this.cmd = { pitch: 0, roll: 0, yaw: 0 }; // surface commands -1..1 from FCS
    this.eng = { n: 0.2, ab: 0, thrust: 0, rpm: 0, vi: 0, power: 0, running: spec.engine.type !== 'none', propAng: 0, fuelFlow: 0 };
    this.buildSegments();
    this.buildGear();
    this.buildBody();
    this.contacts = geo.contacts.map(c => new V3(c[0], c[1], c[2]));
    this.out = { alpha: 0, beta: 0, tas: 0, ias: 0, mach: 0, G: 1, Gy: 0, aoaStall: false, onGround: false, vs: 0, agl: 0, qbar: 0, stallWarn: 0, wow: false };
    this.groundInfo = { h: 0, type: 8, water: false, carrier: false };
    this.crashed = false; this.crashReason = '';
    this.touchdown = null;  // landing evaluation
    this.hookEngaged = false; this.catapult = null;
    this.damage = 0;  // 0..1 aero degradation
    this.engineDamage = 0;
    this.t = 0;
  }

  // ---------- aerodynamic panels ----------
  buildSegments() {
    const spec = this.spec, geo = this.geo;
    this.segs = [];
    let Sref = 0;
    for (const sf of spec.surfaces) {
      const sides = sf.mirror ? [1, -1] : [1];
      const segs = sf.kind === 'body' ? [{ e0: 0, e1: 1, controls: [] }] : surfaceSegments(sf);
      // surface area and aspect ratio
      let Ssurf = 0;
      for (const s of segs) { const F = surfaceFrame(sf, (s.e0 + s.e1) / 2, 1); Ssurf += F.chord * (s.e1 - s.e0) * sf.span; }
      Ssurf *= sides.length;
      if (sf.kind === 'body') Ssurf = sf.area;
      let AR;
      const b = sf.span * sides.length + (sf.kind === 'wing' || sf.kind === 'htail' || sf.kind === 'canard' ? sf.root[0] * 2 : 0);
      if (sf.kind === 'vtail') AR = 1.55 * (sf.span * sf.span) / (Ssurf / sides.length);
      else if (sf.kind === 'body') AR = 0.8;
      else AR = b * b / (Ssurf + (sf.kind === 'wing' ? sf.root[0] * 2 * sf.rc * 0.8 : 0));
      if (sf.kind === 'lerx') AR = 1.2;
      if (sf.kind === 'wing') { this.wingSpan = b; this.wingArea = Ssurf + sf.root[0] * 2 * sf.rc * 0.8; this.wingAR = AR; this.wingMAC = (sf.rc + sf.tc) / 2; }
      const tanSw = Math.tan(Math.max(0, (sf.sweep || 0) - 6) * DEG);
      const camber = sf.camber || 0;
      const alpha0 = -105 * camber * DEG;
      const stall = (sf.stall || (sf.kind === 'vtail' ? 22 : sf.kind === 'htail' ? 18 : 15)) * DEG;
      for (const side of sides) {
        segs.forEach((sg, si) => {
          const em = (sg.e0 + sg.e1) / 2;
          const F = surfaceFrame(sf, em, side);
          const width = (sg.e1 - sg.e0) * sf.span;
          let area = F.chord * width, chord = F.chord;
          let pos, n, c;
          if (sf.kind === 'body') {
            area = sf.area; chord = sf.rc;
            pos = new V3(0, sf.root[1], -(sf.root[2] - chord * 0.25));
            n = new V3(0, 1, 0); c = new V3(0, 0, -1);
          } else {
            pos = new V3(F.le[0] + F.cd[0] * chord * 0.25, F.le[1] + F.cd[1] * chord * 0.25, F.le[2] + F.cd[2] * chord * 0.25);
            n = new V3(F.n[0], F.n[1], F.n[2]);
            c = new V3(-F.cd[0], -F.cd[1], -F.cd[2]);
          }
          const sp = new V3().crossVecs(c, n).normalize();
          // control mapping to mesh parts
          const ctls = sg.controls.map(cc => {
            const thf = Math.acos(clamp(2 * cc.cf - 1, -1, 1));
            const tau = 1 - (thf - Math.sin(thf)) / Math.PI;
            const cm = -0.5 * Math.sin(thf) * (1 - Math.cos(thf));
            const part = geo.parts.findIndex(p => p.kind === 'control' && p.surf === sf.id && p.side === side && p.seg === si && p.ctl === cc.kind);
            return { kind: cc.kind, cf: cc.cf, max: cc.max * DEG, tau, cm, part, defl: 0 };
          });
          let am = null;
          if (sf.allMoving) {
            const part = geo.parts.findIndex(p => p.kind === 'surface' && p.surf === sf.id && p.side === side);
            am = { kind: sf.kind === 'canard' ? 'canard' : 'stab', max: sf.allMoving.max * DEG, part, defl: 0 };
          }
          const segPart = sf.allMoving ? (am ? am.part : 0) : geo.parts.findIndex(p => p.kind === 'segment' && p.surf === sf.id && p.side === side && p.seg === si);
          const group = (sf.kind === 'wing' || sf.kind === 'lerx' || sf.kind === 'body') ? 0 : sf.kind === 'htail' ? 1 : sf.kind === 'vtail' ? 2 : 3;
          this.segs.push({
            sf, kind: sf.kind, side, pos, n, c, sp, area, chord, width: sf.kind === 'body' ? 1.5 : width, AR, tanSw, alpha0, stall,
            cd0: 0.0055 + (sf.thick || 0.1) * 0.025, cm0: -2.5 * camber, ctls, am, part: segPart, group,
            slats: !!sf.slats, gamma: 0, vind: new V3(), vindRaw: new V3(), cl: 0, cd: 0, alpha: 0, stalled: false, force: new V3(), q: 0,
            A: new V3(), B: new V3(), wake: new V3(), prop: 0,
          });
        });
      }
      if (sf.kind !== 'htail' && sf.kind !== 'vtail' && sf.kind !== 'canard') Sref += Ssurf;
    }
    this.Sref = this.wingArea || Sref;
    this.mainWingSegs = this.segs.filter(s => s.kind === 'wing');
    let sc = 0; for (const s of this.segs) if (s.kind !== 'body') sc += s.cd0 * s.area;
    this.cd0x = Math.max(0.002, spec.cd0 - sc / this.Sref);
  }

  buildBody() {
    // fuselage cross-flow stations + volume (Munk)
    const f = this.spec.fuselage;
    let vol = 0, Aside = 0, Atop = 0, sMoment = 0;
    for (let i = 0; i < f.length - 1; i++) {
      const a = f[i], b = f[i + 1], ds = a[0] - b[0];
      const hw = (a[1] + b[1]) / 2, hh = (a[2] + b[2]) / 2;
      vol += Math.PI * hw * hh * ds; Aside += 2 * hh * ds; Atop += 2 * hw * ds;
      sMoment += 2 * hh * ds * (a[0] + b[0]) / 2;
    }
    const sMid = sMoment / Aside;
    const sNose = f[0][0], sTail = f[f.length - 1][0];
    this.body = {
      vol, stations: [
        { pos: new V3(0, 0, -(sNose + sMid) / 2), side: Aside * 0.4, top: Atop * 0.4 },
        { pos: new V3(0, 0, -sMid), side: Aside * 0.3, top: Atop * 0.3 },
        { pos: new V3(0, 0, -(sMid + sTail) / 2), side: Aside * 0.3, top: Atop * 0.3 },
      ],
    };
    // prop disk
    const E = this.spec.engine;
    if (E.type === 'prop') {
      this.prop = { pos: new V3(E.pos[0], E.pos[1], -E.pos[2]), R: E.dia / 2, A: Math.PI * E.dia * E.dia / 4, sense: E.sense || 1, I: E.blades * 0.33 * (E.dia * E.dia * 2.2) * 0.6 };
    }
    if (E.type === 'jet') {
      let x = 0, y = 0, z = 0; E.nozzles.forEach(nz => { x += nz[0]; y += nz[1]; z += -nz[2]; });
      this.nozzle = new V3(x / E.nozzles.length, y / E.nozzles.length, z / E.nozzles.length);
    }
  }

  buildGear() {
    this.gear = this.spec.gear.legs.map((L, i) => ({
      p: new V3(L.p[0], L.p[1], -L.p[2]), len: L.len, r: L.r, k: L.k, c: L.c, steer: !!L.steer, brake: !!L.brake,
      x: 0, contact: false, part: this.geo.gearParts[i], wc: new V3(), load: 0,
    }));
    const legs = this.gear;
    this.gearRetract = !!this.spec.gear.retract;
    // hook point (behind tail)
    const f = this.spec.fuselage, lf = f[f.length - 1];
    this.hookPt = new V3(0, lf[3] - lf[2] - 1.2, -(lf[0] + 0.2));
  }

  // static margin (fraction of MAC) measured from the aero model
  measureSM(V) {
    const F = new V3(), M = new V3();
    this.w.set(0, 0, 0); this.out.agl = 1000; Atmos.at(0, this.atm);
    const ev = (a) => {
      const vb = new V3(0, -V * Math.sin(a), -V * Math.cos(a));
      for (const s of this.segs) { s.vind.set(0, 0, 0); s.gamma = 0; }
      for (let i = 0; i < 4; i++) { F.set(0, 0, 0); M.set(0, 0, 0); this.aeroPanels(1 / 120, vb, V / 340, 1.225, F, M, null); for (const s of this.segs) s.vind.copy(s.vindRaw); }
      this.aeroBody(vb, V, V / 340, 0.5 * 1.225 * V * V, 1.225, F, M);
      return [F.y, M.x];
    };
    const a = ev(2 * DEG), b = ev(5 * DEG);
    for (const s of this.segs) { s.vind.set(0, 0, 0); s.gamma = 0; }
    return -(b[1] - a[1]) / (b[0] - a[0]) / this.wingMAC;
  }

  // ---------- state helpers ----------
  setState(pos, hdgDeg, pitchDeg, speed, onGround) {
    this.pos.copy(pos);
    this.q.setEuler(hdgDeg * DEG, pitchDeg * DEG, 0);
    const f = new V3(0, 0, -1).applyQuat(this.q);
    this.vel.copy(f).scale(speed);
    this.w.set(0, 0, 0);
    for (const s of this.segs) { s.vind.set(0, 0, 0); s.gamma = 0; }
    this.eng.n = onGround ? 0.25 : 0.85; this.eng.ab = 0;
    this.ctl.gear = this.ctl.gearTarget = onGround || !this.gearRetract ? 1 : 0;
    this.crashed = false; this.hookEngaged = false; this.catapult = null; this.touchdown = null;
    for (const g of this.gear) g.x = 0;
    this.eng.vi = 0;
  }
  fwd(out) { return out.set(0, 0, -1).applyQuat(this.q); }
  up(out) { return out.set(0, 1, 0).applyQuat(this.q); }
  right(out) { return out.set(1, 0, 0).applyQuat(this.q); }
  euler() {
    const f = this.fwd(_t1), u = this.up(_t2), r = this.right(_t3);
    const pitch = Math.asin(clamp(f.y, -1, 1));
    const hdg = Math.atan2(f.x, -f.z);
    const roll = Math.atan2(-r.y, u.y);
    return { hdg: (hdg * RAD + 360) % 360, pitch: pitch * RAD, roll: roll * RAD };
  }

  // ---------- main step ----------
  step(dt, world) {
    if (this.crashed) return;
    this.t += dt;
    const spec = this.spec, ctl = this.ctl;
    Atmos.at(this.pos.y, this.atm);
    const rho = this.atm.rho;
    // actuators: flaps, gear, hook, airbrake
    const flapRate = 0.25 * dt;
    ctl.flaps += clamp(ctl.flapsTarget - ctl.flaps, -flapRate, flapRate);
    if (this.gearRetract) { const gr = dt / 4.5; ctl.gear += clamp(ctl.gearTarget - ctl.gear, -gr, gr); } else ctl.gear = 1;
    ctl.hook += clamp(ctl.hookTarget - ctl.hook, -dt, dt);
    // ---- relative air velocity in body frame ----
    const vAirW = _t1.copy(this.vel).sub(this.wind);
    // turbulence (spatially varying, applied per panel below)
    const vb = _t2.copy(vAirW).applyQuatInv(this.q);     // body velocity relative to air
    const V = vb.len();
    const tas = V;
    const mach = V / this.atm.a;
    const qbar = 0.5 * rho * V * V;
    // outputs that depend on vb (computed now: vb's scratch vector is reused later)
    this.out.alpha = Math.atan2(-vb.y, -vb.z) * RAD;
    this.out.beta = Math.atan2(vb.x, -vb.z) * RAD;
    const F = this.fbody.set(0, 0, 0), M = this.mbody.set(0, 0, 0);
    // ---- engine ----
    this.engine(dt, V, mach, rho, F, M, vb);
    // ---- aero panels ----
    this.aeroPanels(dt, vb, mach, rho, F, M, world);
    // ---- fuselage / parasite ----
    this.aeroBody(vb, V, mach, qbar, rho, F, M);
    // ---- ground ----
    this.groundForces(dt, world, F, M);
    // ---- integrate ----
    const m = this.mass;
    // non-gravitational acceleration (load factor) in body frame
    this.out.G = lerp(this.out.G, F.y / (m * G0), 0.25);
    this.out.Gx = F.x / (m * G0);
    const Fw = _t3.copy(F).applyQuat(this.q);
    this.vel.x += Fw.x / m * dt; this.vel.y += (Fw.y / m - G0) * dt; this.vel.z += Fw.z / m * dt;
    this.pos.addScaled(this.vel, dt);
    // rotational: I w' = M - w x (I w + H)
    const w = this.w, I = this.I;
    let Hx = I.x * w.x, Hy = I.y * w.y, Hz = I.z * w.z;
    if (this.prop) { const Hp = this.prop.I * (this.eng.rpm * 0.10472) * this.prop.sense; Hz += -Hp; } // prop spins about -z (fwd) for sense +1
    const gx = w.y * Hz - w.z * Hy, gy = w.z * Hx - w.x * Hz, gz = w.x * Hy - w.y * Hx;
    w.x += (M.x - gx) / I.x * dt; w.y += (M.y - gy) / I.y * dt; w.z += (M.z - gz) / I.z * dt;
    // sanity clamp
    const wl = w.len(); if (wl > 12) w.scale(12 / wl);
    this.q.integrateBody(w, dt);
    // outputs
    const o = this.out;
    o.tas = tas; o.mach = mach; o.qbar = qbar;
    o.ias = tas * Math.sqrt(this.atm.sigma);
    o.vs = this.vel.y;
  }

  engine(dt, V, mach, rho, F, M, vb) {
    const E = this.spec.engine, eng = this.eng, ctl = this.ctl;
    const sigma = rho / 1.225;
    const thr = eng.running ? ctl.throttle : 0;
    const health = 1 - this.engineDamage * 0.7;
    if (E.type === 'jet') {
      const abReq = E.ab > 0 && thr > 0.96;
      const nT = eng.running ? 0.22 + 0.78 * Math.min(thr / 0.96, 1) : 0;
      const rate = (nT > eng.n ? 1 / E.spool : 1.6 / E.spool) * (0.4 + eng.n);
      eng.n += clamp(nT - eng.n, -rate * dt, rate * dt);
      eng.ab += clamp((abReq && eng.n > 0.9 ? 1 : 0) - eng.ab, -dt * 3, dt * 2.2);
      const nn = clamp((eng.n - 0.22) / 0.78, 0, 1);
      let dry;
      if (E.bypass) dry = E.thrust * (0.05 + 0.95 * Math.pow(nn, 1.6)) * Math.pow(sigma, 0.8) * (1 - 0.42 * mach + 0.14 * mach * mach);
      else dry = E.thrust * (0.05 + 0.95 * Math.pow(nn, 1.6)) * Math.pow(sigma, 0.72) * (1 + 0.1 * mach);
      let wet = 0;
      if (E.ab > 0) wet = (E.ab * Math.pow(sigma, 0.75) * (1 + 0.36 * mach) - E.thrust * Math.pow(sigma, 0.72) * (1 + 0.1 * mach)) * eng.ab;
      const T = Math.max(0, dry + wet) * health;
      eng.thrust = T; eng.rpm = eng.n * 100;
      // thrust vectoring
      let tv = 0;
      if (E.tvc) { const tgt = this.cmd.pitch * E.tvc * DEG; ctl.tvc += clamp(tgt - ctl.tvc, -1.2 * dt, 1.2 * dt); tv = ctl.tvc; }
      const fx = 0, fy = -T * Math.sin(tv), fz = -T * Math.cos(tv);
      F.x += fx; F.y += fy; F.z += fz;
      const r = this.nozzle;
      M.x += r.y * fz - r.z * fy; M.y += r.z * fx - r.x * fz; M.z += r.x * fy - r.y * fx;
    } else if (E.type === 'prop') {
      const P = this.prop;
      const crit = E.alt || 0;
      const alt = this.pos.y;
      let pf = alt < crit ? 1 : Math.pow(sigma / Atmos.at(crit, {}).sigma, 1.1);
      if (crit === 0) pf = Math.pow(sigma, 1.1);
      const power = E.power * thr * pf * health;
      eng.power = power;
      // axial inflow through disk
      const Vax = Math.max(0, -vb.z);
      const eta = 0.52 + 0.32 * smooth(0, 45, Vax);
      const Pe = power * eta;
      // momentum theory: Pe = 2 rho A vi (V+vi)^2  -> Newton.
      // f(vi) is convex and increasing, so starting from an upper bound Newton converges from above
      // without overshoot. (Starting low, e.g. at idle, it used to overshoot to absurd thrust spikes.)
      const k2 = Pe / (2 * rho * P.A);
      const viMax = Math.min(Math.cbrt(k2), Vax > 0.5 ? k2 / (Vax * Vax) : Infinity);
      let vi = viMax;
      for (let k = 0; k < 6; k++) {
        const g = 2 * rho * P.A * vi * (Vax + vi) * (Vax + vi) - Pe;
        const dg = 2 * rho * P.A * ((Vax + vi) * (Vax + vi) + 2 * vi * (Vax + vi));
        if (dg <= 0) break;
        vi = clamp(vi - g / dg, 0, viMax);
      }
      eng.vi = vi;
      const T = 2 * rho * P.A * vi * (Vax + vi);
      eng.thrust = T;
      const rpmT = eng.running ? E.rpm * (0.35 + 0.65 * Math.sqrt(thr)) : E.rpm * 0.02 * Math.min(V / 20, 1) * 3;
      eng.rpm += (rpmT - eng.rpm) * Math.min(1, dt * 2.5);
      eng.propAng += eng.rpm * 0.10472 * dt;
      // P-factor: thrust center shifts with AoA / sideslip
      const aRad = Math.atan2(-vb.y, Math.max(1, -vb.z)), bRad = Math.atan2(vb.x, Math.max(1, -vb.z));
      const ox = P.R * 0.28 * Math.sin(aRad) * P.sense, oy = -P.R * 0.28 * Math.sin(bRad) * P.sense;
      const rx = P.pos.x + ox, ry = P.pos.y + oy, rz = P.pos.z;
      F.z -= T;
      M.x += ry * -T; M.y += -rx * -T;
      // torque reaction (roll opposite to prop rotation)
      const omega = Math.max(eng.rpm * 0.10472, 10);
      const Q = power / omega;
      M.z += Q * P.sense * 0.9;
    }
  }

  aeroPanels(dt, vb, mach, rho, F, M, world) {
    const segs = this.segs, w = this.w;
    const a = this.atm.a;
    const ctl = this.ctl;
    // ground effect (McCormick): phi = (16h/b)^2 / (1 + (16h/b)^2) scales the wing's induced drag
    // and raises its effective aspect ratio (more lift per alpha near the ground)
    const agl = this.out.agl;
    const ge = this.wingSpan ? (() => { const r = 16 * Math.max(agl, 0.3) / this.wingSpan; return (r * r) / (1 + r * r); })() : 1;
    // ground plane in the body frame (n . p = d0) for mirror-image vortices: the ground blocks
    // the wing's downwash, so the tail sees less of it -> nose-down trim change entering the flare
    const inGE = this.wingSpan > 0 && agl < this.wingSpan * 1.5;
    let gnx = 0, gny = 1, gnz = 0;
    if (inGE) { const g = _t3.set(0, 1, 0).applyQuatInv(this.q); gnx = g.x; gny = g.y; gnz = g.z; }
    const gd0 = -agl;
    // freestream direction in body (for wakes)
    const Vl = vb.len();
    const wx = Vl > 1 ? -vb.x / Vl : 0, wy = Vl > 1 ? -vb.y / Vl : 0, wz = Vl > 1 ? -vb.z / Vl : 1;
    // 1) induced velocities from other groups' horseshoe vortices (previous step circulation)
    const L = 70;
    for (const s of segs) {
      const v = s.vindRaw.set(0, 0, 0);
      if (s.kind === 'body') continue;
      for (const o of segs) {
        if (o.group === s.group || o.kind === 'body' || Math.abs(o.gamma) < 1e-4) continue;
        const G = o.gamma, rc = o.chord * 0.35, A = o.A, B = o.B;
        bsSeg(s.pos, A.x + wx * L, A.y + wy * L, A.z + wz * L, A.x, A.y, A.z, G, rc, v);
        bsSeg(s.pos, A.x, A.y, A.z, B.x, B.y, B.z, G, rc, v);
        bsSeg(s.pos, B.x, B.y, B.z, B.x + wx * L, B.y + wy * L, B.z + wz * L, G, rc, v);
        if (inGE) {
          // image horseshoe reflected through the ground, opposite circulation
          const ka = 2 * (gnx * A.x + gny * A.y + gnz * A.z - gd0), kb = 2 * (gnx * B.x + gny * B.y + gnz * B.z - gd0);
          const ax = A.x - ka * gnx, ay = A.y - ka * gny, az = A.z - ka * gnz;
          const bx = B.x - kb * gnx, by = B.y - kb * gny, bz = B.z - kb * gnz;
          const kw = 2 * (gnx * wx + gny * wy + gnz * wz);
          const mx = (wx - kw * gnx) * L, my = (wy - kw * gny) * L, mz = (wz - kw * gnz) * L;
          bsSeg(s.pos, ax + mx, ay + my, az + mz, ax, ay, az, -G, rc, v);
          bsSeg(s.pos, ax, ay, az, bx, by, bz, -G, rc, v);
          bsSeg(s.pos, bx, by, bz, bx + mx, by + my, bz + mz, -G, rc, v);
        }
      }
      // downwash lag (convective delay)
      const k = 1 - Math.exp(-dt / 0.045);
      s.vind.lerp(v, k);
    }
    // 2) panel loads
    const turb = this.gustScale;
    const P = this.prop;
    let stallCount = 0, mainStall = 0;
    const t = this.t;
    for (const s of segs) {
      const r = s.pos;
      // velocity of panel through air: vb + w x r
      let vx = vb.x + (w.y * r.z - w.z * r.y), vy = vb.y + (w.z * r.x - w.x * r.z), vz = vb.z + (w.x * r.y - w.y * r.x);
      // airflow f = -v + induced
      let fx = -vx + s.vind.x, fy = -vy + s.vind.y, fz = -vz + s.vind.z;
      // turbulence: spatially coherent gusts in body frame
      if (turb > 0) {
        const px = this.pos.x * 0.02 + r.x * 0.02, pz = this.pos.z * 0.02 + r.z * 0.02;
        fy += Noise.n3(px, pz, t * 0.6) * turb * 1.6;
        fx += Noise.n3(px + 40, pz, t * 0.5) * turb;
        fz += Noise.n3(px, pz + 70, t * 0.5) * turb * 0.6;
      }
      // propeller slipstream
      s.prop = 0;
      if (P && this.eng.vi > 0.05) {
        const dz = r.z - P.pos.z;
        if (dz > -0.3) {
          const dx = r.x - P.pos.x, dy = r.y - P.pos.y, rad = Math.hypot(dx, dy);
          const Rs = P.R * (0.78 + 0.22 * Math.exp(-dz / P.R));
          const imm = clamp((Rs - (rad - s.width * 0.5)) / Math.max(s.width, 0.3), 0, 1) * (s.kind === 'vtail' ? clamp((Rs - Math.max(0, Math.abs(dy) - s.width * 0.5)) / s.width + 0.3, 0, 1) : 1);
          if (imm > 0) {
            const vi = this.eng.vi, va = vi * (1 + dz / Math.sqrt(dz * dz + P.R * P.R));
            fz += va * imm;
            // swirl: tangential = sense * (fwdAxis x rhat) * vs
            const vs = vi * 0.55 * imm;
            if (rad > 0.05) { const rxh = dx / rad, ryh = dy / rad; fx += P.sense * ryh * vs; fy += -P.sense * rxh * vs; }
            else if (s.kind === 'vtail') fx += P.sense * vs;
            s.prop = imm;
          }
        }
      }
      // project onto n-c plane (remove spanwise)
      const n = s.n, c = s.c, sp = s.sp;
      const fs = fx * sp.x + fy * sp.y + fz * sp.z;
      const px = fx - sp.x * fs, py = fy - sp.y * fs, pz = fz - sp.z * fs;
      const vp2 = px * px + py * py + pz * pz;
      const vp = Math.sqrt(vp2);
      if (vp < 0.5) { s.gamma = 0; s.cl = 0; s.force.set(0, 0, 0); continue; }
      const fn = px * n.x + py * n.y + pz * n.z, fc = -(px * c.x + py * c.y + pz * c.z);
      const alpha = Math.atan2(fn, fc);
      const q = 0.5 * rho * vp2;
      const lm = vp / a;
      // compressible lift slope (DATCOM / Helmbold)
      const AR = s.AR, b2 = Math.max(1 - Math.min(lm, 0.95) * Math.min(lm, 0.95), 0.0975);
      const ARl = s.group === 0 && s.kind === 'wing' ? Math.min(AR / Math.max(ge, 0.25), AR * 3) : AR;
      let cla = 2 * Math.PI * ARl / (2 + Math.sqrt(4 + ARl * ARl * b2 * (1 + s.tanSw * s.tanSw / b2) / 0.9));
      if (lm > 1.05) { const sup = 4 / Math.sqrt(lm * lm - 1); cla = Math.min(cla, lerp(cla, sup, smooth(1.05, 1.3, lm))); }
      if (s.kind === 'body') cla = 1.6;
      if (s.kind === 'lerx') cla = 1.4;
      // control surface deflections
      let dEff = 0, dcm = 0, dcd = 0, spoil = 0;
      for (const cc of s.ctls) {
        const d = cc.defl;
        if (cc.kind === 'spoiler') { spoil += Math.abs(d) / cc.max; continue; }
        const eff = 1 - 0.45 * smooth(12 * DEG, 40 * DEG, Math.abs(d));
        dEff += cc.tau * d * eff;
        dcm += cc.cm * d * eff;
        dcd += 1.1 * cc.cf * d * d;
      }
      let geomAlpha = alpha;
      if (s.am) geomAlpha += s.am.defl;
      const ae = geomAlpha - s.alpha0 + dEff;
      // stall angles in effective space (slats + flaps raise CLmax)
      let st = s.stall - s.alpha0 + dEff * 0.35;
      if (s.slats) st += 6 * DEG * smooth(4 * DEG, 10 * DEG, alpha);
      st *= (1 - this.damage * 0.25 * (s.kind === 'wing' ? 1 : 0));
      const stNeg = -(s.stall * 0.85 + s.alpha0) + dEff * 0.2;
      let wst;
      if (ae >= 0) wst = smooth(st, st + 5 * DEG, ae); else wst = smooth(-stNeg, -stNeg + 5 * DEG, -ae);
      // attached flow
      let clLin = cla * ae;
      // flat plate (post stall)
      const sa = Math.sin(ae), ca = Math.cos(ae);
      const cdMax = s.kind === 'body' || s.kind === 'lerx' ? 1.0 : 1.25;
      const clFp = cdMax * sa * ca * 1.0;
      let cl = clLin * (1 - wst) + clFp * wst;
      cl *= 1 - spoil * 0.75;
      const e = s.kind === 'wing' ? 0.82 : 0.75;
      const ind = cl * cl / (Math.PI * e * AR) * (s.group === 0 ? ge : 1);
      let cd = (s.cd0 + ind + dcd) * (1 - wst) + (cdMax * sa * sa + s.cd0) * wst + spoil * 0.08;
      let cm = (s.cm0 + dcm) * (1 - wst) - 0.12 * wst * Math.sign(ae);
      // AC shift: supersonic & post-stall
      // supersonic aerodynamic-centre shift (~quarter → ~35% chord) and post-stall shift
      const xcp = 0.1 * smooth(0.92, 1.4, lm) + 0.2 * wst;
      // ---- forces ----
      const ix = 1 / vp;
      const fhx = px * ix, fhy = py * ix, fhz = pz * ix;
      // lift dir: n - (n.fh) fh
      const nd = n.x * fhx + n.y * fhy + n.z * fhz;
      let lx = n.x - nd * fhx, ly = n.y - nd * fhy, lz = n.z - nd * fhz;
      const ll = Math.hypot(lx, ly, lz) || 1; lx /= ll; ly /= ll; lz /= ll;
      const qS = q * s.area;
      const Fx = qS * (cl * lx + cd * fhx), Fy = qS * (cl * ly + cd * fhy), Fz = qS * (cl * lz + cd * fhz);
      // application point (moves aft along chord)
      const ax = r.x - c.x * xcp * s.chord, ay = r.y - c.y * xcp * s.chord, az = r.z - c.z * xcp * s.chord;
      F.x += Fx; F.y += Fy; F.z += Fz;
      M.x += ay * Fz - az * Fy; M.y += az * Fx - ax * Fz; M.z += ax * Fy - ay * Fx;
      const mm = qS * s.chord * cm;
      M.x += sp.x * mm; M.y += sp.y * mm; M.z += sp.z * mm;
      // circulation for vortex system: Gamma = 0.5 V c Cl
      s.gamma = 0.5 * vp * s.chord * cl;
      const hw = s.width * 0.5;
      s.A.set(r.x - sp.x * hw, r.y - sp.y * hw, r.z - sp.z * hw);
      s.B.set(r.x + sp.x * hw, r.y + sp.y * hw, r.z + sp.z * hw);
      s.cl = cl; s.cd = cd; s.alpha = alpha; s.q = q; s.stalled = wst > 0.5; s.force.set(Fx, Fy, Fz);
      if (s.kind === 'wing') { if (wst > 0.5) mainStall++; stallCount++; }
    }
    this.out.stallFrac = stallCount ? mainStall / stallCount : 0;
  }

  aeroBody(vb, V, mach, qbar, rho, F, M) {
    const spec = this.spec, ctl = this.ctl;
    if (V < 0.5) return;
    // parasite drag
    let cd = this.cd0x;
    if (spec.mcrit) {
      const mc = spec.mcrit; let fw = 0;
      if (mach > mc) fw = mach < 1.05 ? Math.pow((mach - mc) / (1.05 - mc), 2.5) : Math.max(0.55, 1 - (mach - 1.05) * 0.38);
      cd += spec.wave * fw;
    }
    cd += ctl.gear * (this.gearRetract ? 0.018 : 0) + ctl.airbrake * 0.06 + ctl.hook * 0.001;
    cd += this.damage * 0.03;
    const D = qbar * this.Sref * cd / V;   // F = -D * v (v/|v| folded into D)
    F.x -= vb.x * D; F.y -= vb.y * D; F.z -= vb.z * D;
    // fuselage cross-flow at stations (side force, damping)
    const w = this.w;
    for (const st of this.body.stations) {
      const r = st.pos;
      const vx = vb.x + (w.y * r.z - w.z * r.y), vy = vb.y + (w.z * r.x - w.x * r.z);
      const k = 0.5 * rho * 0.45;
      const fx = -k * st.side * vx * Math.abs(vx), fy = -k * st.top * vy * Math.abs(vy) * 0.6;
      F.x += fx; F.y += fy;
      M.x += r.y * 0 - r.z * fy; M.y += r.z * fx - r.x * 0; M.z += r.x * fy - r.y * fx;
    }
    // Munk moment (destabilizing)
    const al = Math.atan2(-vb.y, -vb.z), be = Math.atan2(vb.x, -vb.z);
    const km = qbar * this.body.vol * 0.55;
    M.x += km * Math.sin(2 * clamp(al, -0.8, 0.8));
    M.y += km * Math.sin(2 * clamp(be, -0.8, 0.8));
  }

  // ---------- landing gear & contacts ----------
  groundForces(dt, world, F, M) {
    const q = this.q, pos = this.pos, o = this.out;
    const gi = this.groundInfo;
    world.surfaceAt(pos.x, pos.z, gi);
    const gh = gi.h;
    o.agl = pos.y - gh;
    o.wow = false;
    if (o.agl > 40) { for (const g of this.gear) { g.contact = false; g.x = 0; } o.onGround = false; this.hookEngaged = false; return; }
    const C = world.carrier;
    const deckV = gi.carrier ? C.vel : null;
    const pW = _t3, vP = _t4, rB = _t5, tmp = _t6;
    const gearDown = this.ctl.gear > 0.98;
    let anyContact = false;
    const surf = { h: 0, type: 8, water: false, carrier: false };
    // [rolling resistance, lateral (cornering) friction, braking friction]
    const mu = (type) => type <= 1 || type === 4 || type === 5 ? [0.016, 0.58, 0.62] : type === 10 ? [0.02, 0.56, 0.6] : type === 3 || type === 6 ? [0.025, 0.48, 0.45] : type === 7 ? [0.045, 0.44, 0.4] : [0.065, 0.4, 0.35];
    for (const g of this.gear) {
      g.contact = false; g.load = 0;
      if (!gearDown) { g.x = 0; continue; }
      // wheel bottom at full extension (body)
      rB.set(g.p.x, g.p.y - g.len - g.r, g.p.z);
      pW.copy(rB).applyQuat(q).add(pos);
      world.surfaceAt(pW.x, pW.z, surf);
      if (surf.water) continue;
      const pen = surf.h - pW.y;
      if (pen <= 0) { g.x = Math.max(0, g.x - dt * 2); continue; }
      // point velocity
      tmp.crossVecs(this.w, rB).applyQuat(q);
      vP.copy(this.vel).add(tmp);
      if (surf.carrier) vP.sub(C.vel);
      const comp = Math.min(pen, g.len + 0.15);
      const sink = -vP.y;
      let Fn = g.k * comp + g.c * sink;
      if (pen > g.len) Fn += g.k * 8 * (pen - g.len);
      Fn = Math.max(0, Fn);
      g.x = comp; g.contact = true; g.load = Fn; anyContact = true;
      // touchdown evaluation
      if (!o.wow && !this._wasWow && sink > 0) {
        const lim = this.spec.id === 'skyliner' ? 4.5 : this.spec.id === 'condor' ? 3.5 : 7.5;
        if (sink > lim) { this.crash('Hard landing — gear collapsed'); return; }
        if (!this.touchdown) this.touchdown = { sink, t: this.t, x: pW.x, z: pW.z, carrier: surf.carrier };
      }
      o.wow = true;
      // tire frame
      let steer = 0;
      if (g.steer) { const v = this.vel.len(); steer = (this.ctl.yawInput || 0) * (g.p.z < 0 ? 1 : -0.7) * 35 * DEG * smooth(35, 8, v); }
      const fwd = tmp.set(Math.sin(steer), 0, -Math.cos(steer)).applyQuat(q);
      fwd.y = 0; fwd.normalize();
      const lat = _t2.set(-fwd.z, 0, fwd.x);
      const vLong = vP.x * fwd.x + vP.z * fwd.z, vLat = vP.x * lat.x + vP.z * lat.z;
      const [mr, ml, mb] = mu(surf.type);
      const brake = g.brake ? this.ctl.brake : 0;
      const fLong = -clamp(vLong / 0.4, -1, 1) * (mr + brake * mb) * Fn;
      const fLat = -clamp(vLat / 0.6, -1, 1) * ml * Fn;
      const Fw = _t1.set(fwd.x * fLong + lat.x * fLat, Fn, fwd.z * fLong + lat.z * fLat);
      // to body frame and apply at contact point
      Fw.applyQuatInv(q);
      F.add(Fw);
      M.x += rB.y * Fw.z - rB.z * Fw.y; M.y += rB.z * Fw.x - rB.x * Fw.z; M.z += rB.x * Fw.y - rB.y * Fw.x;
      // surface roughness bumps
      if (surf.type >= 2 && surf.type !== 4 && surf.type !== 5 && surf.type !== 10) { const sp = Math.abs(vLong); M.x += (Math.random() - 0.5) * Fn * 0.02 * Math.min(sp / 20, 1); }
    }
    this._wasWow = o.wow;
    o.onGround = anyContact;
    // airframe contacts (belly, tips, nose)
    for (const c of this.contacts) {
      pW.copy(c).applyQuat(q).add(pos);
      world.surfaceAt(pW.x, pW.z, surf);
      const pen = surf.h - pW.y;
      if (C.insideHull(pW.x, pW.y, pW.z) && !surf.carrier) { this.crash('Collided with the carrier'); return; }
      if (pen <= 0) continue;
      tmp.crossVecs(this.w, c).applyQuat(q);
      vP.copy(this.vel).add(tmp); if (surf.carrier) vP.sub(C.vel);
      const sp = vP.len();
      if (surf.water) { if (sp > 25 || pen > 1.5) { this.crash('Ditched in the water'); return; } }
      // glancing scrapes (tail strike on rotation, wingtip brushing the runway) damage the airframe;
      // digging in or hitting hard at speed destroys it
      if (-vP.y > 5 || pen > 2.5 || (sp > 75 && (pen > 0.4 || -vP.y > 2.5))) { this.crash(surf.water ? 'Ditched in the water' : 'Crashed into terrain'); return; }
      if (sp > 40) this.damage = Math.min(1, this.damage + dt * 0.12 * Math.min(sp / 75, 2));
      const Fn = Math.max(0, this.mass * 80 * pen + this.mass * 6 * -vP.y);
      const fl = Math.min(sp, 1) * 0.45 * Fn;
      const Fw = _t1.set(-vP.x / (sp || 1) * fl, Fn, -vP.z / (sp || 1) * fl);
      Fw.applyQuatInv(q); F.add(Fw);
      M.x += c.y * Fw.z - c.z * Fw.y; M.y += c.z * Fw.x - c.x * Fw.z; M.z += c.x * Fw.y - c.y * Fw.x;
      this.scraping = sp;
      o.onGround = true;
    }
    // ---- carrier: arresting wires + catapult ----
    if (gi.carrier || (this.catapult)) this.carrierOps(dt, world, F);
  }

  carrierOps(dt, world, F) {
    const C = world.carrier;
    const rel = _t4.copy(this.vel).sub(C.vel);
    const speed = rel.len();
    // catapult stroke
    if (this.catapult) {
      const cat = this.catapult;
      cat.t += dt;
      const fw = _t1.set(Math.sin(C.hdg), 0, -Math.cos(C.hdg));
      if (cat.state === 'hold') {
        // hold aircraft on the shuttle
        const [u, v] = C.toLocal(this.pos.x, this.pos.z);
        const ex = (cat.u - u), ev = (cat.v - v);
        const holdF = _t2.set(fw.x * ex - fw.z * ev, 0, fw.z * ex + fw.x * ev).scale(this.mass * 12);
        holdF.addScaled(rel, -this.mass * 3); holdF.y = 0;
        F.add(holdF.applyQuatInv(this.q));
        this.w.y *= 0.9;
      } else if (cat.state === 'launch') {
        const accel = cat.accel;
        const Fc = _t2.copy(fw).scale(this.mass * accel).applyQuatInv(this.q);
        F.add(Fc);
        const [u] = C.toLocal(this.pos.x, this.pos.z);
        if (u > cat.end || this.out.agl > 3) this.catapult = null;
      }
      return;
    }
    // arresting gear
    if (this.ctl.hook > 0.9 && this.out.wow && !this.hookEngaged) {
      const hp = _t2.copy(this.hookPt).applyQuat(this.q).add(this.pos);
      const [s, l] = C.angledCoords(hp.x, hp.z);
      if (Math.abs(l) < 14 && s > C.wires[0] - 6 && s < C.wires[3] + 8 && speed > 15) {
        this.hookEngaged = true; this.wireIdx = C.wires.reduce((best, w, i) => Math.abs(w - s) < Math.abs(C.wires[best] - s) ? i : best, 0);
        this.wireDecel = speed * speed / (2 * 95);
      }
    }
    if (this.hookEngaged) {
      if (speed > 0.6) {
        const d = _t2.copy(rel).scale(-this.mass * this.wireDecel / speed);
        d.y = 0; F.add(d.applyQuatInv(this.q));
      } else { this.arrested = true; }
    }
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true; this.crashReason = reason;
  }
}
