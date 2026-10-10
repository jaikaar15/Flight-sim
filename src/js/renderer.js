'use strict';
// ---------------------------------------------------------------------------
// Renderer: HDR forward pipeline with MSAA, reversed-Z (when available),
// physically based sky LUT, aircraft shadow map, bloom, ACES tonemap.
// ---------------------------------------------------------------------------
const QUALITY = {
  low: { dpr: 1.0, msaa: 2, shadow: 1024, trees: 1800, treeDensity: 0.6, terrainR0: 1300, cloudScale: 0.34, cloudSteps: 0.034, bloom: true },
  medium: { dpr: 1.5, msaa: 4, shadow: 2048, trees: 3000, treeDensity: 0.9, terrainR0: 1600, cloudScale: 0.5, cloudSteps: 0.022, bloom: true },
  high: { dpr: 2.0, msaa: 4, shadow: 4096, trees: 4200, treeDensity: 1.0, terrainR0: 2100, cloudScale: 0.5, cloudSteps: 0.014, bloom: true },
  // MAX: real grass blades + a displaced Gerstner-wave ocean with sun glitter
  max: { dpr: 2.0, msaa: 4, shadow: 4096, trees: 5200, treeDensity: 1.15, terrainR0: 2600, cloudScale: 0.6, cloudSteps: 0.011, bloom: true, grass: true, waves: true },
};
// grass rings: spacing doubles outward; density cross-fades over each overlap band
const GRASS_RINGS = [
  { sp: 0.27, fin0: -1, fin1: 0, fout0: 17, rout: 24, scale: 1.0 },
  { sp: 0.64, fin0: 17, fin1: 24, fout0: 44, rout: 58, scale: 1.3 },
  { sp: 1.28, fin0: 44, fin1: 58, fout0: 95, rout: 130, scale: 1.65 },
];
const GRASS_MASK_SIZE = 320, GRASS_MASK_RES = 512;

// Volumetric cloud field parameters + CPU copy of the weather map (for thermals)
const CLOUD_TILE = 26000;
const NO_HITS = new Float32Array(32);
const MAX_LIGHTS = 16;   // weather map repeat distance (m)
class VolClouds {
  constructor() {
    this.base = 1500; this.top = 3400; this.cover = 0.4; this.density = 1.0; this.shadow = 0.85;
    this.windX = 0; this.windZ = 0; this.weather = null; this.wRes = 512;
  }
  set(p) { Object.assign(this, p); }
  advance(wind, dt) { this.windX -= wind.x * dt; this.windZ -= wind.z * dt; }
  coverAt(x, z) {
    if (!this.weather) return 0;
    const N = this.wRes;
    let u = ((x + this.windX) / CLOUD_TILE) % 1, v = ((z + this.windZ) / CLOUD_TILE) % 1;
    if (u < 0) u += 1; if (v < 0) v += 1;
    const w = this.weather[((v * N | 0) * N + (u * N | 0)) * 4] / 255;
    return clamp(w * (0.55 + this.cover) + (this.cover - 0.55) * 0.9, 0, 1);
  }
  // thermal updraft under cumulus (m/s)
  lift(x, y, z) {
    if (this.cover < 0.05 || this.cover > 0.85 || y > this.base + 80) return 0;
    const c = this.coverAt(x, z);
    return 4.6 * smooth(0.3, 0.75, c) * smooth(0, 350, y) * (1 - smooth(this.base - 150, this.base + 80, y) * 0.6);
  }
}

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    initGL(canvas);
    this.q = QUALITY.medium; this.qualityName = 'medium';
    this.renderScale = 1; this.dynRes = true;
    this.ubo = gl.createBuffer(); this.uboData = new Float32Array(80 + MAX_LIGHTS * 8);
    this.lightIdx = new Int32Array(64); this.lightScore = new Float32Array(64);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo); gl.bufferData(gl.UNIFORM_BUFFER, this.uboData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
    this.VP = M4.create(); this.P = M4.create(); this.Vr = M4.create(); this.invVP = M4.create(); this.shadowVP = M4.create();
    this.tmpM = M4.create(); this.model = M4.create();
    this.identParts = new Float32Array(MAX_PARTS * 16); for (let i = 0; i < MAX_PARTS; i++) M4.identity(this.identParts.subarray(i * 16, i * 16 + 16));
    this.planes = [new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4)];
    this.env = { sunDir: new V3(0.3, 0.8, -0.4).normalize(), moonDir: new V3(-0.3, 0.6, 0.5).normalize(), sunColor: [5, 5, 5], ambient: [0.6, 0.7, 0.9], daylight: 1, night: 0, haze: 1, fog: 0.00006, exposure: 0.42, cover: 0.3, overcast: 0, lightDir: new V3() };
    this.skyAlt = -9999; this.frameTime = 16; this.stats = { draws: 0 };
    this.initPrograms();
    this.initTextures();
    this.initMeshes();
    this.acMeshes = {}; this.discMeshes = {};
    this.clouds = new VolClouds();
    this.clouds.weather = this.cloudWeatherPx;
    this.time = 0; this.frameNo = 0;
  }

  initPrograms() {
    const F = SH.frame + SH.common, FS = SH.frame + SH.common + SH.skyFns + SH.shadowFns + SH.cloudFns + SH.lightFns;
    this.pSky = new Program(FS_VS, SH.frame + SH.common + SH.skyFns + SH.skyFS);
    this.pMesh = new Program(F + SH.meshVS, FS + SH.meshFS);
    this.pMeshShadow = new Program(SH.meshShadowVS, SH.depthFS);
    this.pBox = new Program(F + SH.boxVS, FS + SH.boxFS);
    this.pTree = new Program(F + SH.treeVS, FS + SH.treeFS);
    this.pParticle = new Program(F + SH.lightFns + SH.particleVS, FS + SH.particleFS);
    this.pBeam = new Program(F + SH.beamVS, FS + SH.beamFS);
    this.pGlow = new Program(F + SH.glowVS, F + SH.glowFS);
    this.pFlame = new Program(F + SH.flameVS, F + SH.flameFS);
    this.pCloudVol = new Program(FS_VS, SH.frame + SH.common + SH.skyFns + SH.cloudFns + SH.depthFns + SH.cloudVolFS);
    this.pCloudComp = new Program(FS_VS, SH.frame + SH.common + SH.depthFns + SH.cloudCompFS);
    this.pCloudTemporal = new Program(FS_VS, SH.cloudTemporalFS);
    this.pBright = new Program(FS_VS, SH.brightFS);
    this.pDown = new Program(FS_VS, SH.downFS);
    this.pUp = new Program(FS_VS, SH.upFS);
    this.pComp = new Program(FS_VS, SH.frame + SH.compositeFS);
    this.pSkyLut = new Program(FS_VS, SH.common + SH.skyLutFS);
    this.pOcean = new Program(F + SH.waveFns + SH.oceanVS, FS + SH.waveFns + SH.oceanFS);
    this.pOceanFFT = new Program(F + SH.oceanFFTVS, FS + SH.oceanFFTFS);
    this.pGrass = new Program(F + SH.grassVS, FS + SH.grassFS);
    this.pGrassMask = new Program(FS_VS, SH.common + SH.grassMaskFS);
  }

  initTextures() {
    const gen = (w, h, mode, mips) => {
      const p = new Program(FS_VS, SH.common + SH.noise + SH.procTexFS);
      const t = new Target(w, h, [{ ifmt: gl.RGBA8, wrap: gl.REPEAT }], null);
      t.bind(); p.use(); p.i('uMode', mode); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); drawFullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const tex = t.tex[0];
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.generateMipmap(gl.TEXTURE_2D);
      if (GLX.aniso) gl.texParameterf(gl.TEXTURE_2D, GLX.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, GLX.maxAniso));
      gl.deleteFramebuffer(t.fb); gl.deleteProgram(p.p);
      return tex;
    };
    this.detailTex = gen(512, 512, 0);
    this.waveTex = gen(512, 512, 1);
    this.atlasTex = gen(512, 512, 2);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.digitTex = buildDigitTexture();
    this.skyTgt = new Target(256, 128, [{ ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR, wrap: gl.REPEAT, wrapT: gl.CLAMP_TO_EDGE }], null);
    this.skyTex = this.skyTgt.tex[0];
    this.makeShadow(this.q.shadow);
    this.initCloudTextures();
  }
  makeShadow(size) {
    if (this.shadowTgt) this.shadowTgt.dispose();
    // raw depth (no hardware compare): PCSS needs blocker depths
    this.shadowTgt = new Target(size, size, [], { ifmt: gl.DEPTH_COMPONENT24, type: gl.UNSIGNED_INT, filter: gl.NEAREST, compare: false });
    this.shadowTex = this.shadowTgt.depth; this.shadowSize = size;
  }

  // 3D Perlin-Worley noise volume + weather map, generated once on the GPU
  initCloudTextures() {
    const N = 96;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const prog = new Program(FS_VS, SH.noise3DGenFS);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, N, N); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    prog.use(); prog.f('uSize', N);
    for (let z = 0; z < N; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
      prog.f('uSlice', z);
      drawFullscreen();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteProgram(prog.p);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_3D);
    this.noise3D = tex;
    // weather map
    const W = 512;
    const wp = new Program(FS_VS, SH.common + SH.noise + SH.weatherGenFS);
    const wt = new Target(W, W, [{ ifmt: gl.RGBA8, wrap: gl.REPEAT, filter: gl.LINEAR }], null);
    wt.bind(); wp.use(); drawFullscreen();
    const px = new Uint8Array(W * W * 4);
    gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.weatherTex = wt.tex[0];
    gl.bindTexture(gl.TEXTURE_2D, this.weatherTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.generateMipmap(gl.TEXTURE_2D);
    gl.deleteFramebuffer(wt.fb); gl.deleteProgram(wp.p);
    this.cloudWeatherPx = px;
  }
  bindClouds(p) { p.tex('uNoise', this.noise3D, gl.TEXTURE_3D).tex('uWeather', this.weatherTex); }

  initMeshes() {
    // instanced quad corners
    const corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    const qi = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const mkQuad = (specs, n) => {
      const m = new Mesh([{ size: 2 }], corners, qi);
      const buf = makeBuffer(new Float32Array(n), gl.DYNAMIC_DRAW);
      m.addInstanced(buf, specs); m.ib = buf; return m;
    };
    this.particleMesh = mkQuad([{ loc: 1, size: 4 }, { loc: 2, size: 4 }, { loc: 3, size: 4 }], 16000 * 12);
    this.glowMesh = mkQuad([{ loc: 1, size: 4 }, { loc: 2, size: 4 }], 4000 * 8);
    this.staticGlowMesh = mkQuad([{ loc: 1, size: 4 }, { loc: 2, size: 4 }], 8);
    // afterburner flame: closed cylinder hull (t along axis, angle, radial factor); the shader raymarches inside it
    {
      const S = 20, v = [], idx = [];
      for (let j = 0; j <= S; j++) { const a = j / S * Math.PI * 2; v.push(0, a, 1, 1, a, 1); }
      for (let j = 0; j < S; j++) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
      const c0 = v.length / 3; v.push(0, 0, 0, 1, 0, 0);
      for (let j = 0; j < S; j++) idx.push(c0, j * 2, (j + 1) * 2, c0 + 1, (j + 1) * 2 + 1, j * 2 + 1);
      this.flameMesh = new Mesh([{ size: 3 }], new Float32Array(v), new Uint16Array(idx));
      this.flameBuf = makeBuffer(new Float32Array(96 * 12), gl.DYNAMIC_DRAW);
      this.flameMesh.addInstanced(this.flameBuf, [{ loc: 1, size: 4 }, { loc: 2, size: 4 }, { loc: 3, size: 4 }]);
    }
    // MAX ocean: polar grid under the camera, ring radii growing exponentially out to ~400 km
    {
      const NR = 210, NA = 256, b = 0.0523, a = 0.6 / b;
      const v = new Float32Array((NR + 1) * (NA + 1) * 2); let o = 0;
      for (let i = 0; i <= NR; i++) { const r = a * (Math.exp(b * i) - 1); for (let j = 0; j <= NA; j++) { v[o++] = r; v[o++] = j / NA * Math.PI * 2; } }
      const idx = new Uint32Array(NR * NA * 6); let k = 0;
      for (let i = 0; i < NR; i++) for (let j = 0; j < NA; j++) { const p = i * (NA + 1) + j, q = p + NA + 1; idx[k++] = p; idx[k++] = q; idx[k++] = p + 1; idx[k++] = p + 1; idx[k++] = q; idx[k++] = q + 1; }
      this.oceanMesh = new Mesh([{ size: 2 }], v, idx);
    }
    // MAX grass: one instance = one grid cell with 6 curved blades (3 segments each)
    {
      const v = [], idx = [];
      for (let bl = 0; bl < 6; bl++) {
        const base = v.length / 3;
        for (let r = 0; r < 4; r++) { const t = r / 3; v.push(bl, t, -1, bl, t, 1); }
        for (let r = 0; r < 3; r++) { const q = base + r * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
      }
      this.grassMesh = new Mesh([{ size: 3 }], new Float32Array(v), new Uint16Array(idx));
    }
    this.seaWA = new Float32Array(40); this.seaWB = new Float32Array(40); this.sea = [0.3, 0.5, 0, 0];
    this.ocean = new FFTOcean();
    this.setSea(null, 0);
    // beams: x 0..1 along, y -1..1 across
    const bc = new Float32Array([0, -1, 1, -1, 1, 1, 0, 1]);
    this.beamMesh = new Mesh([{ size: 2 }], bc, qi);
    this.beamBuf = makeBuffer(new Float32Array(12000 * 14), gl.DYNAMIC_DRAW);
    this.beamMesh.addInstanced(this.beamBuf, [{ loc: 1, size: 4 }, { loc: 2, size: 4 }, { loc: 3, size: 4 }, { loc: 4, size: 2 }]);
    // box & tree
    const bm = buildBoxMesh();
    this.boxMesh = new Mesh([{ size: 3 }, { size: 3 }], bm.data, bm.idx);
    const tm = buildTreeMesh();
    this.treeMesh = new Mesh([{ size: 3 }, { size: 3 }, { size: 1 }], tm.data, tm.idx);
    this.treeBuf = makeBuffer(new Float32Array(6 * 90000), gl.DYNAMIC_DRAW);
    this.treeMesh.addInstanced(this.treeBuf, [{ loc: 3, size: 4 }, { loc: 4, size: 2 }]);
    this.missileMeshes = { ir: this.meshFrom(buildMissileMesh('ir')), radar: this.meshFrom(buildMissileMesh('radar')) };
  }
  meshFrom(md) { return new Mesh(VLAYOUT, md.data, md.idx); }

  setWorld(world) {
    this.world = world;
    // buildings
    const B = world.buildings; const arr = new Float32Array(B.length * 8);
    B.forEach((b, i) => arr.set(b, i * 8));
    this.boxBuf = makeBuffer(arr, gl.STATIC_DRAW); this.nBoxes = B.length;
    this.boxMesh.addInstanced(this.boxBuf, [{ loc: 2, size: 4 }, { loc: 3, size: 4 }]);
    // static lights
    const L = world.lights; const la = new Float32Array(L.length * 8);
    L.forEach((l, i) => la.set(l, i * 8));
    this.staticGlowMesh = (() => {
      const corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
      const m = new Mesh([{ size: 2 }], corners, new Uint16Array([0, 1, 2, 0, 2, 3]));
      const buf = makeBuffer(la, gl.STATIC_DRAW); m.addInstanced(buf, [{ loc: 1, size: 4 }, { loc: 2, size: 4 }]); return m;
    })();
    this.nStaticGlows = L.length;
    // carrier
    const cm = buildCarrierMesh(world.carrier);
    this.carrierMesh = this.meshFrom(cm);
    this.deckTex = carrierDeckTexture(world.carrier);
    world.terrain.initRender();
  }

  aircraftMesh(ac) {
    const id = ac.spec.id;
    if (!this.acMeshes[id]) {
      this.acMeshes[id] = this.meshFrom(ac.geo.mesh);
      if (ac.spec.engine.type === 'prop') {
        const E = ac.spec.engine, B = new MeshBuilder();
        const c = [E.pos[0], E.pos[1], -E.pos[2] + 0.1];
        B.grid(2, 32, (i, j) => { const a = j / 32 * Math.PI * 2; const r = i ? E.dia / 2 : 0.05; return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2]]; }, () => [0, 0, -1], { wrap: true, color: [0.05, 0.05, 0.05], rough: 0.6, flags: 8 });
        this.discMeshes[id] = this.meshFrom(B.build());
      }
    }
    return this.acMeshes[id];
  }

  // sea state from the wind: Pierson-Moskowitz height & peak wavelength, plus a constant long swell
  setSea(wind, rough = 0) {
    if (this.ocean) this.ocean.setSea(wind, rough);
    const U = wind ? Math.hypot(wind.x, wind.z) : 0;           // m/s
    const wdir = U > 0.3 ? Math.atan2(wind.z, wind.x) : 0.4;    // wind sea runs downwind
    // open ocean is never glassy: at least a light-breeze sea, plus a long swell from distant weather
    const Ue = Math.max(U, 5.5) * (1 + rough * 0.5);
    const Hs = Math.min(3.2, 0.0246 * Ue * Ue);
    // peak wavelength kept short enough that the sea visibly heaves (a fully developed sea is longer)
    const lp = clamp(0.4 * Ue * Ue, 12, 75);
    const rnd = mulberry32(9137), A = this.seaWA, B = this.seaWB;
    const raw = [];
    for (let i = 0; i < 10; i++) {
      let lam, amp, ang;
      if (i === 0) { lam = 170; amp = 0.55 + rough * 0.3; ang = 0.35; }          // swell
      else {
        lam = 130 * Math.pow(0.68, i - 1);                     // 130 m .. 4 m
        const x = Math.log(lam / lp);
        amp = Math.exp(-x * x / 0.5);
        // long waves run close to the wind direction, short chop is more confused
        ang = wdir + (rnd() - 0.5) * (0.25 + 1.2 * Math.pow(1 - lam / 130, 2));
      }
      raw.push({ lam, amp, ang });
    }
    const sum = raw.slice(1).reduce((s, w) => s + w.amp, 0) || 1;
    let total = 0, ms = 0;
    raw.forEach((w, i) => {
      const k = 2 * Math.PI / w.lam;
      let amp = i === 0 ? w.amp : w.amp / sum * Hs * 0.5 + (w.lam < 25 ? 0.0035 * w.lam : 0);   // always a little chop
      amp = Math.min(amp, 0.07 * w.lam);
      const Q = clamp(0.55 / (k * amp * 9 + 1e-6), 0, 1);
      A[i * 4] = Math.cos(w.ang); A[i * 4 + 1] = Math.sin(w.ang); A[i * 4 + 2] = k; A[i * 4 + 3] = amp;
      B[i * 4] = Math.sqrt(9.81 * k); B[i * 4 + 1] = rnd() * Math.PI * 2; B[i * 4 + 2] = Q; B[i * 4 + 3] = w.lam;
      total += amp; ms += amp * amp;
    });
    // x: typical crest height (~2 sigma) for whitecap/SSS normalisation; z: whitecaps from the real wind
    this.sea = [2 * Math.sqrt(ms / 2), 0.35 + 0.65 * clamp(U / 10, 0, 1), smooth(5, 12, U * (1 + rough * 0.5)), 0];
  }

  // grass placement/colour around the camera; re-rendered after moving ~40 m
  updateGrassMask(cam, world) {
    const T = world.terrain, MS = GRASS_MASK_SIZE, texel = MS / GRASS_MASK_RES;
    if (!this.grassMask) this.grassMask = new Target(GRASS_MASK_RES, GRASS_MASK_RES, [{ ifmt: gl.RGBA8, filter: gl.LINEAR }], null);
    const M = this.maskC;
    if (M && M.world === world && Math.hypot(cam.pos.x - M.x, cam.pos.z - M.z) < 40) return;
    const ox = Math.round((cam.pos.x - MS / 2) / texel) * texel, oz = Math.round((cam.pos.z - MS / 2) / texel) * texel;
    this.maskC = { x: ox + MS / 2, z: oz + MS / 2, ox, oz, world };
    this.grassMask.bind();
    const p = this.pGrassMask.use();
    p.tex('uHeight', T.hTex).tex('uNormalAO', T.nTex).tex('uDetail', this.detailTex);
    p.v4('uHMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, 1 / TERRAIN.SIZE, T.res); p.v4('uMask', ox, oz, MS, 0);
    world.bindSurfaceUniforms(p);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    drawFullscreen();
  }

  drawOcean(cam, world) {
    const T = world.terrain;
    if (this.ocean.ok) {
      // FFT ocean (falls back to the Gerstner sum below without float render targets)
      const p = this.pOceanFFT.use();
      p.tex('uHeight', T.hTex).tex('uDetail', this.detailTex).tex('uTShadow', T.sTex).tex('uSky', this.skyTex).tex('uShadow', this.shadowTex);
      this.bindClouds(p); this.ocean.bind(p);
      p.v4('uHMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, 1 / TERRAIN.SIZE, T.res);
      p.v2('uCenter', cam.pos.x, cam.pos.z);
      world.bindSurfaceUniforms(p);
      this.oceanMesh.draw();
      return;
    }
    const p = this.pOcean.use();
    p.tex('uHeight', T.hTex).tex('uWaveN', this.waveTex).tex('uDetail', this.detailTex).tex('uTShadow', T.sTex).tex('uSky', this.skyTex).tex('uShadow', this.shadowTex);
    this.bindClouds(p);
    p.v4('uHMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, 1 / TERRAIN.SIZE, T.res);
    p.v2('uCenter', cam.pos.x, cam.pos.z);
    p.set('uWA', this.seaWA); p.set('uWB', this.seaWB); p.v4('uSea', this.sea[0], this.sea[1], this.sea[2], 0);
    world.bindSurfaceUniforms(p);
    this.oceanMesh.draw();
  }

  drawGrass(S, cam, world) {
    const T = world.terrain;
    const gy = Math.max(T.heightAt(cam.pos.x, cam.pos.z), 0);
    if (this.grassFade <= 0 || !this.maskC) return;
    const p = this.pGrass.use();
    p.tex('uHeight', T.hTex).tex('uGrassMask', this.grassMask.tex[0]).tex('uDetail', this.detailTex).tex('uTShadow', T.sTex).tex('uSky', this.skyTex).tex('uShadow', this.shadowTex);
    this.bindClouds(p);
    p.v4('uHMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, 1 / TERRAIN.SIZE, T.res);
    p.v4('uMask', this.maskC.ox, this.maskC.oz, GRASS_MASK_SIZE, 0);
    p.f('uGrassFade', this.grassFade);
    // engine blast / prop wash flattens grass near the player's aircraft
    const pl = S.player;
    let bs = 0;
    if (pl && pl.alive && pl.visible) {
      const E = pl.spec.engine, fm = pl.fm;
      bs = E.type === 'jet' ? clamp(fm.eng.thrust / (fm.mass * 9.81) * 1.6, 0, 1.5) : clamp(fm.eng.vi / 18, 0, 1.2);
    }
    p.v4('uBlast', pl ? pl.pos.x : 0, pl ? pl.pos.y : -1e4, pl ? pl.pos.z : 0, bs);
    for (const R of GRASS_RINGS) {
      const N = Math.ceil(2 * R.rout / R.sp) + 2;
      p.v4('uRing', R.sp, R.fin0, R.fin1, R.rout); p.v4('uRingB', N, R.scale, R.fout0, gy);
      p.v2('uSnap', Math.round(cam.pos.x / R.sp), Math.round(cam.pos.z / R.sp));
      this.grassMesh.drawInstanced(N * N);
    }
  }

  setQuality(name) {
    this.qualityName = name; this.q = QUALITY[name];
    this.makeShadow(this.q.shadow);
    this.targetsW = 0; // force rebuild
    if (this.world) { this.world.terrain.setQuality(this.q.terrainR0); this.world.trees.maxDist = this.q.trees; this.world.trees.density = this.q.treeDensity; this.world.trees.cache.clear(); this.world.trees.lastKey = ''; }
  }

  ensureTargets() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.q.dpr);
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const w = Math.max(64, Math.round(cw * this.renderScale)), h = Math.max(64, Math.round(ch * this.renderScale));
    if (w === this.targetsW && h === this.targetsH) return;
    this.targetsW = w; this.targetsH = h;
    [this.msT, this.resT, ...(this.bloomT || [])].forEach(t => t && t.dispose());
    const cf = GLX.colorFloat ? gl.RGBA16F : gl.RGBA8;
    this.msT = new MSTarget(w, h, Math.min(this.q.msaa, GLX.maxSamples), cf);
    this.resT = new Target(w, h, [{ ifmt: cf, fmt: gl.RGBA, type: GLX.colorFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, filter: gl.LINEAR }], { ifmt: gl.DEPTH_COMPONENT32F, type: gl.FLOAT, filter: gl.NEAREST });
    this.bloomT = [];
    let bw = w >> 1, bh = h >> 1;
    for (let i = 0; i < 5; i++) { this.bloomT.push(new Target(Math.max(bw, 2), Math.max(bh, 2), [{ ifmt: cf, fmt: gl.RGBA, type: GLX.colorFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, filter: gl.LINEAR }], null)); bw >>= 1; bh >>= 1; }
    // volumetric clouds: reduced-resolution MRT (premultiplied colour + weighted cloud distance)
    [this.cloudT, ...(this.cloudHist || [])].forEach(t => t && t.dispose());
    const cs = this.q.cloudScale;
    const mkCloud = () => new Target(Math.max(32, Math.round(w * cs)), Math.max(32, Math.round(h * cs)), [
      { ifmt: cf, fmt: gl.RGBA, type: GLX.colorFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, filter: gl.LINEAR },
      { ifmt: GLX.colorFloat ? gl.RG16F : gl.RG8, fmt: gl.RG, type: GLX.colorFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, filter: gl.LINEAR }], null);
    this.cloudT = mkCloud();
    this.cloudHist = [mkCloud(), mkCloud()]; this.histIdx = 0; this.histValid = false; this.cloudOut = null;
    this.prevVP = M4.create(); this.prevCam = new V3();
    // colour-only FBO over the resolved scene (no depth attached -> depth can be sampled)
    if (this.resColorFB) gl.deleteFramebuffer(this.resColorFB);
    this.resColorFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resColorFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.resT.tex[0], 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---------- environment ----------
  setEnvironment(opt) {
    const E = this.env;
    // sun position from time of day (hours), latitude 34N, declination +12
    const lat = 34 * DEG, dec = 12 * DEG, H = (opt.time - 12) / 24 * Math.PI * 2;
    const el = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
    let az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI;
    E.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    E.moonDir.set(-E.sunDir.x * 0.6 + 0.2, Math.max(0.35, -E.sunDir.y * 0.8 + 0.3), -E.sunDir.z * 0.6 + 0.3).normalize();
    E.daylight = smooth(-0.1, 0.08, E.sunDir.y);
    E.night = 1 - smooth(-0.18, 0.02, E.sunDir.y);
    E.haze = opt.haze; E.cover = opt.cover; E.overcast = opt.overcast || 0;
    E.fog = 0.000035 * opt.haze + E.overcast * 0.00003;
    E.lightDir.copy(E.sunDir.y > -0.04 ? E.sunDir : E.moonDir);
    this.skyAlt = -9999;
    // terrain sun shadow bake
    this.world.terrain.bakeShadow(E.lightDir);
    // volumetric cloud layer
    const ov = E.overcast > 0.5;
    this.clouds.set({ cover: opt.cover, base: ov ? 950 : (opt.cloudBase || 1500), top: ov ? 2500 : (opt.cloudBase || 1500) + 1900, density: ov ? 0.9 : 1.0, shadow: 0.88 });
  }

  updateSky(alt) {
    const E = this.env;
    const a = Math.round(Math.max(0, alt) / 300) * 300;
    if (a === this.skyAlt) return;
    this.skyAlt = a;
    const moonI = 0.035;
    this.skyTgt.bind(); const p = this.pSkyLut.use();
    p.v3('uLightDir', E.sunDir.x, E.sunDir.y, E.sunDir.z); p.v3('uMoonDir', E.moonDir.x, E.moonDir.y, E.moonDir.z);
    p.f('uAlt', a); p.f('uHaze', E.haze * (1 + E.overcast * 1.5)); p.f('uMoonI', moonI * E.night);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    drawFullscreen();
    // ambient from LUT (cosine weighted upper hemisphere)
    const W = 256, Hh = 128; const px = new Float32Array(W * Hh * 4);
    gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let r = 0, g = 0, b = 0, wsum = 0;
    for (let y = Hh / 2; y < Hh; y += 2) {
      const v = (y + 0.5) / Hh * 2 - 1, elv = v * v * Math.PI / 2;
      const w = Math.sin(elv) * Math.cos(elv) * (2 * v) ;
      for (let x = 0; x < W; x += 4) { const o = (y * W + x) * 4; r += px[o] * w; g += px[o + 1] * w; b += px[o + 2] * w; wsum += w; }
    }
    const amb = 2.0;
    // faint starlight / airglow so the darkest night isn't pure black
    E.ambient = [r / wsum * amb + 0.003 * E.night, g / wsum * amb + 0.0045 * E.night, b / wsum * amb + 0.009 * E.night];
    // sun transmittance from camera altitude
    const sunT = this.transmittance(E.sunDir, a, E.haze);
    const sI = 22 / Math.PI;
    const day = smooth(-0.06, 0.02, E.sunDir.y);
    const moonT = this.transmittance(E.moonDir, a, E.haze);
    const mI = moonI * 22 / Math.PI * E.night * 0.3;   // dim moonlight: nights are dark
    const ov = 1 - E.overcast * 0.3;   // cloud shadows do the rest
    E.sunColor = [
      sunT[0] * sI * day * ov + moonT[0] * mI * 0.75 * (1 - day),
      sunT[1] * sI * day * ov + moonT[1] * mI * 0.85 * (1 - day),
      sunT[2] * sI * day * ov + moonT[2] * mI * 1.2 * (1 - day)];
    if (E.overcast > 0) { const k = 1 + E.overcast * 0.8; E.ambient = E.ambient.map(v => v * k); }
    // exposure: brighter at night
    const lum = E.sunColor[0] * 0.3 + E.sunColor[1] * 0.6 + E.sunColor[2] * 0.1 + (E.ambient[0] + E.ambient[1] + E.ambient[2]) * 0.4;
    // nights stay genuinely dark (moonlit, readable) so fires, flares and explosions light the scene
    // fixed exposure at night (auto-exposure would just brighten the darkness back up)
    E.exposure = lerp(clamp(1.9 / (lum + 0.05), 0.2, 9) * 0.55, 1.0, E.night);
  }
  transmittance(dir, alt, haze) {
    const Re = 6360e3, Ra = 6420e3;
    if (dir.y < -0.2) return [0, 0, 0];
    let px = 0, py = Re + alt, pz = 0;
    const b = py * dir.y, c = py * py - Ra * Ra; const tmax = -b + Math.sqrt(b * b - c);
    const N = 24, ds = tmax / N; let odR = 0, odM = 0;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) * ds; const x = dir.x * t, y = py + dir.y * t, z = dir.z * t;
      const h = Math.sqrt(x * x + y * y + z * z) - Re;
      if (h < 0) return [0, 0, 0];
      odR += Math.exp(-h / 8000) * ds; odM += Math.exp(-h / 1200) * ds;
    }
    const bM = 21e-6 * haze * 1.1;
    return [Math.exp(-(5.8e-6 * odR + bM * odM)), Math.exp(-(13.5e-6 * odR + bM * odM)), Math.exp(-(33.1e-6 * odR + bM * odM))];
  }

  // ---------- frame ----------
  setupCamera(cam) {
    const w = this.targetsW, h = this.targetsH, aspect = w / h;
    if (GLX.reversedZ) M4.perspRevInf(this.P, cam.fov, aspect, cam.near);
    else M4.persp(this.P, cam.fov, aspect, cam.near, 250000);
    M4.viewRot(this.Vr, cam.q);
    M4.mul(this.VP, this.P, this.Vr);
    M4.invert(this.invVP, this.VP);
    // frustum side planes (camera-relative)
    const m = this.VP;
    const rows = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
    const r0 = rows(0), r1 = rows(1), r3 = rows(3);
    const set = (pl, a, s) => { pl[0] = r3[0] + s * a[0]; pl[1] = r3[1] + s * a[1]; pl[2] = r3[2] + s * a[2]; pl[3] = r3[3] + s * a[3]; const l = Math.hypot(pl[0], pl[1], pl[2]); for (let k = 0; k < 4; k++) pl[k] /= l; };
    set(this.planes[0], r0, 1); set(this.planes[1], r0, -1); set(this.planes[2], r1, 1); set(this.planes[3], r1, -1);
  }

  setupShadow(center, cam) {
    const E = this.env, L = E.lightDir;
    const R = 70; const D = 600;
    const cx = center.x - cam.pos.x, cy = center.y - cam.pos.y, cz = center.z - cam.pos.z;
    // texel snapping in light space
    const view = M4.lookAt(this.tmpM, cx + L.x * D, cy + L.y * D, cz + L.z * D, cx, cy, cz, Math.abs(L.y) > 0.99 ? 1 : 0, Math.abs(L.y) > 0.99 ? 0 : 1, 0);
    const proj = M4.ortho(M4.create(), -R, R, -R, R, 1, D * 2);
    M4.mul(this.shadowVP, proj, view);
    // snap the WORLD origin onto the shadow texel grid so texels stay fixed in the world
    // (camera-relative snapping makes shadow edges crawl as you move)
    const o = M4.transformPoint(this.shadowVP, -cam.pos.x, -cam.pos.y, -cam.pos.z, [0, 0, 0, 0]);
    const sx = o[0] * this.shadowSize / 2, sy = o[1] * this.shadowSize / 2;
    const dx = (Math.round(sx) - sx) * 2 / this.shadowSize, dy = (Math.round(sy) - sy) * 2 / this.shadowSize;
    this.shadowVP[12] += dx; this.shadowVP[13] += dy;
    this.shadowTexel = 1 / this.shadowSize;
  }

  writeUBO(cam) {
    const u = this.uboData, E = this.env;
    u.set(this.VP, 0); u.set(this.shadowVP, 16);
    u[32] = cam.pos.x; u[33] = cam.pos.y; u[34] = cam.pos.z; u[35] = this.time;
    u[36] = E.lightDir.x; u[37] = E.lightDir.y; u[38] = E.lightDir.z; u[39] = E.daylight;
    u[40] = E.sunColor[0]; u[41] = E.sunColor[1]; u[42] = E.sunColor[2]; u[43] = E.exposure;
    u[44] = E.ambient[0]; u[45] = E.ambient[1]; u[46] = E.ambient[2]; u[47] = 1;
    u[48] = E.fog; u[49] = 1600 + E.haze * 300; u[50] = E.haze; u[51] = E.night;
    u[52] = this.targetsW; u[53] = this.targetsH; u[54] = 1 / this.targetsW; u[55] = 1 / this.targetsH;
    // shadow: enabled, texel, PCSS blocker-search radius (uv), penumbra factor = depthRange*tan(sun size)/boxWidth
    u[56] = this.shadowOn ? 1 : 0; u[57] = this.shadowTexel || 0.001; u[58] = 0.008; u[59] = 1199 * Math.tan(1.15 * DEG) / 140;
    u[60] = this.windV ? this.windV.x : 0; u[61] = 0; u[62] = this.windV ? this.windV.z : 0; u[63] = E.cover;
    const f = _t1.set(0, 0, -1).applyQuat(cam.q);
    u[64] = f.x; u[65] = f.y; u[66] = f.z; u[67] = Math.tan(cam.fov / 2);
    const C = this.clouds;
    u[68] = C.base; u[69] = C.top; u[70] = C.cover; u[71] = C.density;
    u[72] = C.windX; u[73] = C.windZ; u[74] = CLOUD_TILE; u[75] = C.shadow * E.daylight;
    u[76] = this.packLights(this.curFx, cam, u, 80); u[77] = u[78] = u[79] = 0;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, u);
  }
  bindFrame() { }
  // pick the most relevant dynamic lights (bright and/or close to the camera), camera-relative
  packLights(fx, cam, u, base) {
    const n = fx ? Math.min(fx.nDyn, 64) : 0, D = fx ? fx.dyn : null, idx = this.lightIdx, sc = this.lightScore;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 8, I = D[o + 6];
      const dx = D[o] - cam.pos.x, dy = D[o + 1] - cam.pos.y, dz = D[o + 2] - cam.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz), R = Math.sqrt(I / 0.01);
      if (d - R > 15000) continue;
      const e = Math.max(d - R * 0.25, 1);
      idx[m] = o; sc[m] = I / (e * e + 2500); m++;
    }
    const k = Math.min(m, MAX_LIGHTS);
    for (let a = 0; a < k; a++) {   // partial selection sort: top k by score
      let b = a; for (let c = a + 1; c < m; c++) if (sc[c] > sc[b]) b = c;
      const ti = idx[a], ts = sc[a]; idx[a] = idx[b]; sc[a] = sc[b]; idx[b] = ti; sc[b] = ts;
      const o = idx[a], q = base + a * 8, I = D[o + 6];
      u[q] = D[o] - cam.pos.x; u[q + 1] = D[o + 1] - cam.pos.y; u[q + 2] = D[o + 2] - cam.pos.z; u[q + 3] = Math.sqrt(I / 0.01);
      u[q + 4] = D[o + 3] * I; u[q + 5] = D[o + 4] * I; u[q + 6] = D[o + 5] * I; u[q + 7] = Math.max(D[o + 7] * D[o + 7], 4);
    }
    return k;
  }

  modelMatrix(out, q, pos, cam, s = 1) { return M4.fromQuatPos(out, q, pos.x - cam.pos.x, pos.y - cam.pos.y, pos.z - cam.pos.z, s); }

  drawAircraftList(S, shadowPass) {
    const cam = S.camera;
    const p = shadowPass ? this.pMeshShadow.use() : this.pMesh.use();
    if (!shadowPass) {
      p.tex('uSky', this.skyTex).tex('uShadow', this.shadowTex).tex('uAlbedo', this.deckTex);
      this.bindClouds(p);
      p.f('uAeroView', 0); p.v4('uDmg', 0, 0, 0, 0); p.set('uHits', NO_HITS); p.f('uEmissiveBoost', 0); p.f('uAlpha', 0);
    } else p.set('uLightVP', this.shadowVP);
    for (const ac of S.aircraft) {
      if (!ac.visible) continue;
      const d = ac.pos.distTo(cam.pos);
      if (shadowPass && d > 220) continue;
      if (!shadowPass && this.isCulled(ac.pos, ac.geo.radius, cam)) continue;
      const mesh = this.aircraftMesh(ac);
      this.modelMatrix(this.model, ac.q, ac.pos, cam);
      p.set('uModel', this.model);
      p.set('uParts', ac.partMats);
      if (!shadowPass) {
        const P = ac.spec.paint;
        if (P.camo) p.v4('uCamo1', P.camo[0][0], P.camo[0][1], P.camo[0][2], P.camo[2]); else p.v4('uCamo1', 0, 0, 0, 0);
        if (P.camo) p.v4('uCamo2', P.camo[1][0], P.camo[1][1], P.camo[1][2], 0);
        const rd = new Float32Array(16); ac.geo.roundels.forEach((r, i) => { if (i < 4 && P.roundel) rd.set(r, i * 4); });
        p.set('uRoundel', rd);
        if (P.roundel) p.set('uRoundelCol', new Float32Array([].concat(P.roundel[0], P.roundel[1], P.roundel[2])));
        p.f('uAeroView', (S.aeroView && ac === S.player) ? 1 : 0);
        p.set('uSurfVal', ac.surfVals);
        // destroyed: fully charred and burning (embers fade as the wreck cools); damaged: localized to the hits
        const burn = ac.alive ? (ac.fire ? 0.7 : 0) : clamp(1.1 - ac.deadT / 25, 0.35, 1);
        p.v4('uDmg', ac.alive ? clamp(1 - ac.hp / ac.maxHp, 0, 1) * 0.42 : 1, burn, ac.seed, 0);
        p.set('uHits', ac.hits);
      }
      mesh.draw();
      this.stats.draws++;
    }
    // missiles in flight
    if (S.weapons) {
      p.set('uParts', this.identParts);
      if (!shadowPass) { p.v4('uCamo1', 0, 0, 0, 0); p.f('uAeroView', 0); p.v4('uDmg', 0, 0, 0, 0); p.set('uHits', NO_HITS); p.set('uRoundel', new Float32Array(16)); }
      for (const m of S.weapons.missiles) {
        if (!m.active) continue;
        if (shadowPass && m.pos.distTo(cam.pos) > 220) continue;
        const q = _qa.setFromBasis(m.dir, Math.abs(m.dir.y) > 0.98 ? _t2.set(1, 0, 0) : _t2.set(0, 1, 0));
        this.modelMatrix(this.model, q, m.pos, cam);
        p.set('uModel', this.model);
        this.missileMeshes[m.kind].draw();
      }
    }
  }

  isCulled(pos, r, cam) {
    const x = pos.x - cam.pos.x, y = pos.y - cam.pos.y, z = pos.z - cam.pos.z;
    for (const pl of this.planes) if (pl[0] * x + pl[1] * y + pl[2] * z + pl[3] < -r) return true;
    return false;
  }

  render(S, dt) {
    this.time += dt; this.frameNo++; this.curFx = S.fx;
    this.stats.draws = 0;
    const cam = S.camera, world = this.world, E = this.env;
    if (S.wind) this.clouds.advance(S.wind, dt);
    this.ensureTargets();
    this.updateSky(cam.pos.y);
    this.windV = S.wind;
    this.setupCamera(cam);
    // terrain LOD selection & trees
    world.terrain.select(cam.pos, this.planes);
    if (world.trees.update(cam.pos, 3)) { gl.bindBuffer(gl.ARRAY_BUFFER, this.treeBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, world.trees.buf, 0, world.trees.count * 6); }
    // ---- shadow pass ----
    const focus = S.shadowFocus || cam.pos;
    this.shadowOn = E.daylight > 0.02 && focus.distTo(cam.pos) < 400;
    if (this.shadowOn) {
      this.setupShadow(focus, cam);
      setClipReversed(false);
      this.shadowTgt.bind();
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
      gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 2.0);
      gl.disable(gl.CULL_FACE);
      this.drawAircraftList(S, true);
      // carrier in shadow pass
      const C = world.carrier;
      if (C.pos.distTo(focus) < 600) {
        const p = this.pMeshShadow.use(); p.set('uLightVP', this.shadowVP); p.set('uParts', this.identParts);
        this.modelMatrix(this.model, C.q, C.pos, cam); p.set('uModel', this.model); this.carrierMesh.draw();
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    this.writeUBO(cam);
    // grass fades out with altitude (blades are sub-pixel from higher up)
    this.grassFade = this.q.grass ? 1 - smooth(70, 220, cam.pos.y - Math.max(world.terrain.heightAt(cam.pos.x, cam.pos.z), 0)) : 0;
    if (this.grassFade > 0) this.updateGrassMask(cam, world);
    if (this.q.waves && this.ocean.ok) this.ocean.update(this.time);
    // ---- main pass ----
    setClipReversed(GLX.reversedZ);
    this.msT.bind();
    gl.depthMask(true);
    if (GLX.reversedZ) { gl.clearDepth(0); gl.depthFunc(gl.GEQUAL); } else { gl.clearDepth(1); gl.depthFunc(gl.LEQUAL); }
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // sky
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    { const p = this.pSky.use(); p.tex('uSky', this.skyTex); p.set('uInvVP', this.invVP); p.v3('uMoonDir', E.moonDir.x, E.moonDir.y, E.moonDir.z); drawFullscreen(); }
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
    // terrain (CDLOD grid winding: draw both sides to be safe)
    gl.disable(gl.CULL_FACE);
    world.terrain.draw(this, world);
    if (this.q.waves) this.drawOcean(cam, world);
    // buildings
    { const p = this.pBox.use(); p.tex('uSky', this.skyTex).tex('uShadow', this.shadowTex); this.bindClouds(p); p.i('uShadowPass', 0); this.boxMesh.drawInstanced(this.nBoxes); }
    // trees
    if (world.trees.count > 0 && cam.pos.y - Math.max(0, world.terrain.heightAt(cam.pos.x, cam.pos.z)) < 4000) {
      const p = this.pTree.use(); p.tex('uSky', this.skyTex).tex('uShadow', this.shadowTex).tex('uTShadow', world.terrain.sTex); this.bindClouds(p);
      p.v4('uHMap', TERRAIN.ORIGIN, TERRAIN.ORIGIN, 1 / TERRAIN.SIZE, TERRAIN.RES); p.f('uMaxDist', world.trees.maxDist);
      this.treeMesh.drawInstanced(world.trees.count);
    }
    if (this.q.grass) this.drawGrass(S, cam, world);
    // carrier
    {
      const C = world.carrier;
      if (!this.isCulled(C.pos, 200, cam)) {
        const p = this.pMesh.use(); p.tex('uSky', this.skyTex).tex('uShadow', this.shadowTex).tex('uAlbedo', this.deckTex); this.bindClouds(p);
        p.set('uParts', this.identParts); p.v4('uCamo1', 0, 0, 0, 0); p.f('uAeroView', 0); p.v4('uDmg', 0, 0, 0, 0); p.set('uHits', NO_HITS); p.f('uAlpha', 0); p.set('uRoundel', new Float32Array(16));
        this.modelMatrix(this.model, C.q, C.pos, cam); p.set('uModel', this.model); this.carrierMesh.draw();
      }
    }
    // aircraft + missiles
    this.drawAircraftList(S, false);
    // ---- transparent ----
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    // prop discs
    {
      const p = this.pMesh.use(); p.set('uParts', this.identParts); p.f('uAlpha', 0.22); p.v4('uCamo1', 0, 0, 0, 0); p.f('uAeroView', 0);
      for (const ac of S.aircraft) {
        const dm = this.discMeshes[ac.spec.id]; if (!dm || !ac.visible) continue;
        const rf = ac.fm.eng.rpm / ac.spec.engine.rpm; if (rf < 0.3) continue;
        this.modelMatrix(this.model, ac.q, ac.pos, cam); p.set('uModel', this.model); dm.draw();
      }
      p.f('uAlpha', 0);
    }
    // particles
    const fx = S.fx;
    // afterburner flames (additive)
    if (fx.nFlames) {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flameBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, fx.flames, 0, fx.nFlames * 12);
      const p = this.pFlame.use(); p.tex('uNoise', this.noise3D, gl.TEXTURE_3D);
      this.flameMesh.drawInstanced(fx.nFlames);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    if (fx.nInst) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleMesh.ib); gl.bufferSubData(gl.ARRAY_BUFFER, 0, fx.inst, 0, fx.nInst * 12);
      const p = this.pParticle.use(); p.tex('uSky', this.skyTex).tex('uAtlas', this.atlasTex); this.bindClouds(p);
      this.particleMesh.drawInstanced(fx.nInst);
    }
    // beams
    if (fx.nBeams) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.beamBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, fx.beams, 0, fx.nBeams * 14);
      const p = this.pBeam.use(); p.tex('uSky', this.skyTex);
      this.beamMesh.drawInstanced(fx.nBeams);
    }
    // glows: static lights + dynamic
    {
      const p = this.pGlow.use(); p.f('uMinPx', 2.2); p.f('uDayDim', 0.12);
      this.staticGlowMesh.drawInstanced(this.nStaticGlows);
      if (fx.nGlows) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.glowMesh.ib); gl.bufferSubData(gl.ARRAY_BUFFER, 0, fx.glows, 0, fx.nGlows * 8);
        p.f('uDayDim', 0.85);
        this.glowMesh.drawInstanced(fx.nGlows);
      }
    }
    gl.depthMask(true); gl.disable(gl.BLEND);
    // ---- resolve + post ----
    this.msT.resolveTo(this.resT, true);
    setClipReversed(false);
    gl.disable(gl.DEPTH_TEST);
    // ---- volumetric clouds: raymarch at reduced res, then depth-aware composite over the scene ----
    {
      const ct = this.cloudT;
      ct.bind();
      const near = cam.near, far = 250000;
      const p = this.pCloudVol.use();
      p.tex('uSky', this.skyTex).tex('uDepth', this.resT.depth); this.bindClouds(p);
      p.set('uInvVP', this.invVP); p.f('uSteps', this.q.cloudSteps); p.f('uFrame', this.frameNo % 64); p.f('uPixAng', 2 * Math.tan(cam.fov / 2) / ct.h);
      p.f('uNear', near); p.f('uFar', far); p.f('uRevZ', GLX.reversedZ ? 1 : 0);
      drawFullscreen();
      // temporal accumulation (history ping-pong)
      const prev = this.cloudHist[this.histIdx], next = this.cloudHist[1 - this.histIdx];
      const jump = this.prevCam.distTo(cam.pos) > 250;
      next.bind();
      const tp = this.pCloudTemporal.use();
      tp.tex('uCur', ct.tex[0]).tex('uCurDist', ct.tex[1]).tex('uHist', prev.tex[0]).tex('uHistDist', prev.tex[1]);
      tp.set('uInvVP', this.invVP); tp.set('uPrevVP', this.prevVP);
      tp.v3('uCamDelta', cam.pos.x - this.prevCam.x, cam.pos.y - this.prevCam.y, cam.pos.z - this.prevCam.z);
      tp.v2('uTexel', 1 / ct.w, 1 / ct.h); tp.f('uHistW', this.histValid && !jump ? 0.9 : 0);
      drawFullscreen();
      this.histIdx = 1 - this.histIdx; this.histValid = true;
      this.prevVP.set(this.VP); this.prevCam.copy(cam.pos);
      this.cloudOut = next;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.resColorFB); gl.viewport(0, 0, this.resT.w, this.resT.h);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const c = this.pCloudComp.use();
      c.tex('uCloudTex', next.tex[0]).tex('uCloudDist', next.tex[1]).tex('uDepth', this.resT.depth);
      c.set('uInvVP', this.invVP); c.f('uNear', near); c.f('uFar', far); c.f('uRevZ', GLX.reversedZ ? 1 : 0);
      drawFullscreen();
      gl.disable(gl.BLEND);
    }
    const bl = this.bloomT;
    if (this.q.bloom) {
      bl[0].bind(); this.pBright.use().tex('uSrc', this.resT.tex[0]).v2('uTexel', 1 / this.resT.w, 1 / this.resT.h).f('uThresh', 1.6 / Math.max(E.exposure, 0.05));
      drawFullscreen();
      for (let i = 1; i < bl.length; i++) { bl[i].bind(); this.pDown.use().tex('uSrc', bl[i - 1].tex[0]).v2('uTexel', 1 / bl[i - 1].w, 1 / bl[i - 1].h); drawFullscreen(); }
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = bl.length - 1; i > 0; i--) { bl[i - 1].bind(); this.pUp.use().tex('uSrc', bl[i].tex[0]).v2('uTexel', 1 / bl[i].w, 1 / bl[i].h).f('uWeight', 0.85); drawFullscreen(); }
      gl.disable(gl.BLEND);
    }
    // composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const p = this.pComp.use();
    p.tex('uScene', this.resT.tex[0]).tex('uBloom', bl[0].tex[0]).tex('uDepth', this.resT.depth).tex('uCloudTex', this.cloudOut ? this.cloudOut.tex[0] : this.cloudT.tex[0]);
    // sun screen position
    const sp = M4.transformPoint(this.VP, E.sunDir.x * 1000, E.sunDir.y * 1000, E.sunDir.z * 1000, [0, 0, 0, 0]);
    const sunVis = sp[3] > 0 && Math.abs(sp[0]) < 1.3 && Math.abs(sp[1]) < 1.3 ? smooth(1.3, 0.9, Math.max(Math.abs(sp[0]), Math.abs(sp[1]))) * smooth(-0.03, 0.05, E.sunDir.y) : 0;
    p.v3('uSunScreen', sp[0] * 0.5 + 0.5, sp[1] * 0.5 + 0.5, sunVis);
    p.f('uBloomAmt', this.q.bloom ? 0.09 : 0); p.f('uExposure', E.exposure); p.f('uGLoc', S.gloc || 0); p.f('uRedout', S.redout || 0);
    p.f('uDamageFx', S.damageFx || 0); p.f('uGrain', 0.012); p.f('uVig', 0.9); p.f('uFlare', S.cockpit ? 0.6 : 1.0); p.f('uFade', S.fade === undefined ? 1 : S.fade);
    p.f('uClearDepth', GLX.reversedZ ? 0 : 1);
    drawFullscreen();
  }
}
const _qa2 = new Quat();
