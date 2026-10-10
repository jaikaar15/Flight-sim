'use strict';
// ---------------------------------------------------------------------------
// Effects: GPU-instanced particles (smoke, fire, sparks, vapor), beams
// (tracers, trails, spark streaks), afterburner flames, glow sprites and
// dynamic point lights (explosions, fires, flares light up their surroundings).
// All CPU data lives in preallocated typed arrays — no per-frame allocation.
// ---------------------------------------------------------------------------
// floats per particle (sim): x y z vx vy vz life maxLife size0 size1 type rot drag seed cool heat0
const PF = 16;
const PT = { SMOKE: 0, FIRE: 1, SPARK: 2, VAPOR: 3, DUST: 4, DEBRIS: 5, FLARE: 6, SPLASH: 7, TRAIL: 8, DARK: 9, EXHAUST: 10, FIREBALL: 11, SHOCK: 12, EMBER: 13 };
// atlas frames >= 12 are procedural in the particle shader
const FR = { FIREBALL: 12, SHOCK: 13 };
const LIGHT_MAX = 64;

class Effects {
  constructor(max = 16000) {
    this.max = max; this.n = 0;
    this.p = new Float32Array(max * PF);
    this.col = new Float32Array(max * 4);   // base color rgba
    this.inst = new Float32Array(max * 12);  // GPU instance data
    this.nInst = 0;
    // beams
    this.beamMax = 12000; this.beams = new Float32Array(this.beamMax * 14); this.nBeams = 0;
    // dynamic glows
    this.glowMax = 4000; this.glows = new Float32Array(this.glowMax * 8); this.nGlows = 0;
    // afterburner flames: exit xyz, length | axis xyz, nozzle radius | ab, throttle, seed, airspeed factor
    this.flameMax = 96; this.flames = new Float32Array(this.flameMax * 12); this.nFlames = 0;
    // point lights for this frame: x y z r g b intensity size (irradiance = I / (d^2 + size^2))
    this.dyn = new Float32Array(LIGHT_MAX * 8); this.nDyn = 0;
    this.wind = new V3();
    this.lights = [];  // timed lights (explosion flash + fireball glow)
    this.debris = [];  // burning chunks thrown out of explosions
    this.groundY = null; // (x, z) -> surface height, set by the game
  }
  reset() {
    this.n = 0; this.nInst = 0; this.nBeams = 0; this.nGlows = 0; this.nFlames = 0; this.nDyn = 0;
    this.lights.length = 0; this.debris.length = 0;
  }
  emit(type, x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag = 0.5, cool = 0, heat0 = 1.35) {
    if (this.n >= this.max) return;
    const i = this.n++, o = i * PF;
    const p = this.p;
    p[o] = x; p[o + 1] = y; p[o + 2] = z; p[o + 3] = vx; p[o + 4] = vy; p[o + 5] = vz;
    p[o + 6] = life; p[o + 7] = life; p[o + 8] = s0; p[o + 9] = s1; p[o + 10] = type; p[o + 11] = Math.random() * 6.28; p[o + 12] = drag; p[o + 13] = Math.random(); p[o + 14] = cool; p[o + 15] = heat0;
    const c = i * 4; this.col[c] = r; this.col[c + 1] = g; this.col[c + 2] = b; this.col[c + 3] = a;
  }
  // a flame/fireball puff that starts white-hot and cools (time constant `cool` s) into smoke of colour c
  puff(x, y, z, vx, vy, vz, life, s0, s1, c, a, drag, cool, heat0 = 1.35) {
    this.emit(PT.FIREBALL, x, y, z, vx, vy, vz, life, s0, s1, c * 1.1, c, c * 0.92, a, drag, cool, heat0);
  }
  // size = radius of the emitting body (m): softens lighting close to big sources like fireballs
  light(x, y, z, r, g, b, I, size = 3) {
    if (this.nDyn >= LIGHT_MAX || I <= 0) return;
    const o = this.nDyn++ * 8, D = this.dyn;
    D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = r; D[o + 4] = g; D[o + 5] = b; D[o + 6] = I; D[o + 7] = size;
  }
  update(dt, camPos) {
    this.updateLights(dt);
    this.updateDebris(dt);
    const p = this.p, col = this.col, inst = this.inst;
    let n = this.n, k = 0;
    const wx = this.wind.x, wz = this.wind.z;
    for (let i = 0; i < n; i++) {
      const o = i * PF;
      let life = p[o + 6] - dt;
      if (life <= 0) {
        // swap-remove
        n--; if (i < n) { const o2 = n * PF; for (let j = 0; j < PF; j++) p[o + j] = p[o2 + j]; for (let j = 0; j < 4; j++) col[i * 4 + j] = col[n * 4 + j]; i--; }
        continue;
      }
      p[o + 6] = life;
      const type = p[o + 10], drag = p[o + 12];
      const dk = Math.exp(-drag * dt);
      p[o + 3] = wx + (p[o + 3] - wx) * dk; p[o + 4] *= dk; p[o + 5] = wz + (p[o + 5] - wz) * dk;
      const age = p[o + 7] - life;
      if (type === PT.SMOKE || type === PT.DARK || type === PT.EXHAUST) p[o + 4] += 1.2 * dt;
      else if (type === PT.SPARK || type === PT.DEBRIS || type === PT.SPLASH || type === PT.FLARE) p[o + 4] -= 9.8 * dt * (type === PT.FLARE ? 0.25 : 1);
      else if (type === PT.FIRE) p[o + 4] += 2.5 * dt;
      else if (type === PT.FIREBALL) p[o + 4] += (1.2 + 5 * Math.exp(-age / Math.max(p[o + 14], 0.05))) * dt;  // hot gas is buoyant
      else if (type === PT.EMBER) { p[o + 4] += (1.5 - 2.5 * p[o + 13]) * dt; }
      p[o] += p[o + 3] * dt; p[o + 1] += p[o + 4] * dt; p[o + 2] += p[o + 5] * dt;
      p[o + 11] += dt * (p[o + 13] - 0.5) * 0.8;
      const t = 1 - life / p[o + 7];   // 0 -> 1
      let size = p[o + 8] + (p[o + 9] - p[o + 8]) * Math.sqrt(t);
      const c = i * 4;
      let a = col[c + 3], em = 0, frame = (p[o + 13] * 8) | 0, w = 1;
      let r = col[c], g = col[c + 1], b = col[c + 2];
      switch (type) {
        case PT.FIRE: a *= (1 - t) * (1 - t); em = 3.0 * (1 - t * 0.7); frame = 8; r *= 1; g *= 1 - t * 0.6; b *= 1 - t; break;
        case PT.SPARK: case PT.EMBER: {
          // motion-stretched streaks instead of dots
          const s = type === PT.SPARK ? 0.045 : 0.09, fade = type === PT.SPARK ? 1 - t : Math.sin(Math.min(t * 6, 1) * 1.57) * (1 - t);
          const flick = type === PT.EMBER ? 0.6 + 0.4 * Math.sin(age * 23 + p[o + 13] * 40) : 1;
          const I = (type === PT.SPARK ? 9 : 5) * fade * flick * a;
          this.beam(p[o], p[o + 1], p[o + 2], size, p[o] - p[o + 3] * s, p[o + 1] - p[o + 4] * s, p[o + 2] - p[o + 5] * s, size * 0.4, r * I, g * I, b * I, 1, 0.2, 0);
          continue;
        }
        case PT.FLARE: a *= 1 - t * t; em = 14; frame = 10; break;
        case PT.VAPOR: a *= Math.sin(t * Math.PI); break;
        case PT.TRAIL: a *= (1 - t) * Math.min(1, t * 20); break;
        case PT.DEBRIS: frame = 11; break;
        case PT.EXHAUST: a *= (1 - t); break;
        case PT.FIREBALL: {
          // rapid initial expansion, then slow billowing growth; temperature decays exponentially
          const cool = Math.max(p[o + 14], 0.05);
          size = p[o + 8] + (p[o + 9] - p[o + 8]) * (1 - Math.exp(-age * 3.2 / Math.max(cool * 2, 0.4))) * (0.75 + 0.25 * t);
          em = p[o + 15] * Math.exp(-age / cool);
          a *= Math.min(1, age * 6 + 0.25) * (1 - t) * (1 - t * 0.4);
          frame = FR.FIREBALL; w = p[o + 13];
          break;
        }
        case PT.SHOCK: a *= (1 - t) * (1 - t); frame = FR.SHOCK; w = p[o + 13]; break;
        default: a *= (1 - t) * Math.min(1, t * 8 + 0.2);
      }
      const q = k * 12;
      inst[q] = p[o]; inst[q + 1] = p[o + 1]; inst[q + 2] = p[o + 2]; inst[q + 3] = size;
      inst[q + 4] = r; inst[q + 5] = g; inst[q + 6] = b; inst[q + 7] = a;
      inst[q + 8] = p[o + 11]; inst[q + 9] = frame; inst[q + 10] = em; inst[q + 11] = w;
      k++;
    }
    this.n = n; this.nInst = k;
  }
  // explosion flash -> fireball glow, drifting with the blast momentum
  updateLights(dt) {
    const Ls = this.lights;
    for (let i = Ls.length - 1; i >= 0; i--) {
      const L = Ls[i];
      L.t += dt;
      if (L.t >= L.life) { Ls.splice(i, 1); continue; }
      const dk = Math.exp(-1.5 * dt);
      L.vx *= dk; L.vy = L.vy * dk + 2.5 * dt; L.vz *= dk;
      L.x += L.vx * dt; L.y += L.vy * dt; L.z += L.vz * dt;
      const u = L.t / L.life;
      // brief white flash, then the fireball's orange glow fading as it cools
      const flash = Math.exp(-L.t / 0.06);
      const glow = 0.3 * Math.exp(-L.t / L.cool) * (1 - u) * (0.82 + 0.18 * Math.sin(L.t * 37 + L.seed * 9));
      const I = L.I * (flash + glow);
      const wf = flash / (flash + glow + 1e-6);
      this.light(L.x, L.y, L.z, 1.0, 0.46 + 0.42 * wf, 0.14 + 0.58 * wf, I, L.size * (3 + 5 * Math.min(1, L.t * 4)));
      // the visible flash itself
      if (L.t < 0.25) { const k = flash * 22 + 1.5 * (1 - L.t / 0.25); this.glow(L.x, L.y, L.z, L.size * (5 + L.t * 40), k, k * 0.78, k * 0.5); }
    }
  }
  // burning chunks: ballistic, trailing fire and smoke, extinguish on impact
  updateDebris(dt) {
    const D = this.debris;
    for (let i = D.length - 1; i >= 0; i--) {
      const d = D[i];
      d.life -= dt; d.t += dt;
      const dk = Math.exp(-0.18 * dt);
      d.vx *= dk; d.vy = d.vy * dk - 9.8 * dt; d.vz *= dk;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      const gy = this.groundY ? this.groundY(d.x, d.z) : -1e9;
      if (d.life <= 0 || d.y < gy) {
        if (d.y < gy + 2) this.emit(PT.DUST, d.x, gy + 0.5, d.z, 0, 2, 0, 2.5, d.size * 1.2, d.size * 5, 0.3, 0.27, 0.22, 0.6, 1.2);
        D.splice(i, 1); continue;
      }
      const heat = Math.min(1, d.life / 1.2);
      d.acc += dt * 60;
      while (d.acc >= 1) {
        d.acc -= 1;
        const j = Math.random();
        const px = d.x - d.vx * dt * j, py = d.y - d.vy * dt * j, pz = d.z - d.vz * dt * j;
        if (heat > 0.05) this.puff(px, py, pz, d.vx * 0.05, d.vy * 0.05, d.vz * 0.05, 0.55 + Math.random() * 0.4, d.size * 0.8, d.size * 2.6, 0.07, 0.8 * heat, 2.5, 0.12 + 0.1 * heat, 1.05);
        if (Math.random() < 0.5) { const c = 0.06 + Math.random() * 0.05; this.emit(PT.DARK, px, py, pz, 0, 0.5, 0, 2.5 + Math.random() * 2, d.size * 1.2, d.size * 6, c, c, c, 0.55, 1.2); }
      }
      this.glow(d.x, d.y, d.z, d.size * 1.6, 7 * heat, 3.2 * heat, 0.9 * heat);
    }
  }
  // ---- beams ----
  beam(ax, ay, az, aw, bx, by, bz, bw, r, g, b, a0, a1, mode) {
    if (this.nBeams >= this.beamMax) return;
    const o = this.nBeams++ * 14, B = this.beams;
    B[o] = ax; B[o + 1] = ay; B[o + 2] = az; B[o + 3] = aw; B[o + 4] = bx; B[o + 5] = by; B[o + 6] = bz; B[o + 7] = bw;
    B[o + 8] = r; B[o + 9] = g; B[o + 10] = b; B[o + 11] = a0; B[o + 12] = a1; B[o + 13] = mode;
  }
  glow(x, y, z, size, r, g, b, flags = 0) {
    if (this.nGlows >= this.glowMax) return;
    const o = this.nGlows++ * 8, G = this.glows;
    G[o] = x; G[o + 1] = y; G[o + 2] = z; G[o + 3] = Math.round((size - 0.5) * 10) + (flags === 3 ? Math.random() * 0.9 : 0); G[o + 4] = r; G[o + 5] = g; G[o + 6] = b; G[o + 7] = flags;
  }
  flame(x, y, z, len, ax, ay, az, r, ab, thr, seed, spd) {
    if (this.nFlames >= this.flameMax) return;
    const o = this.nFlames++ * 12, F = this.flames;
    F[o] = x; F[o + 1] = y; F[o + 2] = z; F[o + 3] = len; F[o + 4] = ax; F[o + 5] = ay; F[o + 6] = az; F[o + 7] = r;
    F[o + 8] = ab; F[o + 9] = thr; F[o + 10] = seed; F[o + 11] = spd;
  }
  beginFrame() { this.nBeams = 0; this.nGlows = 0; this.nFlames = 0; this.nDyn = 0; }

  // ---- composite effects ----
  // scale ~0.5 small warhead, ~1 missile hit, 2.5 aircraft / ground impact. opts.debris: burning chunks
  explosion(x, y, z, scale = 1, vx = 0, vy = 0, vz = 0, opts = {}) {
    const s = scale, rs = Math.sqrt(s);
    // flash + fireball light (the main light source for the surroundings)
    this.lights.push({ x, y, z, vx: vx * 0.3, vy: vy * 0.3, vz: vz * 0.3, t: 0, life: 3.5 * rs, cool: 0.9 * rs, I: 6e4 * s, size: rs, seed: Math.random() });
    // condensation / shock shell
    this.emit(PT.SHOCK, x, y, z, vx * 0.3, vy * 0.3, vz * 0.3, 0.26 * rs, 3 * s, 24 * s, 0.9, 0.9, 0.9, 0.2, 0.5);
    // white-hot core
    for (let i = 0; i < 4; i++) { const d = randDir(), sp = 3 * s; this.puff(x, y, z, vx * 0.3 + d[0] * sp, vy * 0.3 + d[1] * sp, vz * 0.3 + d[2] * sp, 1.6 * rs, 2 * s, (7 + Math.random() * 3) * s, 0.1, 0.9, 2.5, 0.35 * rs); }
    // boiling fireball lobes that cool into a dark smoke cloud
    const nF = Math.round(12 + 8 * s);
    for (let i = 0; i < nF; i++) {
      const d = randDir(), sp = (5 + Math.random() * 15) * s;
      const c = 0.05 + Math.random() * 0.06;
      this.puff(x + d[0] * s, y + d[1] * s, z + d[2] * s, vx * 0.25 + d[0] * sp, vy * 0.25 + d[1] * sp + 1.5, vz * 0.25 + d[2] * sp,
        (3.2 + Math.random() * 3) * rs, (2.5 + Math.random() * 2) * s, (10 + Math.random() * 8) * s, c, 0.92, 1.7, (0.45 + Math.random() * 0.4) * rs);
    }
    // lingering smoke
    for (let i = 0; i < 10 * s; i++) {
      const d = randDir(), sp = (3 + Math.random() * 8) * s;
      const c = 0.07 + Math.random() * 0.08;
      this.emit(PT.DARK, x, y, z, vx * 0.2 + d[0] * sp, vy * 0.2 + d[1] * sp + 2, vz * 0.2 + d[2] * sp, 6 + Math.random() * 6, 6 * s, (24 + Math.random() * 16) * s, c, c, c, 0.75, 0.9);
    }
    // spark streaks + slower embers
    for (let i = 0; i < 60 * s; i++) {
      const d = randDir(), sp = (35 + Math.random() * 90) * s;
      this.emit(PT.SPARK, x, y, z, vx * 0.5 + d[0] * sp, vy * 0.5 + d[1] * sp, vz * 0.5 + d[2] * sp, 0.5 + Math.random() * 1.1, 0.16 * rs, 0.08, 1.0, 0.62, 0.26, 1, 1.1);
    }
    for (let i = 0; i < 26 * s; i++) {
      const d = randDir(), sp = (4 + Math.random() * 14) * s;
      this.emit(PT.EMBER, x, y, z, vx * 0.3 + d[0] * sp, vy * 0.3 + d[1] * sp + 3, vz * 0.3 + d[2] * sp, 2 + Math.random() * 3, 0.1 * rs, 0.05, 1.0, 0.45, 0.12, 1, 1.4);
    }
    // dark fragments
    for (let i = 0; i < 12 * s; i++) {
      const d = randDir(), sp = (15 + Math.random() * 35) * s;
      this.emit(PT.DEBRIS, x, y, z, vx * 0.6 + d[0] * sp, vy * 0.6 + d[1] * sp + 5, vz * 0.6 + d[2] * sp, 2 + Math.random() * 3, 0.6 + Math.random() * 0.8, 0.6, 0.05, 0.05, 0.05, 1, 0.2);
    }
    // burning chunks arcing out on smoke trails
    const nD = opts.debris === undefined ? Math.round(2 * s) : opts.debris;
    for (let i = 0; i < nD; i++) {
      const d = randDir(), sp = (18 + Math.random() * 30) * rs;
      this.debris.push({ x, y, z, vx: vx * 0.7 + d[0] * sp, vy: vy * 0.7 + Math.abs(d[1]) * sp + 8, vz: vz * 0.7 + d[2] * sp, life: 2.5 + Math.random() * 3, t: 0, size: (0.5 + Math.random() * 0.6) * rs, acc: 0 });
    }
  }
  groundImpact(x, y, z, water, big) {
    const s = big ? 2.5 : 1;
    if (water) {
      for (let i = 0; i < 40 * s; i++) { const a = Math.random() * 6.28, sp = Math.random() * 8 * s; this.emit(PT.SPLASH, x, y, z, Math.cos(a) * sp, 10 + Math.random() * 25 * s, Math.sin(a) * sp, 1.5 + Math.random(), 3 * s, 10 * s, 0.85, 0.9, 0.95, 0.8, 0.6); }
      for (let i = 0; i < 12 * s; i++) { const a = Math.random() * 6.28, sp = Math.random() * 4 * s; this.emit(PT.SMOKE, x, y + 3, z, Math.cos(a) * sp, 4 + Math.random() * 6, Math.sin(a) * sp, 5 + Math.random() * 4, 5 * s, 22 * s, 0.85, 0.87, 0.9, 0.45, 0.6); }
      this.lights.push({ x, y: y + 5, z, vx: 0, vy: 0, vz: 0, t: 0, life: 0.5, cool: 0.15, I: 1.5e4 * s, size: 0.6 * Math.sqrt(s), seed: Math.random() });
    } else {
      this.explosion(x, y + 2, z, s, 0, 0, 0, { debris: big ? 6 : 2 });
      // dirt thrown up + dust skirt rolling outwards
      for (let i = 0; i < 24 * s; i++) { const a = Math.random() * 6.28, sp = Math.random() * 9 * s; this.emit(PT.DEBRIS, x, y + 1, z, Math.cos(a) * sp, 12 + Math.random() * 22 * s, Math.sin(a) * sp, 2 + Math.random() * 2, 0.5 + Math.random() * 0.7, 0.5, 0.12, 0.1, 0.08, 1, 0.3); }
      for (let i = 0; i < 30; i++) { const a = Math.random() * 6.28, sp = (6 + Math.random() * 10) * s; this.emit(PT.DUST, x, y + 1, z, Math.cos(a) * sp, 1 + Math.random() * 4, Math.sin(a) * sp, 5 + Math.random() * 4, 4 * s, 28 * s, 0.42, 0.36, 0.27, 0.7, 0.8); }
    }
  }
  bulletImpact(x, y, z, kind) {
    if (kind === 'air') {
      for (let i = 0; i < 6; i++) { const d = randDir(); this.emit(PT.SPARK, x, y, z, d[0] * 35, d[1] * 35, d[2] * 35, 0.25, 0.12, 0.05, 1, 0.8, 0.4, 1, 1); }
      this.emit(PT.DARK, x, y, z, 0, 0, 0, 1.5, 1, 4, 0.2, 0.2, 0.2, 0.6, 1);
      this.lights.push({ x, y, z, vx: 0, vy: 0, vz: 0, t: 0, life: 0.12, cool: 0.05, I: 1500, size: 0.15, seed: Math.random() });
    } else if (kind === 'water') {
      this.emit(PT.SPLASH, x, y, z, 0, 8, 0, 0.9, 0.6, 2.5, 0.9, 0.92, 0.95, 0.8, 1);
    } else {
      this.emit(PT.DUST, x, y, z, 0, 4, 0, 1.6, 0.8, 4, 0.45, 0.38, 0.3, 0.7, 1.5);
      if (Math.random() < 0.3) this.emit(PT.SPARK, x, y, z, (Math.random() - 0.5) * 10, 8, (Math.random() - 0.5) * 10, 0.3, 0.1, 0.05, 1, 0.8, 0.4, 1, 1);
    }
  }
}
const _rd = [0, 0, 0];
function randDir() {
  let x, y, z, l;
  do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 0.01);
  l = Math.sqrt(l); _rd[0] = x / l; _rd[1] = y / l; _rd[2] = z / l; return _rd;
}
