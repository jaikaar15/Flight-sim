'use strict';
// ---------------------------------------------------------------------------
// FFT ocean (Tessendorf) for MAX quality.
// A JONSWAP wind sea with broad directional spreading plus a crossing swell is
// sampled into three cascades (1000 m / 120 m / 17 m patches, 256^2 each). Every
// frame the GPU advances the spectra in time and runs an inverse FFT, producing
// per cascade: choppy displacement + height + Jacobian (whitecaps), and slope
// moments whose mips give the slope variance used for the sun glint.
// ---------------------------------------------------------------------------
const OCEAN_N = 256;
const OCEAN_L = [1000, 120, 17];
const OCEAN_KCUT = [0, 0.3, 2.0, 32];      // wavenumber band handled by each cascade
const OCEAN_LOOP = 240;                    // seconds; frequencies are quantised to loop seamlessly

class FFTOcean {
  constructor() {
    this.ok = GLX.colorFloat;
    if (!this.ok) return;
    const N = OCEAN_N;
    const f32 = { ifmt: gl.RGBA32F, fmt: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST };
    this.h0 = makeTex(N, N * 3, f32);
    this.pp = [new Target(N, N * 3, [f32, f32], null), new Target(N, N * 3, [f32, f32], null)];
    const f16 = { ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR, wrap: gl.REPEAT, mips: true, aniso: 8 };
    this.casc = [0, 1, 2].map(() => new Target(N, N, [f16, f16], null));
    this.disp = this.casc.map(t => t.tex[0]);
    this.slope = this.casc.map(t => t.tex[1]);
    this.pSpec = new Program(FS_VS, SH.oceanSpecFS);
    this.pFFT = new Program(FS_VS, SH.oceanButterflyFS);
    this.pAsm = new Program(FS_VS, SH.oceanAsmFS);
    this.key = ''; this.sea = [0.002, 0, 1, 0]; this.chop = 1.25;
  }

  // wind (m/s vector), rough 0..1 (storminess) -> spectrum h0(k), uploaded once per weather change
  setSea(wind, rough = 0) {
    if (!this.ok) return;
    const Uw = wind ? Math.hypot(wind.x, wind.z) : 0;
    const U = Math.max(Uw, 4) * (1 + rough * 0.4);
    const wdir = Uw > 0.3 ? Math.atan2(wind.z, wind.x) : 0.4;
    const key = U.toFixed(2) + '|' + wdir.toFixed(2);
    if (key === this.key) return;
    this.key = key;
    const N = OCEAN_N, g = 9.81, fetch = 120000;
    // JONSWAP
    const alpha = 0.076 * Math.pow(U * U / (fetch * g), 0.22);
    const wp = 22 * Math.pow(g * g / (U * fetch), 1 / 3);
    const gamma = 3.3;
    // swell from distant weather, crossing the wind sea
    const swDir = wdir + 1.15, swK = 2 * Math.PI / 230, swHs = 1.0 + rough * 0.8, swSk = swK * 0.12, swSt = 0.16;
    const data = new Float32Array(N * N * 3 * 4);
    const rnd = mulberry32(90210);
    const gauss = () => { let u = 0, v = 0; while (u < 1e-9) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    let varH = 0;
    for (let c = 0; c < 3; c++) {
      const L = OCEAN_L[c], dk = 2 * Math.PI / L, k0 = OCEAN_KCUT[c], k1 = OCEAN_KCUT[c + 1];
      for (let ny = 0; ny < N; ny++) for (let nx = 0; nx < N; nx++) {
        const n = nx < N / 2 ? nx : nx - N, m = ny < N / 2 ? ny : ny - N;
        const kx = n * dk, kz = m * dk, k = Math.hypot(kx, kz);
        let psi = 0;
        if (k >= k0 && k < k1 && k > 0) {
          const w = Math.sqrt(g * k), dwdk = g / (2 * w);
          const sg = w <= wp ? 0.07 : 0.09;
          const r = Math.exp(-((w - wp) * (w - wp)) / (2 * sg * sg * wp * wp));
          const S = alpha * g * g / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
          // broad cos^2 spreading about the wind plus a weaker opposing sea: waves run every which way
          const th = Math.atan2(kz, kx) - wdir, ct = Math.cos(th);
          const D = (2 / Math.PI) * ct * ct * (ct > 0 ? 1 : 0.16);
          psi = S * dwdk * D / k;
          // swell: narrow in wavenumber and direction
          let dth = Math.atan2(kz, kx) - swDir; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
          const G = Math.exp(-((k - swK) * (k - swK)) / (2 * swSk * swSk)) / (Math.sqrt(2 * Math.PI) * swSk);
          const Ds = Math.exp(-dth * dth / (2 * swSt * swSt)) / (Math.sqrt(2 * Math.PI) * swSt);
          psi += swHs * swHs / 16 * G * Ds / k;
          psi *= Math.exp(-k * k * 0.0004);       // damp sub-decimetre ripples
        }
        const amp = Math.sqrt(psi / 2) * dk;
        varH += 2 * amp * amp;
        const o = ((c * N + ny) * N + nx) * 4;
        data[o] = gauss() * amp / Math.SQRT2; data[o + 1] = gauss() * amp / Math.SQRT2;
      }
    }
    // second channel pair: h0(-k) for the Hermitian partner
    for (let c = 0; c < 3; c++) for (let ny = 0; ny < N; ny++) for (let nx = 0; nx < N; nx++) {
      const o = ((c * N + ny) * N + nx) * 4, q = ((c * N + ((N - ny) % N)) * N + ((N - nx) % N)) * 4;
      data[o + 2] = data[q]; data[o + 3] = data[q + 1];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.h0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N * 3, gl.RGBA, gl.FLOAT, data);
    // unresolved ripples below the finest cascade (Cox-Munk-ish), whitecaps from the real wind, Hs
    this.sea = [0.0015 + 0.0006 * U, smooth(6, 13, Uw * (1 + rough * 0.4)), 4 * Math.sqrt(varH), 0];
  }

  update(time) {
    if (!this.ok || !this.key) return;
    const N = OCEAN_N;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    // 1) spectra at time t
    this.pp[0].bind();
    let p = this.pSpec.use();
    p.tex('uH0', this.h0); p.f('uTime', time % OCEAN_LOOP); p.v3('uL', OCEAN_L[0], OCEAN_L[1], OCEAN_L[2]); p.f('uW0', 2 * Math.PI / OCEAN_LOOP);
    drawFullscreen();
    // 2) inverse FFT: log2(N) stages along rows, then along each cascade's columns
    p = this.pFFT.use();
    let src = 0;
    for (const horiz of [1, 0]) {
      for (let sub = 2; sub <= N; sub *= 2) {
        const dst = 1 - src;
        this.pp[dst].bind();
        p.tex('uIn0', this.pp[src].tex[0]).tex('uIn1', this.pp[src].tex[1]);
        p.f('uSub', sub); p.i('uHoriz', horiz);
        drawFullscreen();
        src = dst;
      }
    }
    // 3) per-cascade displacement / Jacobian / slope moments, then mips (slope variance for the glint)
    p = this.pAsm.use();
    p.tex('uT0', this.pp[src].tex[0]).tex('uT1', this.pp[src].tex[1]); p.f('uChop', this.chop);
    for (let c = 0; c < 3; c++) { this.casc[c].bind(); p.i('uC', c); drawFullscreen(); }
    for (let c = 0; c < 3; c++) {
      gl.bindTexture(gl.TEXTURE_2D, this.disp[c]); gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, this.slope[c]); gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  bind(p) {
    p.tex('uOD0', this.disp[0]).tex('uOD1', this.disp[1]).tex('uOD2', this.disp[2]);
    p.tex('uOS0', this.slope[0]).tex('uOS1', this.slope[1]).tex('uOS2', this.slope[2]);
    p.v3('uOL', OCEAN_L[0], OCEAN_L[1], OCEAN_L[2]);
    p.v4('uOSea', this.sea[0], this.sea[1], this.sea[2], 0);
  }
}
