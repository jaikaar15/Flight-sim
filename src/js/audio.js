'use strict';
// ---------------------------------------------------------------------------
// Procedural audio (WebAudio): engines, wind, guns, missiles, explosions,
// cockpit tones (seeker growl / lock, missile warning, stall horn).
// ---------------------------------------------------------------------------
class SoundSystem {
  constructor() {
    this.ctx = null; this.volume = 0.8; this.musicVol = 0.5; this.jetVol = 1; this.propVol = 1; this.windVol = 1; this.ready = false; this.lastGun = 0;
    // Backing music: Erik Satie, Gymnopedie No. 1 (1888, public domain), looped.
    this.music = new Audio('audio/gymnopedie_no1.mp3');
    this.music.loop = true; this.music.preload = 'auto';
    this._applyMusicVol();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.music.pause(); else if (this.ready) this.playMusic(); });
  }
  _applyMusicVol() { this.music.volume = Math.max(0, Math.min(1, this.volume * this.musicVol * 0.7)); }
  playMusic() { if (this.musicVol > 0 && this.music.paused) { const p = this.music.play(); if (p && p.catch) p.catch(() => { }); } else if (this.musicVol <= 0) this.music.pause(); }
  setMusicVolume(v) { this.musicVol = v; this._applyMusicVol(); if (this.ready) this.playMusic(); }
  setEngineVolumes(jet, prop, wind = this.windVol) {
    this.jetVol = jet; this.propVol = prop; this.windVol = wind;
    if (!this.jetTrim) return;
    const t = this.ctx.currentTime;
    for (const [g, v] of [[this.jetTrim, jet], [this.propTrim, prop], [this.windTrim, wind]]) {
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(v, t + 0.08); // exact 0 when off
    }
  }
  init() {
    this.playMusic();
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp); comp.connect(c.destination);
    // per-engine-type trims (Settings → Jet / Prop engine volume)
    this.jetTrim = c.createGain(); this.jetTrim.gain.value = this.jetVol; this.jetTrim.connect(this.master);
    this.propTrim = c.createGain(); this.propTrim.gain.value = this.propVol; this.propTrim.connect(this.master);
    this.windTrim = c.createGain(); this.windTrim.gain.value = this.windVol; this.windTrim.connect(this.master);
    // noise buffers
    const len = c.sampleRate * 2;
    this.white = c.createBuffer(1, len, c.sampleRate);
    const d = this.white.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.brown = c.createBuffer(1, len, c.sampleRate);
    const b = this.brown.getChannelData(0); let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    const loop = (buf) => { const s = c.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
    // ---- jet engine ----
    this.jet = c.createGain(); this.jet.gain.value = 0; this.jet.connect(this.jetTrim);
    const jn = loop(this.white); this.jetBP = c.createBiquadFilter(); this.jetBP.type = 'bandpass'; this.jetBP.Q.value = 0.8; jn.connect(this.jetBP);
    this.jetBPg = c.createGain(); this.jetBP.connect(this.jetBPg); this.jetBPg.connect(this.jet);
    const rn = loop(this.brown); this.jetLP = c.createBiquadFilter(); this.jetLP.type = 'lowpass'; this.jetLP.frequency.value = 180; rn.connect(this.jetLP);
    this.abGain = c.createGain(); this.abGain.gain.value = 0; this.jetLP.connect(this.abGain); this.abGain.connect(this.jet);
    this.whine = c.createOscillator(); this.whine.type = 'sine'; this.whineG = c.createGain(); this.whineG.gain.value = 0; this.whine.connect(this.whineG); this.whineG.connect(this.jet); this.whine.start();
    // ---- piston engine ----
    this.prop = c.createGain(); this.prop.gain.value = 0;
    const pl = c.createBiquadFilter(); pl.type = 'lowpass'; pl.frequency.value = 900; this.propLP = pl;
    const ws = c.createWaveShaper(); const curve = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 3); } ws.curve = curve;
    this.p1 = c.createOscillator(); this.p1.type = 'sawtooth'; this.p2 = c.createOscillator(); this.p2.type = 'square';
    const g1 = c.createGain(); g1.gain.value = 0.5; const g2 = c.createGain(); g2.gain.value = 0.25;
    this.p1.connect(g1); this.p2.connect(g2); g1.connect(ws); g2.connect(ws); ws.connect(pl); pl.connect(this.prop);
    // prop whoosh (amplitude modulated noise)
    const pn = loop(this.white); const pbp = c.createBiquadFilter(); pbp.type = 'bandpass'; pbp.frequency.value = 500; pbp.Q.value = 0.6; pn.connect(pbp);
    this.whooshAM = c.createGain(); this.whooshAM.gain.value = 0.3; pbp.connect(this.whooshAM); this.whooshAM.connect(this.prop);
    this.amOsc = c.createOscillator(); this.amOsc.frequency.value = 30; const amD = c.createGain(); amD.gain.value = 0.25; this.amOsc.connect(amD); amD.connect(this.whooshAM.gain); this.amOsc.start();
    this.p1.start(); this.p2.start(); this.prop.connect(this.propTrim);
    // ---- wind ----
    const wn = loop(this.white); this.windBP = c.createBiquadFilter(); this.windBP.type = 'bandpass'; this.windBP.Q.value = 0.5; wn.connect(this.windBP);
    this.wind = c.createGain(); this.wind.gain.value = 0; this.windBP.connect(this.wind); this.wind.connect(this.windTrim);
    // ---- gun loop ----
    this.gunG = c.createGain(); this.gunG.gain.value = 0; this.gunG.connect(this.master);
    this.gunSrc = null; this.gunRof = 0;
    // ---- tones ----
    this.tone = c.createOscillator(); this.tone.type = 'sine'; this.toneG = c.createGain(); this.toneG.gain.value = 0; this.tone.connect(this.toneG); this.toneG.connect(this.master); this.tone.start();
    this.trem = c.createOscillator(); this.trem.frequency.value = 22; this.tremG = c.createGain(); this.tremG.gain.value = 0; this.trem.connect(this.tremG); this.tremG.connect(this.toneG.gain); this.trem.start();
    this.warn = c.createOscillator(); this.warn.type = 'square'; this.warnG = c.createGain(); this.warnG.gain.value = 0; const wlp = c.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 2500; this.warn.connect(wlp); wlp.connect(this.warnG); this.warnG.connect(this.master); this.warn.start();
    this.ready = true;
  }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; this._applyMusicVol(); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  makeGunBuffer(rof, cal) {
    const c = this.ctx, dur = 1.0, sr = c.sampleRate, buf = c.createBuffer(1, sr * dur, sr), d = buf.getChannelData(0);
    const period = sr / rof; const decay = cal > 1 ? 0.012 : 0.006;
    for (let i = 0; i < d.length; i++) {
      const ph = (i % period) / sr;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-ph / decay) * (0.8 + 0.2 * Math.sin(ph * 900));
    }
    return buf;
  }

  update(dt, ac, opts) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime, fm = ac.fm, E = ac.spec.engine;
    const inside = opts.cockpit ? 0.55 : 1;
    const alive = ac.alive && !fm.crashed;
    // engines
    if (E.type === 'jet') {
      const n = fm.eng.n;
      this.jet.gain.setTargetAtTime(alive ? (0.25 + n * 0.55) * inside : 0, t, 0.1);
      this.jetBP.frequency.setTargetAtTime(250 + n * 1200, t, 0.1);
      this.jetBPg.gain.setTargetAtTime(0.35 + n * 0.3, t, 0.1);
      this.abGain.gain.setTargetAtTime(fm.eng.ab * 1.6 + n * 0.4, t, 0.15);
      this.whine.frequency.setTargetAtTime(1800 + n * 3800, t, 0.2);
      this.whineG.gain.setTargetAtTime(0.012 + n * 0.02, t, 0.2);
      this.prop.gain.setTargetAtTime(0, t, 0.1);
    } else if (E.type === 'prop') {
      const rpm = fm.eng.rpm, f = rpm / 60 * (E.power > 500000 ? 6 : 2) * (E.power > 500000 ? 2 : 1.5);
      this.p1.frequency.setTargetAtTime(Math.max(f, 10), t, 0.05); this.p2.frequency.setTargetAtTime(Math.max(f * 0.5, 5), t, 0.05);
      this.amOsc.frequency.setTargetAtTime(rpm / 60 * E.blades, t, 0.05);
      const load = fm.ctl.throttle;
      this.propLP.frequency.setTargetAtTime(300 + load * 1500, t, 0.1);
      this.prop.gain.setTargetAtTime(alive ? (0.12 + load * 0.35) * Math.min(rpm / E.rpm * 1.5, 1) * inside : 0, t, 0.08);
      this.jet.gain.setTargetAtTime(0, t, 0.1);
    } else { this.jet.gain.setTargetAtTime(0, t, 0.1); this.prop.gain.setTargetAtTime(0, t, 0.1); }
    // wind
    const q = fm.out.qbar;
    this.wind.gain.setTargetAtTime(Math.min(0.9, Math.sqrt(q) / 260) * (opts.cockpit ? 0.7 : 1) + (fm.out.stallFrac > 0.3 ? 0.15 : 0), t, 0.1);
    this.windBP.frequency.setTargetAtTime(200 + fm.out.tas * 6, t, 0.1);
    // guns
    const G = ac.spec.guns;
    if (G && ac.wpn.firing && alive) {
      if (!this.gunSrc || this.gunRof !== G.rof) {
        if (this.gunSrc) this.gunSrc.stop();
        const s = c.createBufferSource(); s.buffer = this.makeGunBuffer(Math.min(G.rof, 110), G.cal); s.loop = true;
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = G.cal > 1 ? 900 : 2200;
        s.connect(f); f.connect(this.gunG); s.start(); this.gunSrc = s; this.gunRof = G.rof;
      }
      this.gunG.gain.setTargetAtTime(0.9, t, 0.01);
    } else this.gunG.gain.setTargetAtTime(0, t, 0.03);
    // seeker / lock tones
    const W = ac.wpn;
    let tf = 0, tg = 0, trem = 0;
    if ((W.sel === 'ir' || W.sel === 'radar') && W[W.sel] > 0 && alive) {
      if (W.lockState === 2) { tf = W.sel === 'ir' ? 1500 : 1100; tg = 0.07; }
      else if (W.lockState === 1) { tf = W.sel === 'ir' ? 900 : 700; tg = 0.05; trem = 0.04; }
      else if (W.sel === 'ir') { tf = 420; tg = 0.025; trem = 0.02; }
    }
    this.tone.frequency.setTargetAtTime(tf || 400, t, 0.02);
    this.toneG.gain.setTargetAtTime(tg, t, 0.03); this.tremG.gain.setTargetAtTime(trem, t, 0.03);
    // warnings
    let wf = 0, wg = 0;
    if (opts.missileWarn) { wf = (Math.floor(t * 8) & 1) ? 1250 : 850; wg = 0.06; }
    else if (opts.pullUp) { wf = (Math.floor(t * 4) & 1) ? 700 : 0; wg = wf ? 0.05 : 0; }
    else if (opts.stall) { wf = 380; wg = 0.05; }
    else if (opts.gearWarn) { wf = (Math.floor(t * 2) & 1) ? 600 : 0; wg = wf ? 0.035 : 0; }
    if (wf) this.warn.frequency.setValueAtTime(wf, t);
    this.warnG.gain.setTargetAtTime(wg, t, 0.02);
  }

  oneShot(kind, gain = 1, delay = 0) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime + delay;
    const src = c.createBufferSource(); src.buffer = kind === 'boom' ? this.brown : this.white;
    const f = c.createBiquadFilter(), g = c.createGain();
    src.connect(f); f.connect(g); g.connect(this.master);
    if (kind === 'boom') {
      f.type = 'lowpass'; f.frequency.setValueAtTime(900 * Math.min(1, gain + 0.3), t); f.frequency.exponentialRampToValueAtTime(60, t + 2.2);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(2.2 * gain + 0.001, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
      src.start(t, Math.random()); src.stop(t + 3);
    } else if (kind === 'launch') {
      f.type = 'bandpass'; f.Q.value = 0.7; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(300, t + 2.5);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9 * gain, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      src.start(t, Math.random()); src.stop(t + 2.7);
    } else if (kind === 'hit') {
      f.type = 'highpass'; f.frequency.value = 1500;
      g.gain.setValueAtTime(0.5 * gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      src.start(t, Math.random()); src.stop(t + 0.1);
    } else if (kind === 'thud') {
      f.type = 'lowpass'; f.frequency.value = 200;
      g.gain.setValueAtTime(0.8 * gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      src.start(t, Math.random()); src.stop(t + 0.3);
    } else if (kind === 'flare') {
      f.type = 'bandpass'; f.frequency.value = 2500; f.Q.value = 2;
      g.gain.setValueAtTime(0.25 * gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      src.start(t, Math.random()); src.stop(t + 0.2);
    } else if (kind === 'click') {
      f.type = 'highpass'; f.frequency.value = 3000;
      g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      src.start(t, Math.random()); src.stop(t + 0.05);
    }
  }
  say(text) {
    try { if (!window.speechSynthesis) return; const u = new SpeechSynthesisUtterance(text); u.rate = 1.15; u.pitch = 0.9; u.volume = Math.min(1, this.volume); speechSynthesis.speak(u); } catch (e) { }
  }
}
