'use strict';
// ---------------------------------------------------------------------------
// AI pilots fly the same physics as the player. They output stick inputs
// into the rate-command FCS: bank-to-turn pursuit, lead/lag, energy
// management, terrain avoidance, missile defense, gun/missile employment.
// ---------------------------------------------------------------------------
const SKILL = [
  { name: 'ROOKIE', react: 0.9, aim: 0.012, g: 0.62, mslCool: 20, flare: 0.35, fireCone: 2.5 },
  { name: 'VETERAN', react: 0.45, aim: 0.006, g: 0.85, mslCool: 12, flare: 0.7, fireCone: 1.8 },
  { name: 'ACE', react: 0.2, aim: 0.0025, g: 1.0, mslCool: 7, flare: 0.92, fireCone: 1.2 },
];

// Steer aircraft toward a world direction. Returns stick inputs in out.
function steerToward(ac, dir, out, aggr = 1, rollLimit = Math.PI) {
  const fm = ac.fm;
  const d = _t1.copy(dir).normalize().applyQuatInv(fm.q);   // body frame
  const fwdC = -d.z;
  const off = Math.acos(clamp(fwdC, -1, 1));
  // bank so the target lies along the lift vector (+Y body)
  let rollErr = Math.atan2(d.x, d.y);
  const up = fm.up(_t2), right = fm.right(_t3);
  const bank = Math.atan2(-right.y, up.y);
  // when the target is near the nose, fly mostly wings-level-ish (point with pitch/yaw)
  const wPoint = smooth(2 * DEG, 14 * DEG, off);
  const levelErr = clamp(-bank, -0.6, 0.6);
  let r = rollErr * wPoint * 2.4 + levelErr * (1 - wPoint) * 1.2;
  // limit bank angle (e.g. for gentle navigation)
  if (rollLimit < Math.PI) { const nb = bank + r * 0.5; if (Math.abs(nb) > rollLimit) r = (Math.sign(nb) * rollLimit - bank) * 2; }
  out.roll = clamp(r, -1, 1) * aggr;
  // pull when lift vector roughly aligned with target
  const pitchAng = Math.atan2(d.y, Math.max(fwdC, -1));
  const align = smooth(75 * DEG, 25 * DEG, Math.abs(rollErr) * wPoint);
  let p = pitchAng * 3.0 * (wPoint > 0.5 ? align : 1);
  if (off > 25 * DEG && d.y > 0) p = Math.max(p, align * aggr);
  out.pitch = clamp(p, -0.6, 1) * aggr;
  out.yaw = clamp(Math.atan2(d.x, fwdC) * 2.5 * (1 - wPoint), -1, 1);
  return out;
}

class AIPilot {
  constructor(ac, skill, game) {
    this.ac = ac; this.skill = SKILL[skill]; this.game = game;
    this.target = null; this.retarget = 0; this.mslTimer = 3 + Math.random() * 5; this.cmTimer = 0;
    this.noise = new V3(); this.noiseT = 0; this.mode = 'engage'; this.wingLead = null; this.formOff = new V3();
    this.trigger = false; this.out = { pitch: 0, roll: 0, yaw: 0 };
    this.lag = { pitch: 0, roll: 0, yaw: 0 };
  }
  pickTarget(all) {
    let best = null, bd = 1e12;
    for (const t of all) {
      if (t.team === this.ac.team || !t.alive || t.fm.crashed) continue;
      let d = t.pos.distSq(this.ac.pos);
      if (t.isPlayer) d *= 0.7;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  update(dt, all, world) {
    const ac = this.ac, fm = ac.fm, S = this.skill;
    if (!ac.alive) return;
    this.retarget -= dt; this.mslTimer -= dt; this.cmTimer -= dt; this.noiseT -= dt;
    // holding: the player is still on the ground -> nobody engages, weapons safe
    const hold = this.game.fightOn === false;
    if (hold) this.target = null;
    else { this.holdC = null; if (!this.target || !this.target.alive || this.retarget <= 0) { this.target = this.pickTarget(all); this.retarget = 4 + Math.random() * 3; } }
    if (this.noiseT <= 0) { this.noise.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).scale(2); this.noiseT = 0.6 + Math.random(); }
    const V = fm.out.tas, spec = ac.spec;
    const fwd = fm.fwd(_t4).clone();
    let dir = null, aggr = S.g, throttle = 1;
    this.trigger = false;
    const T = this.target;
    // ---------- missile defense ----------
    const thr = ac.threat;
    let defending = false;
    if (thr && thr.active && thr.target === ac && !thr.decoyed) {
      const md = thr.pos.distTo(ac.pos);
      if (md < 5000) {
        defending = true;
        const los = _t5.subVecs(thr.pos, ac.pos).normalize();
        // turn perpendicular to the missile (beam), slightly nose-low to gain energy
        const perp = new V3().crossVecs(los, _t6.set(0, 1, 0)).normalize();
        if (perp.dot(fwd) < 0) perp.negate();
        perp.y -= 0.15; dir = perp;
        aggr = 1;
        if (md < 3200 && this.cmTimer <= 0 && Math.random() < S.flare) { this.game.weapons.deployCM(ac); this.cmTimer = 0.35 + Math.random() * 0.3; }
      }
    }
    // ---------- engage ----------
    if (!dir && T) {
      const rel = _t5.subVecs(T.pos, ac.pos); const dist = rel.len();
      const tv = T.vel;
      const G = spec.guns;
      // lead point for guns
      let lead = T.pos.clone();
      if (G) {
        const tf = dist / (G.vel + 50);
        lead.addScaled(tv, tf).addScaled(fm.vel, -tf);
        lead.y += 0.5 * G0 * tf * tf;
      }
      lead.addScaled(this.noise, dist * S.aim);
      const toLead = lead.sub(ac.pos);
      const angLead = Math.acos(clamp(toLead.clone().normalize().dot(fwd), -1, 1));
      const angTgt = Math.acos(clamp(rel.clone().normalize().dot(fwd), -1, 1));
      // pursuit geometry: lead when close & in front, pure otherwise, lag if overshooting
      const closure = -rel.dot(_t6.subVecs(tv, fm.vel)) / Math.max(dist, 1);
      if (dist < 1400 && angTgt < 60 * DEG) dir = toLead;
      else if (closure > 120 && dist < 2000) { dir = rel.clone().addScaled(tv, -1.2); }   // lag to avoid overshoot
      else dir = rel.clone().addScaled(tv, Math.min(dist / 600, 4));
      // gun employment
      if (G && ac.wpn.ammo > 0 && dist < 950 && angLead < S.fireCone * DEG * (1 + 300 / dist)) this.trigger = true;
      // missiles
      const W = ac.wpn;
      if (this.mslTimer <= 0) {
        const pref = W.radar > 0 && dist > 4500 ? 'radar' : (W.ir > 0 ? 'ir' : (W.radar > 0 ? 'radar' : null));
        if (pref) {
          W.sel = pref; ac.preferTarget = T;
          const def = MISSILE[pref];
          if (W.lock === T && W.lockState === 2 && dist > def.minRange && dist < def.range * (pref === 'ir' ? 0.6 : 0.55)) {
            if (this.game.weapons.launchMissile(ac, T)) this.mslTimer = S.mslCool * (0.7 + Math.random() * 0.6);
          }
        }
      }
      // energy: keep near corner speed
      const corner = spec.vref * 1.35;
      throttle = V < corner * 1.25 ? 1 : 0.9;
      if (dist < 600 && closure > 60) throttle = 0.5;
    }
    if (!dir && hold) {
      // racetrack-style orbit around a point off the right wing until cleared to engage
      const R0 = 3000;
      if (!this.holdC) {
        const rt = _t6.set(-fwd.z, 0, fwd.x).normalize();
        this.holdC = fm.pos.clone().addScaled(rt, R0);
        const dx = fm.pos.x - this.holdC.x, dz = fm.pos.z - this.holdC.z;
        this.holdS = Math.sign(fwd.x * -dz + fwd.z * dx) || 1;
        this.holdAlt = Math.max(fm.pos.y, Math.max(world.terrain.heightAt(fm.pos.x, fm.pos.z), 0) + 1200);
      }
      const dx = fm.pos.x - this.holdC.x, dz = fm.pos.z - this.holdC.z, r = Math.hypot(dx, dz) || 1;
      const k = clamp((R0 - r) / R0, -0.8, 0.8);
      dir = new V3(this.holdS * -dz / r + dx / r * k, 0, this.holdS * dx / r + dz / r * k);
      dir.y = clamp((this.holdAlt - fm.pos.y) * 0.0008, -0.3, 0.3);
      throttle = 0.75; aggr = 0.6;
    }
    if (!dir) {
      // no target: orbit/patrol at altitude
      dir = fwd.clone(); dir.y = (2500 - fm.pos.y) * 0.0006; throttle = 0.8;
    }
    // ---------- terrain avoidance ----------
    const look = clamp(V * 7, 600, 3500);
    const vdir = fm.vel.clone().normalize();
    let minClear = 1e9;
    for (let k = 1; k <= 5; k++) {
      const p = _t6.copy(fm.pos).addScaled(vdir, look * k / 5);
      const h = Math.max(world.terrain.heightAt(p.x, p.z), 0);
      minClear = Math.min(minClear, p.y - h);
    }
    const agl = fm.out.agl;
    const floor = 220 + V * 0.6;
    if (minClear < floor || agl < floor * 0.6) {
      const k = clamp((floor - minClear) / floor, 0, 1);
      const recover = fwd.clone(); recover.y = 0; recover.normalize(); recover.y = 0.4 + k * 1.2;
      dir = dir.clone().normalize().lerp(recover.normalize(), clamp(0.5 + k, 0, 1));
      aggr = 1;
    }
    // ---------- steering ----------
    steerToward(ac, dir, this.out, aggr);
    // human-like reaction lag
    const k = 1 - Math.exp(-dt / S.react * 3);
    this.lag.pitch += (this.out.pitch - this.lag.pitch) * k;
    this.lag.roll += (this.out.roll - this.lag.roll) * k;
    this.lag.yaw += (this.out.yaw - this.lag.yaw) * k;
    ac.input.pitch = this.lag.pitch; ac.input.roll = this.lag.roll; ac.input.yaw = this.lag.yaw;
    fm.ctl.throttle = throttle;
    fm.ctl.gearTarget = fm.out.agl < 60 && V < spec.vref ? 1 : 0;
    fm.ctl.flapsTarget = 0;
  }
}
