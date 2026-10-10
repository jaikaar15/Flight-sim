'use strict';
// ---------------------------------------------------------------------------
// Terrain: GPU-generated heightfield (read back for physics), baked normals/AO
// and sun shadows, rendered with CDLOD (continuous distance-dependent LOD).
// ---------------------------------------------------------------------------
const TERRAIN = {
  RES: 2048,
  SIZE: 40960,
  ORIGIN: -20480,
  LEAF: 512,
  GRID: 32,
  LEVELS: 11,          // root = 512 << 10 = 524288 m
  ROOT_ORIGIN: -262144,
  OCEAN: -320,
};

class Terrain {
  constructor() {
    const R = TERRAIN.RES;
    this.res = R; this.cell = TERRAIN.SIZE / R;
    this.data = null;      // Float32Array RGBA (h, moist, forest, rock)
    this.H = new Float32Array(R * R);
    this.F = new Float32Array(R * R);
    this.M = new Float32Array(R * R);
    this.ranges = [];
    this.setQuality(1600);
    this.minmax = new Map();
    this.fullInst = new Float32Array(4 * 4096); this.halfInst = new Float32Array(4 * 4096);
    this.nFull = 0; this.nHalf = 0;
  }
  setQuality(r0) {
    this.ranges = []; for (let i = 0; i < TERRAIN.LEVELS; i++) this.ranges.push(r0 * Math.pow(2, i));
    this.ranges[TERRAIN.LEVELS - 1] = 1e7;
    this.lodU = new Float32Array(48);
    for (let i = 0; i < TERRAIN.LEVELS; i++) {
      const prev = i === 0 ? 0 : this.ranges[i - 1];
      const end = Math.min(this.ranges[i], 3e6);
      this.lodU[i * 4] = prev + (end - prev) * 0.62; this.lodU[i * 4 + 1] = end;
    }
  }

  // ---------- generation ----------
  generate(islands, airports) {
    const R = this.res;
    const prog = new Program(FS_VS, SH.common + SH.noise + SH.terrainGenFS);
    const tgt = new Target(R, R, [{ ifmt: gl.RGBA32F, fmt: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST }], null);
    tgt.bind(); prog.use();
    prog.v4('uMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, TERRAIN.SIZE, R);
    const isl = new Float32Array(48); islands.forEach((s, i) => { isl.set(s, i * 4); });
    prog.set('uIslands', isl); prog.i('uIslandCount', islands.length);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    drawFullscreen();
    const data = new Float32Array(R * R * 4);
    gl.readPixels(0, 0, R, R, gl.RGBA, gl.FLOAT, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    tgt.dispose(); gl.deleteProgram(prog.p);
    this.data = data;
    // NOTE: texture row 0 = vUv.y 0 = world z origin (north). Layout: idx = (iz * R + ix)
    for (let i = 0; i < R * R; i++) { this.H[i] = data[i * 4]; this.M[i] = data[i * 4 + 1]; this.F[i] = data[i * 4 + 2]; }
    // flatten airfields
    for (const ap of airports) this.flattenAirport(ap);
    for (let i = 0; i < R * R; i++) { data[i * 4] = this.H[i]; data[i * 4 + 2] = this.F[i]; }
    this.hTex = makeTex(R, R, { ifmt: gl.RGBA32F, fmt: gl.RGBA, type: gl.FLOAT, data, filter: GLX.floatLinear ? gl.LINEAR : gl.NEAREST });
    this.buildMinMax();
    this.bakeNormals();
  }

  flattenAirport(ap) {
    const R = this.res, cell = this.cell, o = TERRAIN.ORIGIN;
    const s = Math.sin(ap.hdg * DEG), c = Math.cos(ap.hdg * DEG);
    const pad = ap.pad, blend = pad.blend;
    const ext = Math.hypot(pad.hl, pad.hw) + blend + cell * 2;
    // elevation: average of raw terrain in pad (unless fixed)
    if (ap.elev == null) {
      let sum = 0, n = 0;
      for (let u = -pad.hl; u <= pad.hl; u += 60) for (let v = -pad.hw; v <= pad.hw; v += 60) {
        const x = ap.x + u * s + v * c, z = ap.z - u * c + v * s; sum += this.heightAt(x, z); n++;
      }
      ap.elev = Math.max(ap.minElev || 6, sum / n);
    }
    const ix0 = Math.max(0, Math.floor((ap.x - ext - o) / cell)), ix1 = Math.min(R - 1, Math.ceil((ap.x + ext - o) / cell));
    const iz0 = Math.max(0, Math.floor((ap.z - ext - o) / cell)), iz1 = Math.min(R - 1, Math.ceil((ap.z + ext - o) / cell));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const x = o + (ix + 0.5) * cell, z = o + (iz + 0.5) * cell;
      const dx = x - ap.x, dz = z - ap.z;
      const u = dx * s - dz * c, v = dx * c + dz * s;
      let d;
      if (pad.shape === 'ellipse') d = Math.max(0, Math.hypot(u / pad.hl, v / pad.hw) - 1) * Math.min(pad.hl, pad.hw);
      else d = Math.hypot(Math.max(0, Math.abs(u) - pad.hl), Math.max(0, Math.abs(v) - pad.hw));
      const w = 1 - smooth(0, blend, d);
      const i = iz * R + ix;
      if (w > 0) {
        this.H[i] = lerp(this.H[i], ap.elev, w);
        const fw = 1 - smooth(0, blend * 0.4 + 120, d);
        this.F[i] *= 1 - fw;
      }
    }
  }

  // clear forest in an area (towns)
  clearForest(x0, z0, x1, z1) {
    const R = this.res, cell = this.cell, o = TERRAIN.ORIGIN;
    for (let iz = Math.max(0, ((z0 - o) / cell) | 0); iz <= Math.min(R - 1, ((z1 - o) / cell) | 0); iz++)
      for (let ix = Math.max(0, ((x0 - o) / cell) | 0); ix <= Math.min(R - 1, ((x1 - o) / cell) | 0); ix++) this.F[iz * R + ix] = 0;
  }
  uploadData() {
    const R = this.res, data = this.data;
    for (let i = 0; i < R * R; i++) { data[i * 4] = this.H[i]; data[i * 4 + 2] = this.F[i]; }
    gl.bindTexture(gl.TEXTURE_2D, this.hTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, R, R, 0, gl.RGBA, gl.FLOAT, data);
  }

  bakeNormals() {
    const R = this.res;
    const prog = new Program(FS_VS, SH.terrainBakeFS);
    const tgt = new Target(R, R, [{ ifmt: gl.RGBA8, filter: gl.LINEAR }], null);
    tgt.bind(); prog.use(); prog.tex('uHeight', this.hTex); prog.v4('uMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, TERRAIN.SIZE, R);
    drawFullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.nTex = tgt.tex[0];
    gl.bindTexture(gl.TEXTURE_2D, this.nTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.generateMipmap(gl.TEXTURE_2D);
    gl.deleteFramebuffer(tgt.fb); gl.deleteProgram(prog.p);
  }

  bakeShadow(lightDir) {
    const R = this.res;
    if (!this.shProg) this.shProg = new Program(FS_VS, SH.terrainShadowFS);
    if (!this.shTgt) this.shTgt = new Target(R, R, [{ ifmt: gl.RGBA8, filter: gl.LINEAR }], null);
    this.shTgt.bind(); this.shProg.use(); this.shProg.tex('uHeight', this.hTex);
    this.shProg.v4('uMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, TERRAIN.SIZE, this.res);
    this.shProg.v3('uLight', lightDir.x, Math.max(lightDir.y, 0.02), lightDir.z);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    drawFullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sTex = this.shTgt.tex[0];
  }

  // ---------- CPU queries ----------
  heightAt(x, z) {
    const R = this.res, cell = this.cell;
    let fx = (x - TERRAIN.ORIGIN) / cell - 0.5, fz = (z - TERRAIN.ORIGIN) / cell - 0.5;
    if (fx < 0 || fz < 0 || fx >= R - 1 || fz >= R - 1) {
      fx = clamp(fx, 0, R - 1.001); fz = clamp(fz, 0, R - 1.001);
    }
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * R + ix, H = this.H;
    return (H[i] * (1 - tx) + H[i + 1] * tx) * (1 - tz) + (H[i + R] * (1 - tx) + H[i + R + 1] * tx) * tz;
  }
  sampleF(arr, x, z) {
    const R = this.res, cell = this.cell;
    const fx = clamp((x - TERRAIN.ORIGIN) / cell - 0.5, 0, R - 1.001), fz = clamp((z - TERRAIN.ORIGIN) / cell - 0.5, 0, R - 1.001);
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * R + ix;
    return (arr[i] * (1 - tx) + arr[i + 1] * tx) * (1 - tz) + (arr[i + R] * (1 - tx) + arr[i + R + 1] * tx) * tz;
  }
  normalAt(x, z, out) {
    const e = this.cell;
    const hl = Math.max(0, this.heightAt(x - e, z)), hr = Math.max(0, this.heightAt(x + e, z));
    const hd = Math.max(0, this.heightAt(x, z - e)), hu = Math.max(0, this.heightAt(x, z + e));
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  // ---------- min/max quadtree ----------
  buildMinMax() { this.minmax.clear(); }
  nodeMinMax(level, ix, iz) {
    const key = level * 1e8 + ix * 1e4 + iz;
    let r = this.minmax.get(key); if (r) return r;
    const S = TERRAIN.LEAF << level;
    const x0 = TERRAIN.ROOT_ORIGIN + ix * S, z0 = TERRAIN.ROOT_ORIGIN + iz * S;
    const o = TERRAIN.ORIGIN, e = o + TERRAIN.SIZE;
    if (x0 >= e || z0 >= e || x0 + S <= o || z0 + S <= o) r = [TERRAIN.OCEAN, 0];
    else if (level === 0) {
      const R = this.res, cell = this.cell;
      const a0 = clamp(Math.floor((x0 - o) / cell) - 1, 0, R - 1), a1 = clamp(Math.ceil((x0 + S - o) / cell) + 1, 0, R - 1);
      const b0 = clamp(Math.floor((z0 - o) / cell) - 1, 0, R - 1), b1 = clamp(Math.ceil((z0 + S - o) / cell) + 1, 0, R - 1);
      let mn = 1e9, mx = -1e9;
      for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) { const h = this.H[b * R + a]; if (h < mn) mn = h; if (h > mx) mx = h; }
      r = [Math.max(mn, 0), Math.max(mx, 0)];
    } else {
      let mn = 1e9, mx = -1e9;
      for (let k = 0; k < 4; k++) { const c = this.nodeMinMax(level - 1, ix * 2 + (k & 1), iz * 2 + (k >> 1)); if (c[0] < mn) mn = c[0]; if (c[1] > mx) mx = c[1]; }
      r = [mn, mx];
    }
    this.minmax.set(key, r);
    return r;
  }

  // ---------- CDLOD selection ----------
  select(cam, planes) {
    this.nFull = 0; this.nHalf = 0;
    this._cam = cam; this._planes = planes;
    this.sel(TERRAIN.LEVELS - 1, 0, 0);
  }
  _sphere(x0, z0, S, mn, mx, r) {
    const c = this._cam;
    const dx = Math.max(x0 - c.x, 0, c.x - (x0 + S)), dz = Math.max(z0 - c.z, 0, c.z - (z0 + S)), dy = Math.max(mn - c.y, 0, c.y - mx);
    return dx * dx + dy * dy + dz * dz <= r * r;
  }
  _frustum(x0, z0, S, mn, mx) {
    const c = this._cam, P = this._planes;
    const ax = x0 - c.x, az = z0 - c.z, bx = ax + S, bz = az + S, ay = mn - c.y, by = mx - c.y;
    for (let i = 0; i < 4; i++) {
      const p = P[i];
      const px = p[0] > 0 ? bx : ax, py = p[1] > 0 ? by : ay, pz = p[2] > 0 ? bz : az;
      if (p[0] * px + p[1] * py + p[2] * pz + p[3] < 0) return false;
    }
    return true;
  }
  sel(level, ix, iz) {
    const S = TERRAIN.LEAF << level;
    const x0 = TERRAIN.ROOT_ORIGIN + ix * S, z0 = TERRAIN.ROOT_ORIGIN + iz * S;
    const mm = this.nodeMinMax(level, ix, iz);
    if (!this._sphere(x0, z0, S, mm[0], mm[1], this.ranges[level])) return false;
    if (!this._frustum(x0, z0, S, mm[0] - 5, mm[1] + 5)) return true;
    if (level === 0 || !this._sphere(x0, z0, S, mm[0], mm[1], this.ranges[level - 1])) { this.add(true, x0, z0, S, level); return true; }
    for (let k = 0; k < 4; k++) {
      const cx = ix * 2 + (k & 1), cz = iz * 2 + (k >> 1);
      if (!this.sel(level - 1, cx, cz)) {
        const hs = S / 2, x = x0 + (k & 1) * hs, z = z0 + (k >> 1) * hs;
        const cm = this.nodeMinMax(level - 1, cx, cz);
        if (this._frustum(x, z, hs, cm[0] - 5, cm[1] + 5)) this.add(false, x, z, hs, level);
      }
    }
    return true;
  }
  add(full, x, z, s, lod) {
    if (full) { if (this.nFull >= 4096) return; const o = this.nFull++ * 4, a = this.fullInst; a[o] = x; a[o + 1] = z; a[o + 2] = s; a[o + 3] = lod; }
    else { if (this.nHalf >= 4096) return; const o = this.nHalf++ * 4, a = this.halfInst; a[o] = x; a[o + 1] = z; a[o + 2] = s; a[o + 3] = lod; }
  }

  // ---------- rendering ----------
  initRender() {
    const mk = (n) => {
      const v = new Float32Array((n + 1) * (n + 1) * 2); let k = 0;
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { v[k++] = i / n; v[k++] = j / n; }
      const idx = new Uint16Array(n * n * 6); k = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        // alternate diagonal for symmetric tessellation
        if ((i + j) & 1) { idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d; }
        else { idx[k++] = a; idx[k++] = c; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = b; }
      }
      const mesh = new Mesh([{ size: 2 }], v, idx);
      const ib = makeBuffer(new Float32Array(4 * 4096), gl.DYNAMIC_DRAW);
      mesh.addInstanced(ib, [{ loc: 1, size: 4 }]);
      mesh.ib = ib;
      return mesh;
    };
    this.meshFull = mk(TERRAIN.GRID);
    this.meshHalf = mk(TERRAIN.GRID / 2);
    this.prog = new Program(SH.frame + SH.common + SH.terrainVS, SH.frame + SH.common + SH.skyFns + SH.shadowFns + SH.cloudFns + SH.lightFns + SH.terrainFS);
  }

  draw(R, world) {
    const p = this.prog.use();
    R.bindFrame(p);
    p.tex('uHeight', this.hTex).tex('uNormalAO', this.nTex).tex('uTShadow', this.sTex).tex('uDetail', R.detailTex)
      .tex('uWaveN', R.waveTex).tex('uDigits', R.digitTex).tex('uSky', R.skyTex).tex('uShadow', R.shadowTex);
    R.bindClouds(p);
    p.v4('uHMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, 1 / TERRAIN.SIZE, this.res);
    p.set('uLod', this.lodU); p.f('uSeabed', R.q.waves ? 1 : 0);
    p.f('uGrassOn', R.grassFade > 0 && R.maskC ? R.grassFade : 0);
    if (R.grassMask && R.maskC) { p.tex('uGrassMask', R.grassMask.tex[0]); p.v4('uMask', R.maskC.ox, R.maskC.oz, GRASS_MASK_SIZE, 0); }
    world.bindSurfaceUniforms(p);
    if (this.nFull) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.meshFull.ib); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.fullInst, 0, this.nFull * 4);
      p.f('uGridDim', TERRAIN.GRID); this.meshFull.drawInstanced(this.nFull);
    }
    if (this.nHalf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.meshHalf.ib); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.halfInst, 0, this.nHalf * 4);
      p.f('uGridDim', TERRAIN.GRID / 2); this.meshHalf.drawInstanced(this.nHalf);
    }
  }
}
