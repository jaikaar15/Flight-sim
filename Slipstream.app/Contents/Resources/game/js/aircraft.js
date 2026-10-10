'use strict';
// ---------------------------------------------------------------------------
// Aircraft: flight model + FCS + animated mesh parts + combat state.
// ---------------------------------------------------------------------------

// shift all airframe s-coordinates (gear stays relative to CG)
function shiftSpec(spec, d) {
  const S = JSON.parse(JSON.stringify(spec));
  S.fuselage = S.fuselage.map(f => [f[0] - d, f[1], f[2], f[3], f[4]]);
  (S.pods || []).forEach(p => p.pts = p.pts.map(f => [f[0] - d, f[1], f[2], f[3], f[4]]));
  if (S.canopy) { S.canopy.s0 -= d; S.canopy.s1 -= d; }
  S.surfaces.forEach(sf => sf.root[2] -= d);
  (S.beams || []).forEach(b => { b[2] -= d; b[5] -= d; });
  if (S.engine.type === 'prop') S.engine.pos[2] -= d;
  if (S.engine.nozzles) S.engine.nozzles = S.engine.nozzles.map(n => [n[0], n[1], n[2] - d, n[3]]);
  if (S.guns) S.guns.pts = S.guns.pts.map(p => [p[0], p[1], p[2] - d]);
  (S.hard || []).forEach(h => h.p[2] -= d);
  S.cockpit[2] -= d;
  return S;
}

const PREPARED = {};
function prepareSpec(spec) {
  if (PREPARED[spec.id]) return PREPARED[spec.id];
  const target = spec.sm === undefined ? 0.1 : spec.sm;
  let d = 0, sp = spec, sm = 0, mac = 1;
  for (let it = 0; it < 3; it++) {
    const geo = buildAircraft(sp); const fm = new FlightModel(sp, geo);
    sm = fm.measureSM(spec.vref * 0.85); mac = fm.wingMAC;
    if (Math.abs(sm - target) < 0.01) break;
    d += (target - sm) * mac;
    sp = shiftSpec(spec, d);
  }
  const geo = buildAircraft(sp);
  const entry = { spec: sp, geo, cgShift: d, sm };
  PREPARED[spec.id] = entry;
  return entry;
}

const _m4a = new Float32Array(16), _qa = new Quat();
function pivotRot(m, pivot, axis, ang) {
  _qa.setAxisAngle(axis[0], axis[1], axis[2], ang);
  M4.fromQuatPos(m, _qa, 0, 0, 0);
  const px = pivot[0], py = pivot[1], pz = pivot[2];
  m[12] = px - (m[0] * px + m[4] * py + m[8] * pz);
  m[13] = py - (m[1] * px + m[5] * py + m[9] * pz);
  m[14] = pz - (m[2] * px + m[6] * py + m[10] * pz);
  return m;
}

let AC_ID = 0;
class Aircraft {
  constructor(baseSpec, team, isPlayer, callsign) {
    const P = prepareSpec(baseSpec);
    this.uid = ++AC_ID;
    this.spec = P.spec; this.base = baseSpec; this.geo = P.geo;
    this.fm = new FlightModel(this.spec, this.geo);
    this.fcs = new FCS(this.fm);
    this.team = team; this.isPlayer = isPlayer; this.callsign = callsign || baseSpec.name;
    this.alive = true; this.hp = this.spec.hp; this.maxHp = this.spec.hp;
    this.input = { pitch: 0, roll: 0, yaw: 0 };
    this.assist = true;
    const W = this.spec.weapons || { ir: 0, radar: 0, flares: 0 };
    this.wpn = {
      ammo: this.spec.guns ? this.spec.guns.ammo : 0, ir: W.ir, radar: W.radar, flares: W.flares, chaff: W.flares,
      gunAcc: 0, barrel: 0, firing: false, sel: W.ir > 0 ? 'ir' : (W.radar > 0 ? 'radar' : 'gun'),
      lock: null, lockT: 0, lockState: 0, mslCool: 0, cmCool: 0, firedHard: new Set(),
    };
    this.partMats = new Float32Array(MAX_PARTS * 16);
    for (let i = 0; i < MAX_PARTS; i++) M4.identity(this.partMats.subarray(i * 16, i * 16 + 16));
    this.surfVals = new Float32Array(MAX_PARTS);
    this.partMap = [];
    this.buildPartMap();
    this.trails = [[], []]; this.trailT = 0;
    this.smoke = 0; this.fire = 0; this.deadT = 0; this.killer = null; this.lastHitBy = null; this.lastHitT = -99;
    // impact points in the airframe's own coordinates (xyz + radius) -> localized damage in the shader
    this.hits = new Float32Array(32); this.seed = Math.random(); this.hitPt = new V3(); this.airT = 0;
    this.kills = 0; this.deaths = 0;
    this.ai = null;
    this.visible = true;
    this.threat = null; // incoming missile
    this.rwr = 0;
  }

  buildPartMap() {
    const parts = this.geo.parts;
    for (let i = 0; i < parts.length; i++) this.partMap[i] = null;
    for (const s of this.fm.segs) {
      for (const c of s.ctls) if (c.part >= 0) {
        const p = parts[c.part];
        const a = p.axis, d = p.cdir, n = p.n;
        const cx = a[1] * d[2] - a[2] * d[1], cy = a[2] * d[0] - a[0] * d[2], cz = a[0] * d[1] - a[1] * d[0];
        const dot = cx * n[0] + cy * n[1] + cz * n[2];
        const sgn = c.kind === 'spoiler' ? Math.sign(dot) : -Math.sign(dot);
        this.partMap[c.part] = { obj: c, sgn, seg: s };
      }
      if (s.am && s.am.part >= 0) {
        const p = parts[s.am.part];
        const sgn = Math.sign(p.axis[0] * s.sp.x + p.axis[1] * s.sp.y + p.axis[2] * s.sp.z);
        this.partMap[s.am.part] = { obj: s.am, sgn, seg: s };
      }
      if (s.part > 0 && !this.partMap[s.part]) this.partMap[s.part] = { obj: null, seg: s };
    }
  }

  get pos() { return this.fm.pos; }
  get vel() { return this.fm.vel; }
  get q() { return this.fm.q; }

  spawn(pos, hdg, pitch, speed, onGround) {
    this.fm.setState(pos, hdg, pitch, speed, onGround);
    this.alive = true; this.hp = this.maxHp; this.fm.damage = 0; this.fm.engineDamage = 0;
    this.smoke = 0; this.fire = 0; this.deadT = 0; this.killer = null;
    this.hits.fill(0); this.seed = Math.random(); this.airT = 0;
    this.fm.ctl.throttle = onGround ? 0 : 0.85;
    this.fm.ctl.flapsTarget = this.fm.ctl.flaps = 0;
    this.trails = [[], []];
    const W = this.spec.weapons || { ir: 0, radar: 0, flares: 0 };
    Object.assign(this.wpn, { ammo: this.spec.guns ? this.spec.guns.ammo : 0, ir: W.ir, radar: W.radar, flares: W.flares, chaff: W.flares, lock: null, lockT: 0, lockState: 0, firedHard: new Set() });
    this.fcs.iq = this.fcs.ip = 0;
  }

  // physics substep
  step(dt, world, assist) {
    if (this.fm.crashed) return;
    if (!this.alive) {
      // uncontrolled wreck
      this.input.pitch = 0.6; this.input.roll = 1; this.input.yaw = 0.3;
      this.fm.ctl.throttle = 0;
    }
    this.fcs.update(dt, this.input, assist || !this.isPlayer);
    this.fm.step(dt, world);
    this.airT = this.fm.out.wow || this.fm.catapult ? 0 : this.airT + dt;
  }

  takeDamage(amount, attacker, world) {
    if (!this.alive) return false;
    this.hp -= amount;
    this.lastHitBy = attacker; this.lastHitT = performance.now();
    const frac = Math.max(0, this.hp / this.maxHp);
    this.fm.damage = Math.max(this.fm.damage, (1 - frac) * 0.6);
    if (Math.random() < amount / this.maxHp * 1.5) this.fm.engineDamage = Math.min(1, this.fm.engineDamage + 0.3);
    this.smoke = frac < 0.6 ? 1 - frac : 0;
    this.fire = frac < 0.3 ? 1 : 0;
    if (this.hp <= 0) { this.kill(attacker); return true; }
    return false;
  }
  // record an impact (body-frame point, radius m). Nearby impacts merge and grow into larger wounds.
  addHit(p, r) {
    const H = this.hits, lim = this.geo.radius * 0.9;
    const L = Math.hypot(p.x, p.y, p.z), k = L > lim ? lim / L : 1;
    const x = p.x * k, y = p.y * k, z = p.z * k;
    let best = -1, bd = 1e9, weakest = 0;
    for (let i = 0; i < 8; i++) {
      const o = i * 4;
      if (H[o + 3] <= 0) { if (bd > 1e8) { best = i; bd = 1e8; } continue; }
      const d = Math.hypot(H[o] - x, H[o + 1] - y, H[o + 2] - z);
      if (d < Math.max(H[o + 3], r) * 1.3 && d < bd) { best = i; bd = d; }
      if (H[o + 3] < H[weakest * 4 + 3]) weakest = i;
    }
    if (best >= 0 && bd < 1e8) {   // grow an existing wound toward the new impact
      const o = best * 4, w = H[o + 3];
      H[o] += (x - H[o]) * 0.25; H[o + 1] += (y - H[o + 1]) * 0.25; H[o + 2] += (z - H[o + 2]) * 0.25;
      H[o + 3] = Math.min(Math.max(w, r) + r * 0.18, this.geo.radius * 0.45);
      return;
    }
    const o = (best >= 0 ? best : weakest) * 4;
    H[o] = x; H[o + 1] = y; H[o + 2] = z; H[o + 3] = r;
  }
  // world-space blast point -> wound on the side of the airframe facing it
  addBlastHit(wp, r) {
    const b = _t1.set(wp.x - this.pos.x, wp.y - this.pos.y, wp.z - this.pos.z).applyQuatInv(this.q);
    const L = b.len(); if (L > 1e-3) b.scale(Math.min(L, this.geo.radius * 0.45) / L);
    this.addHit(b, r);
  }
  kill(attacker) {
    if (!this.alive) return;
    this.alive = false; this.killer = attacker; this.fire = 1; this.smoke = 1; this.deadT = 0;
    this.fm.engineDamage = 1; this.fm.damage = 1;
    this.deaths++;
    if (attacker && attacker !== this) attacker.kills++;
  }

  // segment (world) vs capsule hit-test; returns distance along segment or -1
  hitTest(a, b, extra = 0) {
    const fm = this.fm;
    const r = this.geo.radius + extra;
    // quick reject: segment vs bounding sphere
    const cx = fm.pos.x, cy = fm.pos.y, cz = fm.pos.z;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L2 = dx * dx + dy * dy + dz * dz;
    let t = L2 > 0 ? ((cx - a.x) * dx + (cy - a.y) * dy + (cz - a.z) * dz) / L2 : 0; t = clamp(t, 0, 1);
    const px = a.x + dx * t - cx, py = a.y + dy * t - cy, pz = a.z + dz * t - cz;
    if (px * px + py * py + pz * pz > r * r) return -1;
    // body frame capsules
    const A = _t1.set(a.x - cx, a.y - cy, a.z - cz).applyQuatInv(fm.q), B = _t2.set(b.x - cx, b.y - cy, b.z - cz).applyQuatInv(fm.q);
    for (const h of this.geo.hit) {
      const d = segSegDist(A, B, h.a, h.b);
      if (d < h.r + extra) {
        // impact point: on the capsule surface, toward the bullet path
        const s = _ssd.s, u = _ssd.t;
        const cx2 = h.a[0] + (h.b[0] - h.a[0]) * u, cy2 = h.a[1] + (h.b[1] - h.a[1]) * u, cz2 = h.a[2] + (h.b[2] - h.a[2]) * u;
        const bx = A.x + (B.x - A.x) * s - cx2, by = A.y + (B.y - A.y) * s - cy2, bz = A.z + (B.z - A.z) * s - cz2;
        const bl = Math.hypot(bx, by, bz), k = bl > 1e-4 ? Math.min(h.r, bl) / bl : 0;
        this.hitPt.set(cx2 + bx * k, cy2 + by * k, cz2 + bz * k);
        return t;
      }
    }
    return -1;
  }

  // update animated part matrices
  updateParts(cockpitView) {
    const parts = this.geo.parts, M = this.partMats, fm = this.fm, ctl = fm.ctl;
    const rpmFrac = this.spec.engine.type === 'prop' ? fm.eng.rpm / this.spec.engine.rpm : 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i], o = i * 16, m = M.subarray(o, o + 16);
      switch (p.kind) {
        case 'control': case 'surface': {
          const pm = this.partMap[i];
          if (pm && pm.obj) pivotRot(m, p.pivot, p.axis, pm.obj.defl * pm.sgn); else M4.identity(m);
          break;
        }
        case 'gear': {
          const leg = fm.gear.find(g => g.part === i);
          const ang = p.ang * (1 - ctl.gear);
          const comp = leg && ctl.gear > 0.98 ? leg.x : 0;
          pivotRot(m, p.pivot, p.axis, ang);
          m[13] += comp;
          if (ctl.gear < 0.02 && this.gearRetract !== false && fm.gearRetract) { for (let k = 0; k < 15; k++) m[k] = 0; }
          break;
        }
        case 'prop': pivotRot(m, p.pivot, p.axis, fm.eng.propAng); break;
        case 'blades':
          pivotRot(m, p.pivot, p.axis, fm.eng.propAng);
          if (rpmFrac > 0.3) { for (let k = 0; k < 15; k++) m[k] = 0; }
          break;
        case 'hook': pivotRot(m, p.pivot, p.axis, 35 * DEG * ctl.hook); break;
        case 'nozzle': pivotRot(m, p.pivot, p.axis, -ctl.tvc); break;
        case 'missile': {
          M4.identity(m);
          if (this.wpn.firedHard.has(i)) for (let k = 0; k < 15; k++) m[k] = 0;
          break;
        }
        case 'helmet': M4.identity(m); if (cockpitView) for (let k = 0; k < 15; k++) m[k] = 0; break;
        default: M4.identity(m);
      }
      // aero visualization values
      const pm = this.partMap[i];
      if (pm && pm.seg) { const s = pm.seg; this.surfVals[i] = s.stalled ? 2 : clamp(s.cl / 1.4, -1, 1); }
      else this.surfVals[i] = 0;
    }
  }
}

// closest distance between segments p1-q1 and p2-q2 (p2/q2 arrays)
function segSegDist(p1, q1, p2a, q2a) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2a[0] - p2a[0], d2y = q2a[1] - p2a[1], d2z = q2a[2] - p2a[2];
  const rx = p1.x - p2a[0], ry = p1.y - p2a[1], rz = p1.z - p2a[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) { _ssd.s = 0; _ssd.t = 0; return Math.hypot(rx, ry, rz); }
  if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  _ssd.s = s; _ssd.t = t;
  const x = p1.x + d1x * s - (p2a[0] + d2x * t), y = p1.y + d1y * s - (p2a[1] + d2y * t), z = p1.z + d1z * s - (p2a[2] + d2z * t);
  return Math.hypot(x, y, z);
}
const _ssd = { s: 0, t: 0 };
