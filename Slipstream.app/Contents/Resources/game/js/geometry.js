'use strict';
// ---------------------------------------------------------------------------
// Procedural geometry: aircraft (lofted fuselage, NACA wings with hinged
// control surfaces), missiles, carrier, trees, boxes.
// Vertex layout (15 floats): pos3 nor3 col3 uv2 mat4(metal, rough, part, flags)
// flags: 1 glass, 2 textured, 4 emissive, 8 no-camo
// ---------------------------------------------------------------------------
const MAX_PARTS = 48;
const VLAYOUT = [{ size: 3 }, { size: 3 }, { size: 3 }, { size: 2 }, { size: 4 }];

class MeshBuilder {
  constructor() { this.v = []; this.idx = []; this.n = 0; }
  // grid surface with automatic outward orientation and smooth normals
  grid(R, C, P, outward, o) {
    const pts = [], exp = [];
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { pts.push(P(i, j)); exp.push(outward(i, j, pts[pts.length - 1])); }
    const nrm = pts.map(() => [0, 0, 0]);
    const tris = [];
    const cols = o.wrap ? C : C - 1;
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < cols; j++) {
      const j1 = (j + 1) % C;
      const a = i * C + j, b = i * C + j1, c = (i + 1) * C + j, d = (i + 1) * C + j1;
      tris.push([a, c, b], [b, c, d]);
    }
    const fixed = [];
    for (let t of tris) {
      const [a, b, c] = t, A = pts[a], Bp = pts[b], Cp = pts[c];
      const ux = Bp[0] - A[0], uy = Bp[1] - A[1], uz = Bp[2] - A[2], vx = Cp[0] - A[0], vy = Cp[1] - A[1], vz = Cp[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz); if (l < 1e-10) continue;
      const e = [exp[a][0] + exp[b][0] + exp[c][0], exp[a][1] + exp[b][1] + exp[c][1], exp[a][2] + exp[b][2] + exp[c][2]];
      if (nx * e[0] + ny * e[1] + nz * e[2] < 0) { t = [a, c, b]; nx = -nx; ny = -ny; nz = -nz; }
      fixed.push(t);
      for (const k of t) { nrm[k][0] += nx; nrm[k][1] += ny; nrm[k][2] += nz; }
    }
    const base = this.n;
    for (let k = 0; k < pts.length; k++) {
      let [nx, ny, nz] = nrm[k]; const l = Math.hypot(nx, ny, nz);
      if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { const e = exp[k]; const el = Math.hypot(e[0], e[1], e[2]) || 1; nx = e[0] / el; ny = e[1] / el; nz = e[2] / el; }
      const p = pts[k];
      const col = typeof o.color === 'function' ? o.color(p, [nx, ny, nz]) : o.color;
      const uv = o.uv ? o.uv(p) : [0, 0];
      this.v.push(p[0], p[1], p[2], nx, ny, nz, col[0], col[1], col[2], uv[0], uv[1], o.metal || 0, o.rough === undefined ? 0.5 : o.rough, o.part || 0, o.flags || 0);
    }
    for (const t of fixed) this.idx.push(base + t[0], base + t[1], base + t[2]);
    this.n += pts.length;
  }
  // flat polygon fan (convex), outward = normal hint
  fan(pts, outward, o) {
    const c = [0, 0, 0]; pts.forEach(p => { c[0] += p[0] / pts.length; c[1] += p[1] / pts.length; c[2] += p[2] / pts.length; });
    this.grid(2, pts.length, (i, j) => i === 0 ? c : pts[j], () => outward, Object.assign({}, o, { wrap: true }));
  }
  box(cx, cy, cz, hx, hy, hz, o) {
    const f = (ax, s) => {
      const pts = [];
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        const u = i * 2 - 1, v = j * 2 - 1; let p;
        if (ax === 0) p = [cx + s * hx, cy + u * hy, cz + v * hz]; else if (ax === 1) p = [cx + u * hx, cy + s * hy, cz + v * hz]; else p = [cx + u * hx, cy + v * hy, cz + s * hz];
        pts.push(p);
      }
      const n = [ax === 0 ? s : 0, ax === 1 ? s : 0, ax === 2 ? s : 0];
      this.grid(2, 2, (i, j) => pts[i * 2 + j], () => n, o);
    };
    for (let ax = 0; ax < 3; ax++) { f(ax, 1); f(ax, -1); }
  }
  // cylinder / cone between two points
  tube(p0, p1, r0, r1, seg, o, caps = true) {
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]; const L = Math.hypot(...d) || 1; d[0] /= L; d[1] /= L; d[2] /= L;
    let a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]]; const ul = Math.hypot(...u); u = u.map(x => x / ul);
    const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    const ring = (p, r, j) => { const t = j / seg * Math.PI * 2, c = Math.cos(t) * r, s = Math.sin(t) * r; return [p[0] + u[0] * c + w[0] * s, p[1] + u[1] * c + w[1] * s, p[2] + u[2] * c + w[2] * s]; };
    this.grid(2, seg, (i, j) => ring(i ? p1 : p0, i ? r1 : r0, j), (i, j, p) => { const q = i ? p1 : p0; return [p[0] - q[0], p[1] - q[1], p[2] - q[2]]; }, Object.assign({}, o, { wrap: true }));
    if (caps) {
      if (r0 > 1e-4) this.fan(Array.from({ length: seg }, (_, j) => ring(p0, r0, j)), [-d[0], -d[1], -d[2]], o);
      if (r1 > 1e-4) this.fan(Array.from({ length: seg }, (_, j) => ring(p1, r1, j)), d, o);
    }
  }
  sphere(c, rx, ry, rz, seg, o) {
    const R = seg / 2 + 1;
    this.grid(R, seg, (i, j) => { const th = i / (R - 1) * Math.PI, ph = j / seg * Math.PI * 2; return [c[0] + Math.sin(th) * Math.cos(ph) * rx, c[1] + Math.cos(th) * ry, c[2] + Math.sin(th) * Math.sin(ph) * rz]; },
      (i, j, p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]], Object.assign({}, o, { wrap: true }));
  }
  build() {
    return { data: new Float32Array(this.v), idx: new Uint32Array(this.idx) };
  }
}

// superellipse ring point
function seRing(hw, hh, yc, sq, t) {
  const c = Math.cos(t), s = Math.sin(t), e = 2 / sq;
  return [hw * Math.sign(c) * Math.pow(Math.abs(c), e), yc + hh * Math.sign(s) * Math.pow(Math.abs(s), e)];
}

// NACA 4-digit-ish profile
function airfoil(x, t, m, p = 0.4) {
  const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
  const yc = m <= 0 ? 0 : (x < p ? m / (p * p) * (2 * p * x - x * x) : m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * x - x * x));
  return [yc, yt];
}

// span breakpoints shared by mesh and aero
function surfaceSegments(sf) {
  const bp = new Set([0, 1]);
  (sf.controls || []).forEach(c => { bp.add(c.s0); bp.add(c.s1); });
  let arr = [...bp].sort((a, b) => a - b);
  // subdivide wide segments on main wings for spanwise resolution
  const maxW = sf.kind === 'wing' ? 0.36 : 1.0;
  const out = [];
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1]; const n = Math.max(1, Math.ceil((b - a) / maxW - 1e-6));
    for (let k = 0; k < n; k++) out.push([a + (b - a) * k / n, a + (b - a) * (k + 1) / n]);
  }
  return out.filter(s => s[1] - s[0] > 0.01).map(([a, b]) => ({ e0: a, e1: b, controls: (sf.controls || []).filter(c => c.s0 <= a + 1e-6 && c.s1 >= b - 1e-6) }));
}

// geometry frame of a surface at span fraction eta for side (+1 right, -1 left)
function surfaceFrame(sf, eta, side) {
  const span = sf.span, vert = sf.kind === 'vtail';
  const dih = (sf.dihedral || 0) * DEG, cant = (sf.cant || 0) * DEG;
  let sd;
  if (vert) sd = [Math.sin(cant) * side, Math.cos(cant), 0];
  else if (sf.kind === 'body') sd = [side, 0, 0];
  else sd = [Math.cos(dih) * side, Math.sin(dih), 0];
  let chord;
  if (sf.planform === 'ellipse') chord = sf.tc + (sf.rc - sf.tc) * Math.sqrt(Math.max(0, 1 - eta * eta));
  else chord = sf.rc + (sf.tc - sf.rc) * eta;
  const inc = ((sf.incidence || 0) + (sf.twist || 0) * eta) * DEG;
  const rootX = sf.root[0] * (vert && !sf.mirror ? 1 : side), rootY = sf.root[1], rootZ = -sf.root[2];
  let sweepOff = eta * span * Math.tan((sf.sweep || 0) * DEG);
  if (sf.planform === 'ellipse') sweepOff += (sf.rc - chord) * 0.25;
  const le = [rootX + sd[0] * eta * span, rootY + sd[1] * eta * span, rootZ + sweepOff];
  // chord dir (LE->TE) with incidence, thickness normal
  let cd = [0, -Math.sin(inc), Math.cos(inc)];
  // normal = cd x sd oriented "up" (or +x for fins)
  let n = [cd[1] * sd[2] - cd[2] * sd[1], cd[2] * sd[0] - cd[0] * sd[2], cd[0] * sd[1] - cd[1] * sd[0]];
  const nl = Math.hypot(...n); n = n.map(v => v / nl);
  if (vert) { if (n[0] * (sf.mirror ? side : 1) < 0) n = n.map(v => -v); }
  else if (n[1] < 0) n = n.map(v => -v);
  return { le, cd, n, sd, chord };
}

// ---------------------------------------------------------------------------
function buildAircraft(spec) {
  const B = new MeshBuilder();
  const parts = [{ kind: 'static' }];
  const P = spec.paint;
  const metal = P.metal || 0.2, rough = P.rough || 0.5;
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const fus = spec.fuselage;
  const sNose = fus[0][0], sTail = fus[fus.length - 1][0];
  const fusAt = (s) => {
    for (let i = 0; i < fus.length - 1; i++) {
      const a = fus[i], b = fus[i + 1];
      if (s <= a[0] && s >= b[0]) { const t = (a[0] - s) / (a[0] - b[0]); return a.map((v, k) => v + (b[k] - v) * t); }
    }
    return s > sNose ? fus[0] : fus[fus.length - 1];
  };
  // livery
  const paint = (p, n, kind) => {
    const s = -p[2];
    let c = mix3(P.base, P.under, smooth(0.25, -0.35, n[1]));
    const st = P.stripe || 0;
    if (kind === 'fus') {
      const f = fusAt(s); const yr = (p[1] - f[3]) / Math.max(f[2], 0.05);
      if (st === 1 && yr > -0.18 && yr < 0.0) c = P.accent;
      if (st === 2 && yr < -0.2) c = P.accent;
      if (st === 3) { if (s > sNose - 0.9) c = P.accent; if (yr > 0.55 && s > 0.2 && s < sNose - 0.9) c = P.accent2; }
      if (st === 4) { if (yr < -0.35) c = P.accent; if (yr > 0.18 && yr < 0.3 && s < sNose - 3.5 && s > sTail + 4) c = [0.1, 0.12, 0.15]; if (yr > 0.3 && yr < 0.36) c = P.accent; }
      if (st === 5 && s > sNose - 0.5) c = P.accent;
    } else if (kind === 'wing') {
      const ax = Math.abs(p[0]);
      if (st === 1 && ax > 4.9) c = P.accent;
      if (st === 2 && n[1] > 0) { const a = Math.atan2(p[2] + 1.0, ax); c = (Math.floor(a * 6 + 10) & 1) ? P.accent : P.accent2; }
      if (st === 5 && ax > 8.0) c = P.accent;
      if (st === 3 && n[1] > 0.3 && ax < 0.9) c = P.accent2;
    } else if (kind === 'fin') {
      if (st === 1 && p[1] > 1.6) c = P.accent;
      if (st === 2) c = P.accent2;
      if (st === 4) c = P.accent;
      if (st === 3 && p[1] > 1.3) c = P.accent;
    } else if (kind === 'pod') {
      if (st === 4) c = P.accent;
    }
    return c;
  };
  const RING = 24;
  // ---- fuselage ----
  const fusPts = fus.map(f => f);
  B.grid(fusPts.length, RING, (i, j) => { const f = fusPts[i]; const [x, y] = seRing(f[1], f[2], f[3], f[4], j / RING * Math.PI * 2); return [x, y, -f[0]]; },
    (i, j, p) => [p[0], p[1] - fusPts[i][3], 0], { wrap: true, color: (p, n) => paint(p, n, 'fus'), metal, rough });
  // tail cap
  const lf = fus[fus.length - 1];
  if (lf[1] > 0.05) B.fan(Array.from({ length: RING }, (_, j) => { const [x, y] = seRing(lf[1], lf[2], lf[3], lf[4], j / RING * Math.PI * 2); return [x, y, -lf[0]]; }), [0, 0, 1], { color: [0.08, 0.08, 0.09], metal: 0.6, rough: 0.5 });
  // ---- pods (intakes, nacelles, radiators, window bands) ----
  for (const pod of spec.pods || []) {
    const sides = pod.mirror ? [1, -1] : [1];
    for (const sd of sides) {
      const px = (pod.x || 0) * sd;
      const pts = pod.pts;
      B.grid(pts.length, 16, (i, j) => { const f = pts[i]; const [x, y] = seRing(f[1], f[2], f[3], f[4], j / 16 * Math.PI * 2); return [px + x, y, -f[0]]; },
        (i, j, p) => [p[0] - px, p[1] - pts[i][3], 0],
        pod.glass ? { wrap: true, color: [0.05, 0.07, 0.09], flags: 1, metal: 0, rough: 0.05 } : { wrap: true, color: (p, n) => paint(p, n, 'pod'), metal, rough });
      const f0 = pts[0], f1 = pts[pts.length - 1];
      if (!pod.glass) {
        B.fan(Array.from({ length: 16 }, (_, j) => { const [x, y] = seRing(f0[1] * 0.85, f0[2] * 0.85, f0[3], f0[4], j / 16 * Math.PI * 2); return [px + x, y, -f0[0] + 0.02]; }), [0, 0, -1], { color: [0.03, 0.03, 0.035], rough: 0.9 });
        B.fan(Array.from({ length: 16 }, (_, j) => { const [x, y] = seRing(f1[1], f1[2], f1[3], f1[4], j / 16 * Math.PI * 2); return [px + x, y, -f1[0]]; }), [0, 0, 1], { color: [0.06, 0.06, 0.06], metal: 0.5 });
      }
    }
  }
  // ---- canopy ----
  if (spec.canopy) {
    const c = spec.canopy, N = 14, M = 12;
    const col = c.gold ? [0.32, 0.26, 0.12] : [0.04, 0.05, 0.06];
    B.grid(N, M + 1, (i, j) => {
      const t = i / (N - 1); const s = c.s0 + (c.s1 - c.s0) * t;
      const f = Math.pow(Math.max(0, 1 - Math.pow(2 * t - 1, 2)), 0.45) * (t < 0.5 ? 1 : 1);
      const ph = j / M * Math.PI;
      const fz = fusAt(s); const base = fz[3] + fz[2] * 0.6;
      return [Math.cos(ph) * c.hw * Math.max(f, 0.02), Math.max(base, c.y - 0.15) + Math.sin(ph) * c.hh * f, -s];
    }, (i, j, p) => [p[0], p[1] - c.y + 0.3, 0], { color: col, flags: 1, metal: 0.0, rough: 0.05 });
  }
  // ---- surfaces ----
  const NCH = 12;
  const xs = Array.from({ length: NCH + 1 }, (_, i) => (1 - Math.cos(Math.PI * i / NCH)) / 2);
  const roundels = [];
  const surfInfo = [];
  for (const sf of spec.surfaces) {
    if (sf.kind === 'body') continue;
    const sides = sf.mirror ? [1, -1] : [1];
    const segs = surfaceSegments(sf);
    const kind = sf.kind === 'vtail' ? 'fin' : 'wing';
    for (const side of sides) {
      // all-moving surface: one part for the whole surface
      let amPart = 0;
      if (sf.allMoving) {
        const f0 = surfaceFrame(sf, 0, side), f1 = surfaceFrame(sf, 1, side);
        const h = sf.allMoving.hinge;
        const pv = [f0.le[0] + f0.cd[0] * f0.chord * h, f0.le[1] + f0.cd[1] * f0.chord * h, f0.le[2] + f0.cd[2] * f0.chord * h];
        let ax = f0.sd.slice();
        amPart = parts.length;
        parts.push({ kind: 'surface', ctl: sf.kind === 'canard' ? 'canard' : 'stab', surf: sf.id, side, pivot: pv, axis: ax, n: f0.n, cdir: f0.cd, max: sf.allMoving.max });
      }
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const ctl = seg.controls.find(c => c.kind !== 'spoiler');
        const spl = seg.controls.find(c => c.kind === 'spoiler');
        const cut = ctl ? 1 - ctl.cf : 1;
        const segPart = amPart || parts.length;
        if (!amPart) parts.push({ kind: 'segment', surf: sf.id, side, seg: si });
        const NS = 3;
        const pt = (eta, x, up) => {
          const F = surfaceFrame(sf, eta, side);
          const [yc, yt] = airfoil(x, sf.thick || 0.1, sf.camber || 0);
          const off = (yc + (up ? yt : -yt)) * F.chord;
          return [F.le[0] + F.cd[0] * x * F.chord + F.n[0] * off, F.le[1] + F.cd[1] * x * F.chord + F.n[1] * off, F.le[2] + F.cd[2] * x * F.chord + F.n[2] * off];
        };
        const nOut = (eta, up) => { const F = surfaceFrame(sf, eta, side); return up ? F.n : F.n.map(v => -v); };
        const piece = (x0, x1, part) => {
          const ix = xs.map(x => x0 + (x1 - x0) * x);
          for (const up of [true, false]) {
            B.grid(NS, ix.length, (i, j) => pt(seg.e0 + (seg.e1 - seg.e0) * i / (NS - 1), ix[j], up), (i) => nOut(seg.e0 + (seg.e1 - seg.e0) * i / (NS - 1), up),
              { color: (p, n) => paint(p, n, kind), metal, rough, part });
          }
          // spanwise caps at root / tip of segment if at ends
          for (const eta of [seg.e0, seg.e1]) {
            if (eta > 1e-4 && eta < 0.9999) continue;
            const F = surfaceFrame(sf, eta, side);
            const ring = []; ix.forEach(x => ring.push(pt(eta, x, true))); for (let j = ix.length - 1; j >= 0; j--) ring.push(pt(eta, ix[j], false));
            const o = eta < 0.5 ? F.sd.map(v => -v) : F.sd;
            B.fan(ring, o, { color: (p, n) => paint(p, n, kind), metal, rough, part });
          }
          // chordwise caps at cut lines
          for (const xc of [x0, x1]) {
            if (xc < 1e-3 || xc > 0.999) continue;
            const ring = [];
            for (let i = 0; i < NS; i++) ring.push(pt(seg.e0 + (seg.e1 - seg.e0) * i / (NS - 1), xc, true));
            for (let i = NS - 1; i >= 0; i--) ring.push(pt(seg.e0 + (seg.e1 - seg.e0) * i / (NS - 1), xc, false));
            const F = surfaceFrame(sf, (seg.e0 + seg.e1) / 2, side);
            B.fan(ring, xc === x0 ? F.cd.map(v => -v) : F.cd, { color: [0.2, 0.2, 0.2], metal, rough: 0.6, part });
          }
        };
        piece(0, cut, segPart);
        if (ctl) {
          const a = pt(seg.e0, cut, true), b = pt(seg.e0, cut, false), c2 = pt(seg.e1, cut, true), d = pt(seg.e1, cut, false);
          const pv = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], pv2 = [(c2[0] + d[0]) / 2, (c2[1] + d[1]) / 2, (c2[2] + d[2]) / 2];
          let ax = [pv2[0] - pv[0], pv2[1] - pv[1], pv2[2] - pv[2]]; const l = Math.hypot(...ax); ax = ax.map(v => v / l);
          const F = surfaceFrame(sf, (seg.e0 + seg.e1) / 2, side);
          const cp = amPart || parts.length;
          if (!amPart) parts.push({ kind: 'control', ctl: ctl.kind, surf: sf.id, side, seg: si, pivot: pv, axis: ax, n: F.n, cdir: F.cd, max: ctl.max, cf: ctl.cf });
          piece(cut, 1, cp);
        }
        if (spl) {
          // spoiler plate on upper surface
          const x0 = 0.5, x1 = 0.5 + spl.cf;
          const sp = parts.length;
          const a = pt(seg.e0, x0, true), c2 = pt(seg.e1, x0, true);
          let ax = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]]; const l = Math.hypot(...ax); ax = ax.map(v => v / l);
          const F = surfaceFrame(sf, (seg.e0 + seg.e1) / 2, side);
          parts.push({ kind: 'control', ctl: 'spoiler', surf: sf.id, side, seg: si, pivot: a, axis: ax, n: F.n, cdir: F.cd, max: spl.max, cf: spl.cf });
          B.grid(2, 4, (i, j) => { const e = seg.e0 + (seg.e1 - seg.e0) * i; const p = pt(e, x0 + (x1 - x0) * j / 3, true); const Fi = surfaceFrame(sf, e, side); return [p[0] + Fi.n[0] * 0.012, p[1] + Fi.n[1] * 0.012, p[2] + Fi.n[2] * 0.012]; },
            () => F.n, { color: (p, n) => paint(p, n, kind), metal, rough, part: sp });
        }
      }
      // roundel placement on main wings
      if (sf.kind === 'wing' && P.roundel && roundels.length < 4) {
        const F = surfaceFrame(sf, 0.72, side);
        const cx = F.le[0] + F.cd[0] * F.chord * 0.45, cz = F.le[2] + F.cd[2] * F.chord * 0.45;
        const r = Math.min(F.chord * 0.36, sf.span * 0.14);
        roundels.push([cx, cz, r, 1]);
        if (roundels.length < 4) roundels.push([cx, cz, r, -1]);
      }
      surfInfo.push({ sf, side });
    }
  }
  // ---- beams (struts, gun barrel, pylons) ----
  for (const b of spec.beams || []) B.tube([b[0], b[1], -b[2]], [b[3], b[4], -b[5]], b[6], b[6], 8, { color: P.base, metal, rough });
  // ---- engine / prop ----
  const E = spec.engine;
  let propPart = 0, bladePart = 0;
  if (E.type === 'prop') {
    const [px, py, ps] = E.pos; const R = E.dia / 2, spR = Math.max(0.16, R * 0.13);
    propPart = parts.length; parts.push({ kind: 'prop', pivot: [px, py, -ps], axis: [0, 0, -1] });
    bladePart = parts.length; parts.push({ kind: 'blades', pivot: [px, py, -ps], axis: [0, 0, -1] });
    B.tube([px, py, -ps + 0.05], [px, py, -ps - spR * 2.6], spR, 0.01, 16, { color: P.accent || P.base, metal: 0.4, rough: 0.3, part: propPart, flags: 8 });
    for (let k = 0; k < E.blades; k++) {
      const a = k / E.blades * Math.PI * 2;
      const dir = [Math.cos(a), Math.sin(a), 0];
      const tw = [-Math.sin(a), Math.cos(a), 0];
      const pts = [];
      const NB = 6;
      B.grid(NB, 4, (i, j) => {
        const r = spR * 0.8 + (R - spR * 0.8) * i / (NB - 1);
        const ch = R * 0.16 * (1 - 0.55 * (i / (NB - 1)) * (i / (NB - 1))) * (i === 0 ? 0.6 : 1);
        const twist = (0.9 - 0.6 * i / (NB - 1));
        const cc = Math.cos(twist), ss = Math.sin(twist);
        const u = [(j === 0 || j === 3) ? -0.5 : 0.5, (j < 2) ? 0.04 : -0.04];
        const lx = u[0] * ch, lt = u[1] * ch;
        const cx = lx * cc - lt * ss, cz = lx * ss + lt * cc;
        return [px + dir[0] * r + tw[0] * cx, py + dir[1] * r + tw[1] * cx, -ps + 0.1 + cz];
      }, (i, j) => [0, 0, j < 2 ? -1 : 1], { wrap: true, color: [0.06, 0.06, 0.06], metal: 0.3, rough: 0.5, part: bladePart, flags: 8 });
    }
  }
  const nozzlePart = [];
  if (E.type === 'jet') {
    for (const nz of E.nozzles) {
      const [x, y, s, r] = nz;
      const np = E.tvc ? parts.length : 0;
      if (E.tvc) parts.push({ kind: 'nozzle', pivot: [x, y, -s - 0.1], axis: [1, 0, 0] });
      nozzlePart.push(np);
      B.tube([x, y, -s - 0.05], [x, y, -s + 0.75], r * 1.02, r * 0.88, 20, { color: [0.22, 0.21, 0.2], metal: 0.85, rough: 0.35, part: np, flags: 8 }, false);
      B.tube([x, y, -s + 0.7], [x, y, -s + 0.2], r * 0.86, r * 0.6, 20, { color: [0.05, 0.04, 0.04], metal: 0.5, rough: 0.6, part: np, flags: 8 }, true);
    }
  }
  // ---- landing gear ----
  const gearParts = [];
  for (const leg of spec.gear.legs) {
    const gp = parts.length;
    const top = leg.from ? [leg.from[0], leg.from[1], -leg.from[2]] : [leg.p[0], leg.p[1], -leg.p[2]];
    const wc = [leg.p[0], leg.p[1] - leg.len, -leg.p[2]];
    parts.push({ kind: 'gear', pivot: top, axis: leg.fold || [1, 0, 0], ang: (leg.foldAng || 0) * DEG, leg });
    gearParts.push(gp);
    const sr = Math.max(0.035, leg.r * 0.22);
    B.tube(top, [wc[0], wc[1] + leg.r * 0.3, wc[2]], sr, sr * 0.9, 8, { color: [0.75, 0.75, 0.75], metal: 0.8, rough: 0.3, part: gp, flags: 8 });
    const ww = leg.r * 0.38;
    const wheels = leg.double ? [-ww * 1.3, ww * 1.3] : [0];
    for (const off of wheels) {
      B.tube([wc[0] + off - ww, wc[1], wc[2]], [wc[0] + off + ww, wc[1], wc[2]], leg.r, leg.r, 16, { color: [0.05, 0.05, 0.05], metal: 0, rough: 0.9, part: gp, flags: 8 });
      B.tube([wc[0] + off - ww * 1.02, wc[1], wc[2]], [wc[0] + off + ww * 1.02, wc[1], wc[2]], leg.r * 0.55, leg.r * 0.55, 12, { color: [0.6, 0.6, 0.62], metal: 0.8, rough: 0.3, part: gp, flags: 8 }, true);
    }
  }
  // ---- tail hook ----
  const tailS = fus[fus.length - 1][0];
  const hookPivot = [0, fus[fus.length - 1][3] - fus[fus.length - 1][2] * 0.7, -(tailS + 1.6)];
  const hookPart = parts.length; parts.push({ kind: 'hook', pivot: hookPivot, axis: [1, 0, 0] });
  B.tube(hookPivot, [hookPivot[0], hookPivot[1] - 0.05, hookPivot[2] + 1.6], 0.035, 0.03, 6, { color: [0.85, 0.75, 0.1], metal: 0.4, rough: 0.5, part: hookPart, flags: 8 });
  // ---- hardpoints (missiles) ----
  const hardParts = [];
  for (const h of spec.hard || []) {
    const hp = parts.length; parts.push({ kind: 'missile', t: h.t });
    hardParts.push({ part: hp, t: h.t, pos: [h.p[0], h.p[1], -h.p[2]] });
    addMissileGeom(B, [h.p[0], h.p[1] - (h.t === 'ir' ? 0.1 : 0.13), -h.p[2]], h.t, hp);
    B.box(h.p[0], h.p[1] + 0.02, -h.p[2], 0.03, 0.06, h.t === 'ir' ? 1.0 : 1.2, { color: [0.4, 0.42, 0.44], metal: 0.3, rough: 0.6, flags: 8 });
  }
  // ---- cockpit interior + pilot ----
  const ck = spec.cockpit;
  const helmetPart = parts.length; parts.push({ kind: 'helmet' });
  B.sphere([ck[0], ck[1] + 0.02, -ck[2] + 0.06], 0.14, 0.15, 0.16, 12, { color: [0.15, 0.16, 0.14], metal: 0.1, rough: 0.6, part: helmetPart, flags: 8 });
  B.box(ck[0], ck[1] - 0.32, -ck[2] - 0.75, 0.36, 0.14, 0.12, { color: [0.07, 0.075, 0.08], metal: 0.1, rough: 0.8, flags: 8 });
  B.box(ck[0] - 0.17, ck[1] - 0.3, -ck[2] - 0.62, 0.09, 0.07, 0.005, { color: [0.12, 0.55, 0.3], flags: 12 });
  B.box(ck[0] + 0.17, ck[1] - 0.3, -ck[2] - 0.62, 0.09, 0.07, 0.005, { color: [0.12, 0.45, 0.6], flags: 12 });

  // ---- derived info ----
  let maxR = 0;
  for (let i = 0; i < B.v.length; i += 15) maxR = Math.max(maxR, Math.hypot(B.v[i], B.v[i + 1], B.v[i + 2]));
  const contacts = [];
  contacts.push([0, fus[0][3], -sNose]);
  contacts.push([0, lf[3] - lf[2], -sTail]);
  contacts.push([0, fusAt(0)[3] - fusAt(0)[2], 0]);
  contacts.push([0, fusAt(0)[3] + fusAt(0)[2], 0]);
  if (spec.canopy) contacts.push([0, spec.canopy.y + spec.canopy.hh, -(spec.canopy.s0 + spec.canopy.s1) / 2]);
  let wingSpan = 0, wingChord = 1, wingS = 0;
  for (const sf of spec.surfaces) {
    if (sf.kind === 'body' || sf.kind === 'lerx') continue;
    for (const side of (sf.mirror ? [1, -1] : [1])) {
      const F = surfaceFrame(sf, 1, side);
      contacts.push([F.le[0], F.le[1], F.le[2]]);
      contacts.push([F.le[0] + F.cd[0] * F.chord, F.le[1] + F.cd[1] * F.chord, F.le[2] + F.cd[2] * F.chord]);
      if (sf.kind === 'wing') { wingSpan = Math.max(wingSpan, Math.abs(F.le[0])); wingChord = (sf.rc + sf.tc) / 2; wingS = -(F.le[2] + sf.root[2] * -1) / 2; }
    }
  }
  for (const pod of spec.pods || []) if (!pod.glass) for (const sd of (pod.mirror ? [1, -1] : [1])) {
    const mid = pod.pts[1]; contacts.push([(pod.x || 0) * sd, mid[3] - mid[2], -mid[0]]);
  }
  const wingSurf = spec.surfaces.find(s => s.kind === 'wing');
  const wingRootS = wingSurf.root[2] - wingSurf.rc * 0.4;
  const hit = [
    { a: [0, 0, -sNose * 0.9], b: [0, 0, -sTail * 0.9], r: Math.max(...fus.map(f => Math.max(f[1], f[2]))) * 1.05 },
    { a: [-wingSpan, wingSurf.root[1], -wingRootS + wingSpan * Math.tan((wingSurf.sweep || 0) * DEG) * 0.5], b: [wingSpan, wingSurf.root[1], -wingRootS + wingSpan * Math.tan((wingSurf.sweep || 0) * DEG) * 0.5], r: wingChord * 0.35 },
  ];
  const mesh = B.build();
  return { mesh, parts, roundels, contacts, hit, radius: maxR, propPart, bladePart, gearParts, hookPart, hardParts, nozzlePart, helmetPart, wingSpan, length: sNose - sTail };
}

function addMissileGeom(B, c, t, part) {
  const L = t === 'ir' ? 2.9 : 3.65, r = t === 'ir' ? 0.064 : 0.088;
  const z0 = c[2] - L * 0.5, z1 = c[2] + L * 0.5;
  const body = { color: [0.88, 0.88, 0.86], metal: 0.2, rough: 0.4, part, flags: 8 };
  B.tube([c[0], c[1], z1], [c[0], c[1], z0 + r * 3], r, r, 10, body, false);
  B.tube([c[0], c[1], z0 + r * 3], [c[0], c[1], z0], r, 0.005, 10, { color: t === 'ir' ? [0.25, 0.3, 0.35] : [0.85, 0.85, 0.82], metal: 0.4, rough: 0.2, part, flags: 8 }, false);
  B.fan(Array.from({ length: 10 }, (_, j) => [c[0] + Math.cos(j / 10 * 6.283) * r, c[1] + Math.sin(j / 10 * 6.283) * r, z1]), [0, 0, 1], { color: [0.1, 0.1, 0.1], part, flags: 8 });
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4, dx = Math.cos(a), dy = Math.sin(a);
    B.box(c[0] + dx * r * 2.2, c[1] + dy * r * 2.2, z1 - 0.18, Math.abs(dx) * r * 1.4 + 0.004, Math.abs(dy) * r * 1.4 + 0.004, 0.16, { color: [0.8, 0.8, 0.78], part, flags: 8 });
    if (t === 'ir') B.box(c[0] + dx * r * 1.8, c[1] + dy * r * 1.8, z0 + 0.45, Math.abs(dx) * r * 0.9 + 0.003, Math.abs(dy) * r * 0.9 + 0.003, 0.07, { color: [0.8, 0.8, 0.78], part, flags: 8 });
  }
  // yellow band
  B.tube([c[0], c[1], z0 + 0.7], [c[0], c[1], z0 + 0.78], r * 1.01, r * 1.01, 10, { color: [0.85, 0.7, 0.1], part, flags: 8 }, false);
}

function buildMissileMesh(t) {
  const B = new MeshBuilder();
  addMissileGeom(B, [0, 0, 0], t, 0);
  return B.build();
}

// ---------------------------------------------------------------------------
function buildCarrierMesh(C) {
  const B = new MeshBuilder();
  const hull = [0.32, 0.34, 0.36], deckC = [1, 1, 1];
  const dy = C.deckY;
  // hull: loft along u with stations [u, halfWidth at deck, halfWidth at waterline, keel depth]
  const st = [[180, 2, 0.5, -2], [165, 14, 3, -9], [130, 22, 15, -11], [60, 25, 19, -12], [-60, 25, 19, -12], [-150, 23, 16, -10], [-163, 20, 12, -6]];
  const RING = 14;
  B.grid(st.length, RING, (i, j) => {
    const [u, wd, ww, k] = st[i];
    const t = j / (RING - 1);
    // cross-section from deck edge (starboard) down to keel and up to port deck edge
    const a = t * Math.PI;
    const y = dy - 1 - Math.sin(a) * (dy - 1 - k);
    const wdth = lerp(wd, ww, Math.pow(Math.sin(a), 0.7)) * Math.cos(a);
    return [wdth, y, -u];
  }, (i, j, p) => [p[0], p[1] - 5, 0], { color: (p) => p[1] < 1.5 ? [0.35, 0.12, 0.1] : hull, metal: 0.2, rough: 0.7 });
  // deck slab from polygon
  const poly = C.poly;
  const top = poly.map(([u, v]) => [v, dy, -u]);
  const bot = poly.map(([u, v]) => [v, dy - 2.2, -u]);
  // top face triangulated as fan from centroid (polygon nearly convex)
  const uvf = (p) => [(-p[2] + 170) / 350, (p[0] + 50) / 100];
  B.grid(2, poly.length, (i, j) => i === 0 ? [0, dy, 0] : top[j], () => [0, 1, 0], { wrap: true, color: deckC, metal: 0, rough: 0.85, flags: 2 | 8, uv: uvf });
  B.grid(2, poly.length, (i, j) => i === 0 ? top[j] : bot[j], (i, j, p) => [p[0], 0, p[2]], { wrap: true, color: hull, metal: 0.2, rough: 0.7 });
  // island
  const I = C.island;
  const ic = [(I.v0 + I.v1) / 2, 0, -(I.u0 + I.u1) / 2];
  B.box(ic[0], dy + I.h * 0.35, ic[2], (I.v1 - I.v0) / 2, I.h * 0.35, (I.u1 - I.u0) / 2, { color: [0.38, 0.4, 0.42], metal: 0.2, rough: 0.6 });
  B.box(ic[0], dy + I.h * 0.85, ic[2] - 3, (I.v1 - I.v0) / 2 - 2, I.h * 0.15, (I.u1 - I.u0) / 2 - 6, { color: [0.35, 0.37, 0.4], metal: 0.2, rough: 0.6 });
  B.box(ic[0] - 4.8, dy + I.h * 0.78, ic[2] - 5, 0.4, 1.5, 9, { color: [0.05, 0.08, 0.1], flags: 1, rough: 0.05 });
  B.tube([ic[0], dy + I.h, ic[2]], [ic[0], dy + I.h + 18, ic[2]], 0.6, 0.3, 8, { color: [0.4, 0.4, 0.42] });
  B.box(ic[0], dy + I.h + 12, ic[2], 5, 0.4, 0.4, { color: [0.4, 0.4, 0.42] });
  B.box(ic[0] - 1, dy + I.h + 4, ic[2] + 6, 3, 2.2, 0.3, { color: [0.3, 0.32, 0.34] });
  return B.build();
}

function carrierDeckTexture(C) {
  const W = 2048, H = 600;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const U = u => (u + 170) / 350 * W, V = v => (v + 50) / 100 * H;
  g.fillStyle = '#3b3d40'; g.fillRect(0, 0, W, H);
  // non-skid noise
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  // angled deck lines
  const ca = Math.cos(C.angle), sa = Math.sin(C.angle);
  const A = (s, l) => [C.ldgStart[0] + s * ca - l * sa, C.ldgStart[1] + s * sa + l * ca];
  g.lineWidth = 4; g.strokeStyle = '#e8e4d0';
  for (const l of [-11, 11]) { g.beginPath(); const p0 = A(0, l), p1 = A(230, l); g.moveTo(U(p0[0]), V(p0[1])); g.lineTo(U(p1[0]), V(p1[1])); g.stroke(); }
  g.setLineDash([22, 18]); g.lineWidth = 3; g.strokeStyle = '#e8e4d0';
  { g.beginPath(); const p0 = A(0, 0), p1 = A(230, 0); g.moveTo(U(p0[0]), V(p0[1])); g.lineTo(U(p1[0]), V(p1[1])); g.stroke(); }
  g.setLineDash([]);
  // foul line (red/white)
  g.lineWidth = 6; g.strokeStyle = '#c8302a'; g.setLineDash([14, 14]);
  { g.beginPath(); g.moveTo(U(-162), V(-14)); g.lineTo(U(175), V(-14 - 337 * 0.02)); g.stroke(); }
  g.setLineDash([]);
  // wires
  g.lineWidth = 3; g.strokeStyle = '#1a1a1a';
  for (const w of C.wires) { const p0 = A(w, -14), p1 = A(w, 14); g.beginPath(); g.moveTo(U(p0[0]), V(p0[1])); g.lineTo(U(p1[0]), V(p1[1])); g.stroke(); }
  // catapults
  g.lineWidth = 3; g.strokeStyle = '#9a9a92';
  for (const c of C.cats) { g.beginPath(); g.moveTo(U(c.u0), V(c.v)); g.lineTo(U(c.u1), V(c.v)); g.stroke(); g.fillStyle = '#d8c040'; g.fillRect(U(c.u0) - 6, V(c.v) - 8, 12, 16); }
  // bow centerline + number
  g.setLineDash([18, 14]); g.strokeStyle = '#e8e4d0'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(U(20), V(0)); g.lineTo(U(175), V(0)); g.stroke(); g.setLineDash([]);
  g.save(); g.translate(U(140), V(-2)); g.rotate(Math.PI / 2); g.fillStyle = '#e8e4d0'; g.font = 'bold 120px Helvetica, Arial'; g.textAlign = 'center'; g.fillText('79', 0, 40); g.restore();
  // landing area threshold stripes
  g.fillStyle = '#e8e4d0';
  for (let l = -10; l <= 10; l += 4) { const p = A(4, l); g.fillRect(U(p[0]) - 6, V(p[1]) - 4, 18, 8); }
  // edge lines
  g.strokeStyle = '#d9d2b0'; g.lineWidth = 3; g.beginPath();
  C.poly.forEach(([u, v], i) => { const x = U(u), y = V(v); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }); g.closePath(); g.stroke();
  const t = makeTex(W, H, { data: cv, mips: true, aniso: 8, wrap: gl.CLAMP_TO_EDGE });
  return t;
}

// ---------------------------------------------------------------------------
function buildTreeMesh() {
  const v = [], idx = []; let n = 0;
  const cone = (y0, y1, r0, r1, seg, part) => {
    const base = n;
    for (let i = 0; i <= 1; i++) for (let j = 0; j < seg; j++) {
      const a = j / seg * Math.PI * 2, y = i ? y1 : y0, r = i ? r1 : r0;
      const slope = (r0 - r1) / (y1 - y0);
      const nx = Math.cos(a), nz = Math.sin(a), ny = slope; const l = Math.hypot(nx, ny, nz);
      v.push(Math.cos(a) * r, y, Math.sin(a) * r, nx / l, ny / l, nz / l, part); n++;
    }
    for (let j = 0; j < seg; j++) { const j1 = (j + 1) % seg; idx.push(base + j, base + seg + j, base + j1, base + j1, base + seg + j, base + seg + j1); }
    // bottom cap
    if (part > 0.5) { const c = n; v.push(0, y0, 0, 0, -1, 0, part); n++; for (let j = 0; j < seg; j++) idx.push(c, base + (j + 1) % seg, base + j); }
  };
  cone(0, 0.3, 0.035, 0.03, 5, 0);
  cone(0.12, 0.55, 0.3, 0.02, 7, 1);
  cone(0.38, 0.8, 0.24, 0.02, 7, 1);
  cone(0.6, 1.0, 0.16, 0.0, 7, 1);
  return { data: new Float32Array(v), idx: new Uint16Array(idx) };
}

function buildBoxMesh() {
  const v = [], idx = []; let n = 0;
  const face = (nx, ny, nz, pts) => { for (const p of pts) { v.push(p[0], p[1], p[2], nx, ny, nz); } idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4; };
  const h = 0.5;
  face(1, 0, 0, [[h, 0, -h], [h, 1, -h], [h, 1, h], [h, 0, h]]);
  face(-1, 0, 0, [[-h, 0, h], [-h, 1, h], [-h, 1, -h], [-h, 0, -h]]);
  face(0, 1, 0, [[-h, 1, -h], [-h, 1, h], [h, 1, h], [h, 1, -h]]);
  face(0, 0, 1, [[h, 0, h], [h, 1, h], [-h, 1, h], [-h, 0, h]]);
  face(0, 0, -1, [[-h, 0, -h], [-h, 1, -h], [h, 1, -h], [h, 0, -h]]);
  return { data: new Float32Array(v), idx: new Uint16Array(idx) };
}

// runway digit atlas (0-9, L, R, C)
function buildDigitTexture() {
  const cv = document.createElement('canvas'); cv.width = 13 * 64; cv.height = 96;
  const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#fff'; g.font = 'bold 92px "Helvetica Neue", Helvetica, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const chars = '0123456789LRC';
  for (let i = 0; i < 13; i++) {
    g.save(); g.translate(i * 64 + 32, 50); g.scale(0.62, 1.05); g.fillText(chars[i], 0, 0); g.restore();
  }
  return makeTex(cv.width, cv.height, { data: cv, mips: true, aniso: 8, ifmt: gl.RGBA8 });
}
