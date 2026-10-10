'use strict';
// ---------------------------------------------------------------------------
// Weapons: ballistic gun rounds, IR / radar guided missiles (proportional
// navigation, motor burn, drag, G-limited), flares & chaff decoys, locking.
// ---------------------------------------------------------------------------
const MISSILE = {
  // drag = 0.5*rho*Cd*A/m at sea level (AIM-9: ~7e-5, AIM-120: ~4e-5); thrust in m/s^2
  ir: { name: 'IR', burn: 4.6, thrust: 150, drag: 0.00007, maxG: 40, life: 28, N: 4.0, fov: 70 * DEG, lockCone: 15 * DEG, range: 9000, minRange: 300, dmg: 150, fuse: 9, decoy: 0.3, lockTime: 0.9, seek: 'ir' },
  radar: { name: 'RDR', burn: 7.5, thrust: 125, drag: 0.00004, maxG: 34, life: 65, N: 3.8, fov: 75 * DEG, lockCone: 45 * DEG, range: 40000, minRange: 900, dmg: 170, fuse: 12, decoy: 0.2, lockTime: 1.6, seek: 'radar' },
};

class Missile {
  constructor() { this.pos = new V3(); this.vel = new V3(); this.dir = new V3(); this.active = false; }
}

class Weapons {
  constructor(game) {
    this.game = game;
    this.BMAX = 5000; this.nb = 0;
    this.b = new Float32Array(this.BMAX * 10); // x y z vx vy vz life dmg tracer cal
    this.bOwner = new Int32Array(this.BMAX);
    this.missiles = []; for (let i = 0; i < 96; i++) this.missiles.push(new Missile());
    this.decoys = []; // {pos, vel, life, kind}
    this.events = [];
    this._a = new V3(); this._b = new V3();
  }
  reset() { this.nb = 0; this.missiles.forEach(m => m.active = false); this.decoys.length = 0; }

  // --- guns: called each physics substep while trigger held ---
  fireGuns(ac, dt) {
    const G = ac.spec.guns; const W = ac.wpn;
    if (!G || W.ammo <= 0 || !ac.alive) { W.firing = false; return; }
    W.firing = true;
    W.gunAcc += G.rof * dt;
    const fm = ac.fm;
    const fwd = fm.fwd(_t4);
    while (W.gunAcc >= 1 && W.ammo > 0) {
      W.gunAcc -= 1; W.ammo--;
      if (this.nb >= this.BMAX) break;
      const pt = G.pts[W.barrel++ % G.pts.length];
      const p = _t5.set(pt[0], pt[1], -pt[2]).applyQuat(fm.q).add(fm.pos);
      const sp = G.spread;
      // guns converge ~350 m ahead
      const conv = _t6.set(-pt[0] / 350 + (Math.random() - 0.5) * sp * 2, -pt[1] / 350 + 0.004 + (Math.random() - 0.5) * sp * 2, -1).normalize().applyQuat(fm.q);
      const o = this.nb * 10, B = this.b;
      // stagger spawn along path inside the substep
      const frac = Math.random() * dt;
      B[o] = p.x + conv.x * G.vel * frac; B[o + 1] = p.y + conv.y * G.vel * frac; B[o + 2] = p.z + conv.z * G.vel * frac;
      B[o + 3] = fm.vel.x + conv.x * G.vel; B[o + 4] = fm.vel.y + conv.y * G.vel; B[o + 5] = fm.vel.z + conv.z * G.vel;
      B[o + 6] = 3.2; B[o + 7] = G.dmg; B[o + 8] = (W.barrel % (G.pts.length > 2 ? 4 : 3) === 0) ? 1 : 0; B[o + 9] = G.cal;
      this.bOwner[this.nb] = ac.uid;
      this.nb++;
    }
    if (W.ammo <= 0) W.firing = false;
  }

  launchMissile(ac, target) {
    const W = ac.wpn, kind = W.sel;
    if (kind !== 'ir' && kind !== 'radar') return false;
    if (W[kind] <= 0 || W.mslCool > 0 || !ac.alive) return false;
    const m = this.missiles.find(x => !x.active); if (!m) return false;
    const def = MISSILE[kind];
    W[kind]--; W.mslCool = 0.7;
    // choose a hardpoint
    const fm = ac.fm;
    const hp = ac.geo.hardParts.find(h => h.t === kind && !W.firedHard.has(h.part));
    let lp;
    if (hp) { W.firedHard.add(hp.part); lp = _t4.set(hp.pos[0], hp.pos[1] - 0.3, hp.pos[2]); }
    else lp = _t4.set(0, -1.0, -1);
    m.pos.copy(lp).applyQuat(fm.q).add(fm.pos);
    fm.fwd(m.dir);
    m.vel.copy(fm.vel).addScaled(fm.up(_t5), -6);
    m.active = true; m.def = def; m.kind = kind; m.owner = ac; m.target = target; m.t = 0; m.trailAcc = 0;
    m.decoyed = false; m.lost = !target; m.prevDist = 1e9; m.armed = false;
    if (target) target.threat = m;
    this.events.push({ type: 'launch', ac, kind, m });
    return true;
  }

  deployCM(ac) {
    const W = ac.wpn; if (W.flares <= 0 || W.cmCool > 0 || !ac.alive) return false;
    W.flares--; W.cmCool = 0.12;
    const fm = ac.fm;
    for (let k = 0; k < 2; k++) {
      const side = k ? 1 : -1;
      const v = _t4.set(side * 18, -14, 12).applyQuat(fm.q).add(fm.vel);
      this.decoys.push({ pos: fm.pos.clone(), vel: v.clone(), life: 4.5, kind: 'flare', owner: ac });
    }
    this.decoys.push({ pos: fm.pos.clone(), vel: fm.vel.clone().scale(0.7), life: 3, kind: 'chaff', owner: ac });
    this.events.push({ type: 'cm', ac });
    return true;
  }

  // --- locking (per aircraft) ---
  updateLock(ac, targets, dt) {
    const W = ac.wpn, kind = W.sel;
    W.mslCool = Math.max(0, W.mslCool - dt); W.cmCool = Math.max(0, W.cmCool - dt);
    if (!ac.alive || (kind !== 'ir' && kind !== 'radar') || W[kind] <= 0) { W.lock = null; W.lockState = 0; W.lockT = 0; return; }
    const def = MISSILE[kind];
    const fwd = ac.fm.fwd(_t4);
    // keep current candidate if still valid, else pick best in cone
    let best = null, bestScore = 1e9;
    for (const t of targets) {
      if (t === ac || !t.alive || t.team === ac.team) continue;
      const d = _t5.subVecs(t.pos, ac.pos); const dist = d.len();
      if (dist > def.range || dist < 50) continue;
      const ang = Math.acos(clamp(d.dot(fwd) / dist, -1, 1));
      if (ang > def.lockCone) continue;
      // IR: heat signature stronger from behind / with afterburner
      let score = ang * 3 + dist / def.range;
      if (ac.preferTarget === t) score -= 2;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    if (best !== W.lock) { W.lock = best; W.lockT = 0; }
    if (W.lock) { W.lockT += dt; W.lockState = W.lockT >= def.lockTime ? 2 : 1; }
    else W.lockState = 0;
  }

  // --- simulation step ---
  update(dt, aircraft, world, fx) {
    this.updateBullets(dt, aircraft, world, fx);
    this.updateMissiles(dt, aircraft, world, fx);
    this.updateDecoys(dt, fx);
  }

  updateBullets(dt, aircraft, world, fx) {
    const B = this.b, a = this._a, bb = this._b;
    let n = this.nb;
    const surf = { h: 0, type: 0, water: false, carrier: false };
    for (let i = 0; i < n; i++) {
      const o = i * 10;
      let life = B[o + 6] - dt;
      let dead = life <= 0;
      if (!dead) {
        a.set(B[o], B[o + 1], B[o + 2]);
        // drag + gravity
        const vx = B[o + 3], vy = B[o + 4], vz = B[o + 5];
        const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const k = 1 - (0.00045 / B[o + 9]) * sp * dt;
        B[o + 3] = vx * k; B[o + 4] = vy * k - G0 * dt; B[o + 5] = vz * k;
        B[o] += B[o + 3] * dt; B[o + 1] += B[o + 4] * dt; B[o + 2] += B[o + 5] * dt;
        bb.set(B[o], B[o + 1], B[o + 2]);
        B[o + 6] = life;
        // hit aircraft
        const owner = this.bOwner[i];
        for (const ac of aircraft) {
          if (ac.uid === owner || !ac.visible || ac.fm.crashed) continue;
          if (ac.hitTest(a, bb, 0.4) >= 0) {
            const shooter = aircraft.find(x => x.uid === owner);
            if (shooter && shooter.team === ac.team && ac.alive) continue;
            ac.addHit(ac.hitPt, 0.32 + B[o + 7] / ac.maxHp * 2.5);
            const killed = ac.takeDamage(B[o + 7], shooter, world);
            fx.bulletImpact(bb.x, bb.y, bb.z, 'air');
            this.events.push({ type: 'hit', target: ac, shooter, killed, x: bb.x, y: bb.y, z: bb.z });
            dead = true; break;
          }
        }
        // terrain
        if (!dead && bb.y < 3000) {
          world.surfaceAt(bb.x, bb.z, surf);
          if (bb.y < surf.h) { fx.bulletImpact(bb.x, surf.h, bb.z, surf.water ? 'water' : 'ground'); dead = true; }
        }
      }
      if (dead) {
        n--;
        if (i < n) { const o2 = n * 10; for (let j = 0; j < 10; j++) B[o + j] = B[o2 + j]; this.bOwner[i] = this.bOwner[n]; i--; }
      }
    }
    this.nb = n;
  }

  updateMissiles(dt, aircraft, world, fx) {
    const surf = { h: 0, type: 0, water: false, carrier: false };
    for (const m of this.missiles) {
      if (!m.active) continue;
      const def = m.def; m.t += dt;
      const atm = Atmos.at(m.pos.y, {});
      // seeker / decoys
      let tgtPos = null, tgtVel = null;
      if (m.decoyed && m.decoy && m.decoy.life > 0) { tgtPos = m.decoy.pos; tgtVel = m.decoy.vel; }
      else if (m.target && !m.lost) {
        const t = m.target;
        if (t.fm.crashed) m.lost = true;
        else {
          const los = _t4.subVecs(t.pos, m.pos); const dist = los.len();
          const ang = Math.acos(clamp(los.dot(m.dir) / dist, -1, 1));
          // IR seeker must see the target (it can re-acquire); radar missiles are datalinked
          const inView = def.seek === 'radar' || ang <= def.fov || m.t <= 0.4;
          if (inView) {
            tgtPos = t.pos; tgtVel = t.vel;
            // countermeasures
            for (const d of this.decoys) {
              if (d.tested && d.tested.has(m)) continue;
              const want = def.seek === 'ir' ? 'flare' : 'chaff';
              if (d.kind !== want || d.owner !== t) continue;
              (d.tested || (d.tested = new Set())).add(m);
              const dd = _t5.subVecs(d.pos, m.pos); const dl = dd.len();
              if (dl > (def.seek === 'ir' ? 4000 : 6000)) continue;
              // aspect: flares work better when target not in afterburner, head-on
              let p = def.decoy * (t.fm.eng.ab > 0.5 ? 0.6 : 1.0);
              if (Math.random() < p) { m.decoyed = true; m.decoy = d; t.threat = null; break; }
            }
          }
        }
      }
      // motor
      const spd = m.vel.len();
      let thrust = m.t < def.burn ? def.thrust : 0;
      // guidance: proportional navigation
      const acc = _t5.set(0, 0, 0);
      if (tgtPos && m.t > 0.25) {
        const r = _t6.subVecs(tgtPos, m.pos);
        const vr = this._a.subVecs(tgtVel, m.vel);
        const r2 = Math.max(r.lenSq(), 1);
        // LOS rate vector: (r x vr)/|r|^2 ; a = N * Vc * (omega x los)
        const wx = (r.y * vr.z - r.z * vr.y) / r2, wy = (r.z * vr.x - r.x * vr.z) / r2, wz = (r.x * vr.y - r.y * vr.x) / r2;
        const rl = Math.sqrt(r2); const lx = r.x / rl, ly = r.y / rl, lz = r.z / rl;
        const Vc = -(r.x * vr.x + r.y * vr.y + r.z * vr.z) / rl;
        const k = def.N * Math.max(Vc, 150);
        acc.set(k * (wy * lz - wz * ly), k * (wz * lx - wx * lz), k * (wx * ly - wy * lx));
        acc.y += G0; // gravity compensation
        // remove along-velocity component
        const vd = m.dir; const al = acc.dot(vd); acc.addScaled(vd, -al);
        const maxA = def.maxG * G0 * clamp(spd / 450, 0.3, 1) * clamp(atm.sigma * 1.6, 0.25, 1);
        const al2 = acc.len(); if (al2 > maxA) acc.scale(maxA / al2);
        // proximity fuse
        const dist = rl;
        if (!m.decoyed && m.target && (dist < def.fuse || (dist < def.fuse * 2.5 && dist > m.prevDist))) {
          this.detonate(m, aircraft, fx, dist); continue;
        }
        if (m.decoyed && dist < 8) { this.detonate(m, aircraft, fx, 999); continue; }
        m.prevDist = dist;
      }
      // integrate (point mass, aligned with velocity)
      // parasite (wave drag above M1) + induced drag from maneuvering (~9% of lateral accel)
      const dragK = def.drag * atm.rho / 1.225 * (spd > 330 ? 1.35 : 1);
      const ind = acc.len() * 0.09;
      m.vel.x += (m.dir.x * (thrust - ind) + acc.x) * dt - m.vel.x * spd * dragK * dt;
      m.vel.y += (m.dir.y * (thrust - ind) + acc.y - G0) * dt - m.vel.y * spd * dragK * dt;
      m.vel.z += (m.dir.z * (thrust - ind) + acc.z) * dt - m.vel.z * spd * dragK * dt;
      if (spd > 1) m.dir.copy(m.vel).scale(1 / m.vel.len());
      m.pos.addScaled(m.vel, dt);
      // trail
      if (thrust > 0) {
        m.trailAcc += dt;
        while (m.trailAcc > 0.016) {
          m.trailAcc -= 0.016;
          const j = (Math.random() - 0.5) * 0.6;
          fx.emit(PT.TRAIL, m.pos.x - m.dir.x * 2 + j, m.pos.y - m.dir.y * 2 + j, m.pos.z - m.dir.z * 2 + j, m.vel.x * 0.05 + (Math.random() - 0.5), m.vel.y * 0.05 + (Math.random() - 0.5), m.vel.z * 0.05 + (Math.random() - 0.5), 4 + Math.random() * 3, 0.8, 7, 0.88, 0.88, 0.86, 0.75, 1.2);
        }
      }
      // ground / timeout
      world.surfaceAt(m.pos.x, m.pos.z, surf);
      if (m.pos.y < surf.h) { fx.groundImpact(m.pos.x, surf.h, m.pos.z, surf.water, false); this.events.push({ type: 'boom', x: m.pos.x, y: m.pos.y, z: m.pos.z, size: 1 }); this.deactivate(m); continue; }
      if (m.t > def.life || (m.t > def.burn + 4 && spd < 200)) { fx.explosion(m.pos.x, m.pos.y, m.pos.z, 0.5); this.deactivate(m); }
    }
  }
  deactivate(m) { m.active = false; if (m.target && m.target.threat === m) m.target.threat = null; }

  detonate(m, aircraft, fx, dist) {
    fx.explosion(m.pos.x, m.pos.y, m.pos.z, 0.9, m.vel.x * 0.2, m.vel.y * 0.2, m.vel.z * 0.2);
    this.events.push({ type: 'boom', x: m.pos.x, y: m.pos.y, z: m.pos.z, size: 1 });
    for (const ac of aircraft) {
      if (!ac.visible || ac.fm.crashed) continue;
      const d = ac.pos.distTo(m.pos);
      const R = m.def.fuse * 2.2;
      if (d < R) {
        const dmg = m.def.dmg * clamp(1.25 - d / R, 0.15, 1);
        ac.addBlastHit(m.pos, 1.2 + 2.2 * clamp(1.25 - d / R, 0.15, 1));
        const killed = ac.takeDamage(dmg, m.owner);
        this.events.push({ type: 'mhit', target: ac, shooter: m.owner, killed });
      }
    }
    this.deactivate(m);
  }

  updateDecoys(dt, fx) {
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      d.life -= dt;
      if (d.life <= 0) { this.decoys.splice(i, 1); continue; }
      d.vel.y -= G0 * 0.25 * dt; d.vel.scale(Math.exp(-0.6 * dt));
      d.pos.addScaled(d.vel, dt);
      if (d.kind === 'flare') {
        fx.emit(PT.SMOKE, d.pos.x, d.pos.y, d.pos.z, 0, 0, 0, 2.2, 0.6, 3.5, 0.9, 0.9, 0.9, 0.5, 0.8);
      }
    }
  }

  // render data for tracers, missiles, flares
  emitRender(fx, cam) {
    const B = this.b;
    for (let i = 0; i < this.nb; i++) {
      const o = i * 10;
      if (B[o + 8] < 0.5) continue;
      const x = B[o], y = B[o + 1], z = B[o + 2], vx = B[o + 3], vy = B[o + 4], vz = B[o + 5];
      const L = 0.022;
      const big = B[o + 9] > 1 ? 1.4 : 1;
      fx.beam(x - vx * L, y - vy * L, z - vz * L, 0.12 * big, x, y, z, 0.18 * big, 3.2, 1.6, 0.6, 0.0, 1.0, 0);
    }
    for (const m of this.missiles) {
      if (!m.active) continue;
      if (m.t < m.def.burn) {
        const p = m.pos, d = m.dir;
        fx.glow(p.x - d.x * 1.8, p.y - d.y * 1.8, p.z - d.z * 1.8, 1.6, 6, 3.8, 1.8);
        fx.light(p.x - d.x * 2.5, p.y - d.y * 2.5, p.z - d.z * 2.5, 1.0, 0.62, 0.32, 900);
        fx.beam(p.x - d.x * 1.7, p.y - d.y * 1.7, p.z - d.z * 1.7, 0.18, p.x - d.x * 4.5, p.y - d.y * 4.5, p.z - d.z * 4.5, 0.05, 4, 2.2, 0.8, 1, 0, 0);
      }
    }
    // magnesium flares: blinding white, light up everything around them
    for (const d of this.decoys) if (d.kind === 'flare') { fx.glow(d.pos.x, d.pos.y, d.pos.z, 2.5, 14, 11, 7); fx.light(d.pos.x, d.pos.y, d.pos.z, 1.0, 0.9, 0.72, 5000 * Math.min(1, d.life), 1.5); }
  }
}
