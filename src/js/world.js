'use strict';
// ---------------------------------------------------------------------------
// World layout: airfields, runways, structures, lights, carrier, vegetation.
// Rect types: 0 asphalt rwy, 1 concrete rwy, 2 grass rwy, 3 lakebed rwy,
//             4 taxiway, 5 apron, 6 lakebed ellipse
// ---------------------------------------------------------------------------
const SURF = { ASPHALT: 0, CONCRETE: 1, GRASS: 2, LAKEBED: 3, TAXI: 4, APRON: 5, LAKE: 6 };

const AIRPORTS = [
  {
    id: 'HPI', name: 'Harbor Point International', short: 'HARBOR POINT', icao: 'SLHP',
    desc: 'Coastal international hub. Twin parallel runways with full approach lighting, next to the city.',
    x: 0, z: 9000, hdg: 90, elev: 22, pad: { hl: 1900, hw: 520, blend: 900 },
    rects: [
      { t: 5, u: 0, v: -620, h: 0, len: 900, wid: 260 },
      { t: 4, u: 0, v: -200, h: 0, len: 3300, wid: 23 },
      { t: 4, u: -1500, v: -200, h: 90, len: 400, wid: 23 }, { t: 4, u: -500, v: -200, h: 90, len: 400, wid: 23 },
      { t: 4, u: 500, v: -200, h: 90, len: 400, wid: 23 }, { t: 4, u: 1500, v: -200, h: 90, len: 400, wid: 23 },
      { t: 4, u: 0, v: -445, h: 90, len: 110, wid: 23 },
      { t: 1, u: 0, v: 0, h: 0, len: 3200, wid: 45, suf: [2, 1], name: '09R/27L', als: [true, true], main: true },
      { t: 0, u: 200, v: -400, h: 0, len: 2400, wid: 45, suf: [1, 2], name: '09L/27R', als: [false, false] },
    ],
    buildings: [
      { t: 0, u: 0, v: -810, w: 560, h: 18, d: 45 }, { t: 2, u: 520, v: -800, w: 10, h: 52, d: 10 },
      { t: 1, u: -380, v: -820, w: 80, h: 22, d: 60 }, { t: 1, u: -480, v: -820, w: 80, h: 22, d: 60 },
      { t: 1, u: 380, v: -820, w: 70, h: 20, d: 60 },
    ],
  },
  {
    id: 'RBK', name: 'Ridgeback Air Force Base', short: 'RIDGEBACK AFB', icao: 'SLRB',
    desc: 'Military airbase on the central plateau. Long concrete runway, hardened shelters.',
    x: -9000, z: -2500, hdg: 0, elev: null, pad: { hl: 1700, hw: 500, blend: 900 },
    rects: [
      { t: 5, u: 300, v: -400, h: 0, len: 760, wid: 200 },
      { t: 4, u: 0, v: -220, h: 0, len: 3000, wid: 25 },
      { t: 4, u: -1400, v: -110, h: 90, len: 220, wid: 25 }, { t: 4, u: 0, v: -110, h: 90, len: 220, wid: 25 }, { t: 4, u: 1400, v: -110, h: 90, len: 220, wid: 25 },
      { t: 1, u: 0, v: 0, h: 0, len: 3000, wid: 50, suf: [0, 0], name: '36/18', als: [true, true], main: true },
    ],
    buildings: [
      { t: 3, u: 0, v: -560, w: 36, h: 11, d: 28 }, { t: 3, u: 90, v: -560, w: 36, h: 11, d: 28 }, { t: 3, u: 180, v: -560, w: 36, h: 11, d: 28 },
      { t: 3, u: 270, v: -560, w: 36, h: 11, d: 28 }, { t: 3, u: 360, v: -560, w: 36, h: 11, d: 28 }, { t: 3, u: 450, v: -560, w: 36, h: 11, d: 28 },
      { t: 3, u: 540, v: -560, w: 36, h: 11, d: 28 }, { t: 3, u: 630, v: -560, w: 36, h: 11, d: 28 },
      { t: 1, u: -150, v: -560, w: 90, h: 24, d: 70 }, { t: 2, u: 760, v: -540, w: 9, h: 40, d: 9 },
      { t: 5, u: 400, v: -680, w: 200, h: 12, d: 40 }, { t: 4, u: -900, v: -700, w: 6, h: 60, d: 6 },
    ],
  },
  {
    id: 'EGN', name: "Eagle's Nest Mountain Strip", short: "EAGLE'S NEST", icao: 'SLEN',
    desc: 'Short, high-altitude strip carved into the northern range. Thin air, terrain on all sides.',
    x: 3500, z: -10500, hdg: 60, elev: null, pad: { hl: 760, hw: 110, blend: 520 },
    rects: [
      { t: 5, u: 300, v: -60, h: 0, len: 140, wid: 50 },
      { t: 0, u: 0, v: 0, h: 0, len: 1300, wid: 28, suf: [0, 0], name: '06/24', als: [false, false], main: true },
    ],
    buildings: [{ t: 1, u: 300, v: -100, w: 40, h: 12, d: 26 }],
  },
  {
    id: 'DRY', name: 'Sundown Dry Lake', short: 'SUNDOWN LAKEBED', icao: 'SLDL',
    desc: 'Vast desert lakebed with painted runways. Miles of flat clay — forgiving for any landing.',
    x: 13000, z: 1000, hdg: 170, elev: null, pad: { hl: 3200, hw: 2000, blend: 900, shape: 'ellipse' },
    rects: [
      { t: 6, u: 0, v: 0, h: 0, len: 6200, wid: 3800 },
      { t: 3, u: -400, v: 500, h: -120, len: 4000, wid: 100, suf: [0, 0], name: '05/23', als: [false, false] },
      { t: 3, u: 0, v: 0, h: 0, len: 5000, wid: 120, suf: [0, 0], name: '17/35', als: [false, false], main: true },
    ],
    buildings: [{ t: 1, u: -2000, v: -1900, w: 70, h: 18, d: 50 }, { t: 1, u: -1900, v: -1900, w: 70, h: 18, d: 50 }, { t: 2, u: -2100, v: -1880, w: 8, h: 30, d: 8 }],
  },
  {
    id: 'MDW', name: 'Willow Meadow Grass Strip', short: 'WILLOW MEADOW', icao: 'SLWM',
    desc: 'Rural grass strip among farm fields and forest. Bumpy, short — bring a light aircraft.',
    x: -12500, z: 5000, hdg: 130, elev: null, pad: { hl: 470, hw: 80, blend: 450 },
    rects: [{ t: 2, u: 0, v: 0, h: 0, len: 780, wid: 30, suf: [0, 0], name: '13/31', als: [false, false], main: true, nolights: true }],
    buildings: [{ t: 5, u: 200, v: -60, w: 24, h: 9, d: 16 }],
  },
  {
    id: 'ISV', name: 'Isla Verde Regional', short: 'ISLA VERDE', icao: 'SLIV',
    desc: 'Island airport surrounded by turquoise shallows. Both ends terminate at the water.',
    x: 16000, z: 15000, hdg: 100, elev: null, minElev: 7, pad: { hl: 1050, hw: 260, blend: 600 },
    rects: [
      { t: 5, u: 100, v: 210, h: 0, len: 380, wid: 120 },
      { t: 4, u: 0, v: 110, h: 0, len: 1900, wid: 20 },
      { t: 4, u: -850, v: 55, h: 90, len: 110, wid: 20 }, { t: 4, u: 850, v: 55, h: 90, len: 110, wid: 20 },
      { t: 0, u: 0, v: 0, h: 0, len: 1900, wid: 40, suf: [0, 0], name: '10/28', als: [false, false], main: true },
    ],
    buildings: [{ t: 0, u: 100, v: 300, w: 160, h: 10, d: 30 }, { t: 2, u: 260, v: 290, w: 8, h: 26, d: 8 }],
  },
];

// Islands / land blobs for terrain generator (x, z, radius, strength)
const ISLANDS = [
  [16000, 15000, 3000, 0.36], [0, 9000, 4500, 0.5], [-9000, -2500, 4000, 0.5], [13000, 1000, 5000, 0.4],
  [-12500, 5000, 2500, 0.4], [4500, 11600, 3000, 0.35], [3500, -10500, 2000, 0.4], [-16500, 15500, 1500, 0.3],
];

const CARRIER_DEF = { x: -6000, z: 17500, hdg: 262, speed: 13, name: 'CVN-79 RESOLUTE' };

function apLocal(ap, u, v) {
  const s = Math.sin(ap.hdg * DEG), c = Math.cos(ap.hdg * DEG);
  return [ap.x + u * s + v * c, ap.z - u * c + v * s];
}

class Carrier {
  constructor(def) {
    this.def = def;
    this.pos = new V3(def.x, 0, def.z);
    this.hdg = def.hdg * DEG; this.speed = def.speed;
    this.deckY = 19.5;
    this.vel = new V3();
    this.q = new Quat().setEuler(this.hdg, 0, 0);
    this.updateVel();
    // deck footprint polygon (u forward, v starboard)
    this.poly = [[178, -5], [120, -19], [72, -42], [-60, -44], [-150, -31], [-162, -24], [-162, 22], [-20, 24], [40, 38], [130, 30], [165, 12]];
    this.island = { u0: -15, u1: 30, v0: 24, v1: 37, h: 32 };
    this.cats = [{ u0: 55, u1: 150, v: 6 }, { u0: 45, u1: 140, v: -8 }];
    // angled deck landing line
    this.angle = -9 * DEG;
    this.ldgStart = [-150, -4];
    this.wires = [52, 64, 76, 88];
  }
  updateVel() { this.vel.set(Math.sin(this.hdg) * this.speed, 0, -Math.cos(this.hdg) * this.speed); }
  update(dt) { this.pos.addScaled(this.vel, dt); }
  toLocal(x, z) {
    const dx = x - this.pos.x, dz = z - this.pos.z, s = Math.sin(this.hdg), c = Math.cos(this.hdg);
    return [dx * s - dz * c, dx * c + dz * s];
  }
  toWorld(u, v, out) {
    const s = Math.sin(this.hdg), c = Math.cos(this.hdg);
    out.x = this.pos.x + u * s + v * c; out.z = this.pos.z - u * c + v * s; return out;
  }
  inPoly(u, v) {
    const P = this.poly; let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const xi = P[i][0], yi = P[i][1], xj = P[j][0], yj = P[j][1];
      if (((yi > v) !== (yj > v)) && (u < (xj - xi) * (v - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  // returns deck height at x,z if over deck else -Infinity; also island collision
  deckAt(x, z) {
    const [u, v] = this.toLocal(x, z);
    if (u < -170 || u > 180 || v < -50 || v > 45) return -Infinity;
    if (!this.inPoly(u, v)) return -Infinity;
    const I = this.island;
    if (u > I.u0 && u < I.u1 && v > I.v0 && v < I.v1) return this.deckY + I.h;
    return this.deckY;
  }
  // hull occupies below the deck within footprint (for crash detection)
  insideHull(x, y, z) {
    if (y > this.deckY + 40) return false;
    const [u, v] = this.toLocal(x, z);
    if (u < -170 || u > 180 || Math.abs(v) > 48) return false;
    if (!this.inPoly(u, v * 1.05)) return false;
    const I = this.island;
    if (u > I.u0 && u < I.u1 && v > I.v0 && v < I.v1) return y < this.deckY + I.h;
    return y < this.deckY - 0.3;
  }
  // position along angled deck: returns [s, lateral]
  angledCoords(x, z) {
    const [u, v] = this.toLocal(x, z);
    const du = u - this.ldgStart[0], dv = v - this.ldgStart[1];
    const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
    return [du * ca + dv * sa, -du * sa + dv * ca];
  }
}

class World {
  constructor() {
    this.terrain = new Terrain();
    this.airports = AIRPORTS;
    this.carrier = new Carrier(CARRIER_DEF);
    this.buildings = [];
    this.lights = [];
    this.runways = [];
    this.trees = null;
  }

  generate() {
    const islands = ISLANDS.slice();
    this.terrain.generate(islands, this.airports);
    // runway / rect world data
    this.rectList = [];
    this.apUniform = new Float32Array(40);
    this.rwA = new Float32Array(160); this.rwB = new Float32Array(160); this.rwC = new Float32Array(160);
    let k = 0;
    this.airports.forEach((ap, ai) => {
      const start = k;
      let rad = 0;
      for (const r of ap.rects) {
        const [x, z] = apLocal(ap, r.u, r.v);
        const hdg = ((ap.hdg + r.h) % 360 + 360) % 360;
        const rr = { ap, def: r, x, z, hdg, hl: r.len / 2, hw: r.wid / 2, t: r.t, s: Math.sin(hdg * DEG), c: Math.cos(hdg * DEG) };
        rr.y = ap.elev;
        if (r.t <= 3) {
          let nA = Math.round(hdg / 10) % 36; if (nA === 0) nA = 36;
          let nB = Math.round(((hdg + 180) % 360) / 10) % 36; if (nB === 0) nB = 36;
          rr.numA = nA; rr.numB = nB; rr.sufA = r.suf ? r.suf[0] : 0; rr.sufB = r.suf ? r.suf[1] : 0;
          this.runways.push(rr);
        }
        this.rectList.push(rr);
        this.rwA.set([x, z, rr.s, -rr.c], k * 4);
        this.rwB.set([rr.hl, rr.hw, r.t, 0], k * 4);
        this.rwC.set([rr.numA || 0, rr.sufA || 0, rr.numB || 0, rr.sufB || 0], k * 4);
        rad = Math.max(rad, Math.hypot(r.u, r.v) + Math.hypot(r.len, r.wid) / 2 + 50);
        k++;
      }
      ap.radius = rad;
      ap.rectStart = start; ap.rectCount = k - start;
      this.apUniform.set([ap.x, ap.z, rad * rad, start * 64 + (k - start)], ai * 4);
    });
    this.rectCount = k;
    this.buildStructures();
    this.terrain.uploadData();
    this.buildLights();
    this.trees = new TreeSystem(this.terrain);
  }

  bindSurfaceUniforms(p) {
    p.set('uRwA', this.rwA); p.set('uRwB', this.rwB); p.set('uRwC', this.rwC);
    p.set('uAp', this.apUniform); p.i('uApCount', this.airports.length);
    const C = this.carrier;
    p.v4('uCarrier', C.pos.x, C.pos.z, Math.sin(C.hdg), Math.cos(C.hdg));
    p.v4('uCarrier2', C.speed, 330, 0, 0);
  }

  // surface at a point: returns {h, type, water}
  surfaceAt(x, z, out) {
    let h = this.terrain.heightAt(x, z);
    out.water = h < 0; out.h = Math.max(h, 0); out.type = out.water ? -1 : (this.terrain.sampleF(this.terrain.M, x, z) < 0.2 ? 7 : 8); // 7 dirt, 8 grass
    for (const ap of this.airports) {
      const dx = x - ap.x, dz = z - ap.z;
      if (dx * dx + dz * dz > ap.radius * ap.radius) continue;
      for (let i = ap.rectStart; i < ap.rectStart + ap.rectCount; i++) {
        const r = this.rectList[i];
        const rx = x - r.x, rz = z - r.z;
        const u = rx * r.s - rz * r.c, v = rx * r.c + rz * r.s;
        if (r.t === 6) { if (Math.hypot(u / r.hl, v / r.hw) < 1) out.type = SURF.LAKE; continue; }
        if (Math.abs(u) <= r.hl && Math.abs(v) <= r.hw) out.type = r.t;
      }
    }
    // carrier deck
    const d = this.carrier.deckAt(x, z);
    if (d > out.h) { out.h = d; out.type = 10; out.water = false; out.carrier = true; } else out.carrier = false;
    return out;
  }

  // ---------- structures ----------
  buildStructures() {
    const B = this.buildings, T = this.terrain;
    for (const ap of this.airports) {
      for (const b of ap.buildings) {
        const [x, z] = apLocal(ap, b.u, b.v);
        B.push([x, ap.elev - 1, z, -ap.hdg * DEG + Math.PI / 2, b.w, b.h + 1, b.d, b.t]);
      }
      // clear trees near runways
      const ext = Math.max(ap.pad.hl, ap.pad.hw) + 300;
      T.clearForest(ap.x - ext * 0.3, ap.z - ext * 0.3, ap.x + ext * 0.3, ap.z + ext * 0.3);
    }
    // the city next to Harbor Point
    const rnd = mulberry32(777);
    const cx = 4600, cz = 11700;
    T.clearForest(cx - 1500, cz - 1100, cx + 1500, cz + 1100);
    for (let bx = -1300; bx <= 1300; bx += 130) for (let bz = -900; bz <= 900; bz += 120) {
      const dist = Math.hypot(bx * 0.8, bz) / 1100;
      if (dist > 1.1 || rnd() < dist * 0.35) continue;
      const n = 2 + (rnd() * 4 | 0);
      for (let i = 0; i < n; i++) {
        const x = cx + bx + (rnd() - 0.5) * 70, z = cz + bz + (rnd() - 0.5) * 70;
        const h0 = T.heightAt(x, z); if (h0 < 2) continue;
        const tall = Math.max(0, 1 - dist);
        const h = 8 + rnd() * 14 + Math.pow(rnd(), 2.5) * 160 * tall * tall;
        const w = 18 + rnd() * 30, d = 18 + rnd() * 30;
        B.push([x, h0 - 2, z, 0, w, h + 2, d, 0]);
      }
    }
    // villages
    const villages = [[-7000, 7500], [-11800, 2200], [-3000, -5200], [9000, 4000], [-4500, 12000], [16600, 15600]];
    for (const [vx, vz] of villages) {
      T.clearForest(vx - 350, vz - 350, vx + 350, vz + 350);
      for (let i = 0; i < 45; i++) {
        const x = vx + (rnd() - 0.5) * 600, z = vz + (rnd() - 0.5) * 600;
        const h0 = T.heightAt(x, z); if (h0 < 2) continue;
        B.push([x, h0 - 1.5, z, rnd() * 3, 8 + rnd() * 10, 6 + rnd() * 6, 8 + rnd() * 10, 5]);
      }
    }
    // radio masts on hills
    for (const [x, z] of [[-6000, -6500], [1500, -4000], [8000, 8000], [-15000, -1500]]) {
      const h0 = T.heightAt(x, z); if (h0 > 2) B.push([x, h0, z, 0, 4, 90, 4, 4]);
    }
  }

  buildLights() {
    const L = this.lights;
    const push = (x, y, z, size, r, g, b, flag = 0, extra = 0) => L.push([x, y, z, Math.round((size - 0.5) * 10) + extra, r, g, b, flag]);
    for (const rw of this.runways) {
      const def = rw.def; if (def.nolights || rw.t === 3) continue;
      const y = rw.y + 0.6;
      const P = (u, v) => [rw.x + u * rw.s + v * rw.c, rw.z - u * rw.c + v * rw.s];
      const wide = rw.hw >= 20;
      // edge lights
      for (let u = -rw.hl; u <= rw.hl + 1; u += 60) for (const sd of [-1, 1]) {
        const [x, z] = P(u, sd * (rw.hw + 1.5)); const yel = rw.hl - Math.abs(u) < 600;
        push(x, y, z, 0.9, 2.2, yel ? 1.6 : 2.0, yel ? 0.6 : 1.7);
      }
      // thresholds
      for (let v = -rw.hw; v <= rw.hw; v += 3) {
        for (const e of [-1, 1]) {
          let [x, z] = P(e * (rw.hl + 2), v); push(x, y, z, 0.9, 0.2, 2.6, 0.6);
          [x, z] = P(e * (rw.hl - 1.5), v); push(x, y, z, 0.7, 2.6, 0.15, 0.1);
        }
      }
      // centerline
      if (wide) for (let u = -rw.hl + 30; u < rw.hl; u += 30) { const [x, z] = P(u, 0); const red = rw.hl - Math.abs(u) < 300; push(x, y - 0.4, z, 0.55, red ? 2.4 : 1.8, red ? 0.3 : 1.8, red ? 0.2 : 1.7); }
      // PAPI at both ends (left side)
      for (const e of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const u = e * (rw.hl - 300), v = e * -(rw.hw + 15 + i * 9);
          const [x, z] = P(u, v); push(x, y + 0.4, z, 1.4, 1, 1, 1, 1, i * 0.1 + 0.01);
        }
      }
      // approach lights + rabbit
      for (const e of [0, 1]) {
        if (!def.als || !def.als[e]) continue;
        const sgn = e === 0 ? -1 : 1;
        for (let d = 30; d <= 900; d += 30) {
          const u = sgn * (rw.hl + d);
          const [cx, cz] = P(u, 0);
          const gh = Math.max(this.terrain.heightAt(cx, cz), 0) + 1.5;
          const yy = Math.max(gh, y + 0.2);
          for (let v = -6; v <= 6; v += 3) { const [x, z] = P(u, v); push(x, yy, z, 0.9, 2.0, 1.8, 1.5); }
          if (d % 300 === 0) for (let v = -15; v <= 15; v += 3) { const [x, z] = P(u, v); push(x, yy, z, 0.8, 2.0, 1.8, 1.5); }
          const [x, z] = P(u, 0); push(x, yy + 0.5, z, 1.8, 3.0, 3.0, 3.2, 2, (d / 900) * 0.99);
        }
      }
    }
    // taxiway edge lights (blue)
    for (const r of this.rectList) {
      if (r.t !== 4) continue;
      const y = r.y + 0.4;
      for (let u = -r.hl; u <= r.hl; u += 50) for (const sd of [-1, 1]) {
        const x = r.x + u * r.s + sd * (r.hw + 1) * r.c, z = r.z - u * r.c + sd * (r.hw + 1) * r.s;
        push(x, y, z, 0.6, 0.2, 0.5, 2.6);
      }
    }
    // tower beacons + obstruction lights
    for (const b of this.buildings) {
      if (b[7] === 2) { push(b[0], b[1] + b[5] + 2, b[2], 2.5, 2.5, 3.0, 2.5, 3); }
      if (b[7] === 4 || (b[7] === 0 && b[5] > 60)) push(b[0], b[1] + b[5] + 1, b[2], 1.6, 3.0, 0.2, 0.1, 3);
    }
  }
}

// ---------------------------------------------------------------------------
// Trees: chunked, generated lazily from forest density, drawn instanced.
// ---------------------------------------------------------------------------
class TreeSystem {
  constructor(terrain) {
    this.t = terrain; this.chunk = 512; this.cache = new Map();
    this.maxDist = 3200; this.density = 1.0;
    this.buf = new Float32Array(6 * 90000); this.count = 0; this.lastKey = '';
  }
  genChunk(cx, cz) {
    const key = cx * 100000 + cz; let c = this.cache.get(key); if (c) return c;
    const T = this.t, S = this.chunk, rnd = mulberry32(key * 2654435761 >>> 0 ^ 0x9e3779b9);
    const arr = [];
    const x0 = cx * S, z0 = cz * S;
    const n = (900 * this.density) | 0;
    const nv = new V3();
    for (let i = 0; i < n; i++) {
      const x = x0 + rnd() * S, z = z0 + rnd() * S;
      const f = T.sampleF(T.F, x, z);
      const m = T.sampleF(T.M, x, z);
      const r = rnd();
      if (r > f * f * 1.2 + m * 0.012) continue;
      const h = T.heightAt(x, z); if (h < 3 || h > 1950) continue;
      T.normalAt(x, z, nv); if (nv.y < 0.8) continue;
      const conifer = h > 700 || rnd() < 0.35;
      const s = (conifer ? 14 : 11) + rnd() * 10;
      arr.push(x, h - 0.5, z, s, conifer ? 0 : 1, rnd());
    }
    c = new Float32Array(arr); this.cache.set(key, c);
    if (this.cache.size > 900) { const k0 = this.cache.keys().next().value; this.cache.delete(k0); }
    return c;
  }
  update(cam, budgetMs = 4) {
    const S = this.chunk, ccx = Math.floor(cam.x / S), ccz = Math.floor(cam.z / S);
    const key = ccx + ',' + ccz + ',' + this.maxDist;
    if (key === this.lastKey && !this.pending) return false;
    // skip at high altitude: trees invisible anyway
    const R = Math.ceil(this.maxDist / S);
    let n = 0; const t0 = performance.now(); this.pending = false;
    const list = [];
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dz) * S - S * 0.7; if (d > this.maxDist) continue;
      list.push([d, ccx + dx, ccz + dz]);
    }
    list.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cz] of list) {
      const k = cx * 100000 + cz;
      if (!this.cache.has(k) && performance.now() - t0 > budgetMs) { this.pending = true; continue; }
      const c = this.genChunk(cx, cz);
      if (n + c.length > this.buf.length) break;
      this.buf.set(c, n); n += c.length;
    }
    this.count = n / 6; this.lastKey = key;
    return true;
  }
}
