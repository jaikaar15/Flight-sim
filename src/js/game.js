'use strict';
// ---------------------------------------------------------------------------
// Game orchestration: loop, cameras, missions, events, scoring.
// ---------------------------------------------------------------------------
const PHYS_DT = 1 / 120;
const _t7 = new V3();

function native(msg) { try { window.webkit.messageHandlers.native.postMessage(JSON.stringify(msg)); } catch (e) { } }
function showError(e) {
  const s = (e && (e.stack || e.message)) || String(e);
  const el = document.getElementById('err'); if (el) el.textContent += s + '\n';
  native({ cmd: 'log', text: 'ERROR ' + s });
  console.error(e);
}
window.addEventListener('error', e => showError(e.error || e.message));
window.addEventListener('unhandledrejection', e => showError(e.reason));
// loader yield; rAF never fires in a hidden/minimized window, so fall back to a timer there
const nextFrame = () => new Promise(r => document.hidden ? setTimeout(r, 0) : requestAnimationFrame(() => setTimeout(r, 0)));

const Game = {
  state: 'loading', aircraft: [], player: null, mode: 'free',
  camera: { pos: new V3(0, 100, 0), q: new Quat(), fov: 72 * DEG, near: 0.5, mode: 'chase', sq: new Quat(), lookYaw: 0, lookPitch: 0, zoom: 1, orbitYaw: 0.6, orbitPitch: 0.2, flyby: null, shake: 0 },
  warn: {}, aeroView: false, gl: 0, rd: 0, fires: [], streams: null,

  async init() {
    const prog = (p, t) => { document.getElementById('loadFill').style.width = (p * 100) + '%'; document.getElementById('loadStatus').textContent = t; };
    prog(0.05, 'COMPILING SHADERS'); await nextFrame();
    this.renderer = new Renderer(document.getElementById('gl'));
    this.hud = new HUD(document.getElementById('hud'));
    this.input = new Input();
    this.audio = new SoundSystem();
    this.fx = new Effects();
    this.weapons = new Weapons(this);
    prog(0.25, 'GENERATING TERRAIN · 40 × 40 KM'); await nextFrame();
    this.world = new World();
    this.world.generate();
    prog(0.55, 'BUILDING AIRFIELDS & CARRIER'); await nextFrame();
    this.renderer.setWorld(this.world);
    prog(0.7, 'TRIMMING AIRFRAMES'); await nextFrame();
    for (const a of AIRCRAFT) prepareSpec(a);
    prog(0.85, 'BAKING ATMOSPHERE'); await nextFrame();
    UI.init(this);
    this.renderer.setQuality(UI.settings.quality);
    this.envKey = '';
    this.showcase(UI.cfg);
    prog(1, 'READY'); await nextFrame();
    document.getElementById('sysinfo').innerHTML = `WEBGL2 · ${GLX.reversedZ ? 'REVERSED-Z' : 'STD-Z'} · ${GLX.colorFloat ? 'HDR' : 'LDR'} · MSAA ${Math.min(this.renderer.q.msaa, GLX.maxSamples)}×<br>12 AIRFRAMES · 6 AIRFIELDS · 1 CARRIER<br>V1.0`;
    UI.show('menu');
    this.state = 'menu';
    const wake = () => { this.audio.init(); };
    window.addEventListener('mousedown', wake); window.addEventListener('keydown', wake);
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'flight') this.pause(); });
    this.last = performance.now(); this.ft = 16;
    requestAnimationFrame(t => this.loop(t));
  },

  // ---------- environment ----------
  applyEnv(cfg) {
    const W = WEATHER[cfg.wx];
    const key = cfg.tod + '|' + cfg.wx;
    const ws = cfg.wind * 0.5144, wd = cfg.wdir * DEG;
    this.wind = new V3(-Math.sin(wd) * ws, 0, Math.cos(wd) * ws);
    this.turb = cfg.turb;
    this.fx.wind.copy(this.wind);
    this.renderer.setSea(this.wind, W.overcast || 0);
    this.overcastAlt = 1500;
    if (key === this.envKey) return;
    this.envKey = key;
    this.renderer.setEnvironment({ time: cfg.tod, haze: W.haze, cover: W.cover, overcast: W.overcast, cloudBase: W.overcast ? 2400 : 1500 });
  },
  windAt(p, agl) {
    const k = agl < 300 ? Math.max(0.15, Math.log(Math.max(agl, 0.5) / 0.05) / Math.log(300 / 0.05)) : 1 + (p.y - 300) / 8000;
    return _t6.copy(this.wind).scale(k);
  },

  // ---------- spawning ----------
  groundStance(ac) {
    const legs = ac.fm.gear;
    let F = legs[0], R = legs[0];
    for (const g of legs) { if (g.p.z < F.p.z) F = g; if (g.p.z > R.p.z) R = g; }
    const yF = F.p.y - F.len - F.r, yR = R.p.y - R.len - R.r;
    // tan(theta) = (yF - yR) / (zF - zR); plain atan keeps theta in (-90°, 90°)
    const dz = F.p.z - R.p.z;
    const th = Math.abs(dz) > 1e-3 ? Math.atan((yF - yR) / dz) : 0;
    const h = -(yF * Math.cos(th) - F.p.z * Math.sin(th));
    return { pitch: th * RAD, h: h + 0.04 };
  },
  mainRunway(ap) { return this.world.runways.find(r => r.ap === ap && r.def.main) || this.world.runways.find(r => r.ap === ap); },
  spawnPoint(loc, kind, ac) {
    const W = this.world, spec = ac.spec;
    const st = this.groundStance(ac);
    const jet = spec.engine.type === 'jet';
    if (loc === 'AIR') return { pos: new V3(0, jet ? 4200 : 2200, 3000), hdg: 0, pitch: 0, speed: spec.vref * 1.25, ground: false };
    if (loc === 'CVN') {
      const C = W.carrier, hdg = C.hdg * RAD;
      if (kind === 'runway') {
        const cat = C.cats[0]; const p = C.toWorld(cat.u0 + 4, cat.v, new V3());
        p.y = C.deckY + st.h;
        return { pos: p, hdg, pitch: st.pitch, speed: C.speed, ground: true, catapult: { u: cat.u0 + 4, v: cat.v, end: cat.u1 } };
      }
      const la = C.hdg + C.angle; const dir = new V3(Math.sin(la), 0, -Math.cos(la));
      const td = C.toWorld(C.ldgStart[0] + 70 * Math.cos(C.angle), C.ldgStart[1] + 70 * Math.sin(C.angle), new V3());
      const D = kind === 'air' ? 6000 : 4200;
      const p = td.clone().addScaled(dir, -D).addScaled(C.vel, D / (spec.approach * 1.1));
      p.y = C.deckY + D * Math.tan(3.5 * DEG) + 8;
      return { pos: p, hdg: la * RAD, pitch: 2, speed: spec.approach * 1.12, ground: false, approach: true };
    }
    const ap = AIRPORTS.find(a => a.id === loc);
    const rw = this.mainRunway(ap);
    let hdg = rw.hdg, dir = new V3(rw.s, 0, -rw.c);
    // land into the wind
    if (this.wind && this.wind.lenSq() > 1 && this.wind.dot(dir) > 0) { hdg = (hdg + 180) % 360; dir.negate(); }
    const thr = new V3(rw.x, 0, rw.z).addScaled(dir, -rw.hl);
    if (kind === 'runway') {
      const p = thr.clone().addScaled(dir, Math.min(60, rw.hl * 0.1)); p.y = ap.elev + st.h;
      return { pos: p, hdg, pitch: st.pitch, speed: 0, ground: true };
    }
    if (kind === 'approach' || kind === 'long') {
      const D = kind === 'long' ? 11000 : 5200;
      const p = thr.clone().addScaled(dir, -D); p.y = ap.elev + D * Math.tan(3 * DEG) + 15;
      return { pos: p, hdg, pitch: 2, speed: spec.approach * 1.12, ground: false, approach: true, rw };
    }
    const p = thr.clone().addScaled(dir, -2500); p.y = ap.elev + 900;
    return { pos: p, hdg, pitch: 0, speed: spec.vref * 1.1, ground: false };
  },
  placeAircraft(ac, sp) {
    ac.spawn(sp.pos, sp.hdg, sp.pitch, sp.speed, sp.ground);
    const fm = ac.fm;
    if (sp.ground) { fm.ctl.throttle = 0; fm.ctl.brake = 1; if (sp.catapult) { fm.catapult = { state: 'hold', u: sp.catapult.u, v: sp.catapult.v, end: sp.catapult.end, accel: 0, t: 0 }; fm.vel.copy(this.world.carrier.vel); } }
    else {
      fm.ctl.throttle = sp.approach ? 0.55 : 0.85;
      if (sp.approach) { fm.ctl.gear = fm.ctl.gearTarget = 1; fm.ctl.flaps = fm.ctl.flapsTarget = ac.spec.engine.type === 'jet' ? 0.6 : 0.5; if (sp.pos.y < 400 && this.cfg && this.cfg.location === 'CVN') fm.ctl.hook = fm.ctl.hookTarget = 1; }
      fm.eng.n = 0.8;
      if (this.cfg && this.cfg.location === 'CVN' && sp.approach) fm.ctl.hook = fm.ctl.hookTarget = 1;
    }
  },

  showcase(cfg) {
    const spec = AIRCRAFT_BY_ID[cfg.aircraft];
    this.cfg = null;
    this.applyEnv(cfg);
    if (!this.showAc || this.showAc.base !== spec) this.showAc = new Aircraft(spec, 'blue', false, spec.name);
    const loc = cfg.location === 'AIR' ? 'HPI' : cfg.location;
    const sp = this.spawnPoint(loc, 'runway', this.showAc);
    this.placeAircraft(this.showAc, sp);
    this.showAc.fm.ctl.throttle = 0.04;
    this.aircraft = [this.showAc]; this.player = null;
    this.weapons.reset(); this.fx.reset();
    this.camera.orbitYaw = 2.4; this.menuT = 0;
    document.getElementById('scRole').textContent = spec.role.toUpperCase() + '  ·  ' + spec.era.toUpperCase();
    document.getElementById('scName').textContent = spec.name;
    document.getElementById('scDesc').textContent = spec.desc;
  },

  startMission(cfg) {
    this.cfg = cfg; this.mode = cfg.mode;
    this.applyEnv(cfg);
    this.weapons.reset(); this.fx.reset(); this.fires = []; this.streams = null; this.fightOn = cfg.mode !== 'dogfight';
    this.fx.groundY = (x, z) => Math.max(this.world.terrain.heightAt(x, z), 0);
    const spec = AIRCRAFT_BY_ID[cfg.aircraft];
    const p = new Aircraft(spec, 'blue', true, 'SLIP 1');
    p.assist = UI.settings.assist;
    this.player = p; this.aircraft = [p];
    const kind = cfg.mode === 'dogfight' ? (cfg.location === 'AIR' ? 'air' : 'runway') : cfg.spawn;
    const sp = this.spawnPoint(cfg.location, kind, p);
    this.placeAircraft(p, sp);
    this.stats = { t: 0, shots: 0, hits: 0, msl: 0, mhits: 0, kills: 0, maxG: 1, wave: 1 };
    this.mission = { done: false, endT: 0, landed: null, deadT: 0 };
    if (cfg.mode === 'dogfight') this.spawnWave(cfg, 1);
    this.camera.mode = 'chase'; this.camera.sq.copy(p.q); this.camera.lookYaw = this.camera.lookPitch = 0; this.camera.zoom = 1; this.camera.flyby = null;
    this.aimDir = p.fm.fwd(new V3());
    this.hud.msgs = []; this.hud.feed = []; this.hud.maxG = 1;
    this.gl = 0; this.rd = 0; this.aeroView = false; this.fade = 0;
    UI.show(null, false); UI.stack = ['menu'];
    this.state = 'flight';
    this.audio.init(); this.audio.resume();
    const tips = { dogfight: 'SPACE GUNS · F MISSILE · 1/2/3 WEAPON · X FLARES · T TARGET · C CAMERA · F1 HELP', free: 'SHIFT/CTRL THROTTLE · G GEAR · [ ] FLAPS · B BRAKES · O AERO VIEW · F1 HELP', landing: 'FLY THE GLIDESLOPE — 4 PAPI LIGHTS: 2 WHITE / 2 RED · G GEAR · [ ] FLAPS' };
    UI.toast(cfg.location === 'CVN' && kind === 'runway' ? 'FULL THROTTLE, THEN ENTER TO LAUNCH FROM THE CATAPULT · F1 HELP' : tips[cfg.mode], 7);
    if (cfg.mode === 'dogfight') this.hud.message(cfg.location === 'AIR' ? 'BANDITS INBOUND' : 'SCRAMBLE — BANDITS INBOUND', 'big', 3.5);
  },

  spawnWave(cfg, wave) {
    const p = this.player, W = this.world;
    const nE = cfg.waves ? Math.min(8, cfg.enemies + wave - 1) : cfg.enemies;
    const skill = cfg.waves ? Math.min(2, cfg.skill + Math.floor((wave - 1) / 2)) : cfg.skill;
    const pspec = p.spec;
    const isProp = pspec.engine.type === 'prop';
    const pool = COMBAT_AIRCRAFT.filter(a => (a.engine.type === 'prop') === isProp);
    const pickE = () => cfg.enemyType === 'same' ? pspec : cfg.enemyType === 'mixed' ? pool[(Math.random() * pool.length) | 0] : AIRCRAFT_BY_ID[cfg.enemyType];
    // reference frame: player position/heading (or the airfield)
    const ref = p.fm.out.wow ? p.pos.clone() : p.pos.clone();
    let hdg = p.fm.euler().hdg;
    const jet = !isProp;
    const alt = Math.max(ref.y, 0) + (p.fm.out.wow ? (jet ? 3500 : 1800) : 0);
    const fw = new V3(Math.sin(hdg * DEG), 0, -Math.cos(hdg * DEG)), rt = new V3(-fw.z, 0, fw.x);
    let base, eh, espd;
    const start = wave > 1 ? 'merge' : (p.fm.out.wow ? 'scramble' : cfg.start);
    const vr = (s) => s.vref * 1.25;
    switch (start) {
      case 'scramble': base = ref.clone().addScaled(fw, 16000); base.y = alt; eh = hdg + 180; break;
      case 'neutral': base = ref.clone().addScaled(rt, 2500); base.y = alt; eh = hdg; break;
      case 'offensive': base = ref.clone().addScaled(fw, 1300); base.y = alt - 80; eh = hdg; break;
      case 'defensive': base = ref.clone().addScaled(fw, -1100); base.y = alt + 60; eh = hdg; break;
      case 'bvr': base = ref.clone().addScaled(fw, 42000); base.y = alt + 1500; eh = hdg + 180; break;
      default: base = ref.clone().addScaled(fw, wave > 1 ? 11000 : 9000); base.y = alt + 200; eh = hdg + 180;
    }
    const ef = new V3(Math.sin(eh * DEG), 0, -Math.cos(eh * DEG)), er = new V3(-ef.z, 0, ef.x);
    for (let i = 0; i < nE; i++) {
      const s = pickE();
      const ac = new Aircraft(s, 'red', false, 'BANDIT ' + (i + 1 + (wave - 1) * 10));
      const pos = base.clone().addScaled(er, (i - (nE - 1) / 2) * 320).addScaled(ef, -Math.abs(i - (nE - 1) / 2) * 120); pos.y += (i % 2) * 120;
      const tH = Math.max(this.world.terrain.heightAt(pos.x, pos.z), 0); pos.y = Math.max(pos.y, tH + 900);
      ac.spawn(pos, (eh + 360) % 360, 0, vr(s), false);
      ac.fm.ctl.gear = ac.fm.ctl.gearTarget = 0; ac.fm.eng.n = 0.9; ac.fm.ctl.throttle = 0.9;
      if (cfg.arm === 'guns') { ac.wpn.ir = 0; ac.wpn.radar = 0; ac.wpn.sel = 'gun'; }
      ac.ai = new AIPilot(ac, skill, this);
      this.aircraft.push(ac);
    }
    if (wave === 1) {
      for (let i = 0; i < cfg.allies; i++) {
        const s = pspec;
        const ac = new Aircraft(s, 'blue', false, 'SLIP ' + (i + 2));
        let pos, h = hdg, spd = vr(s);
        if (p.fm.out.wow) { pos = ref.clone().addScaled(fw, -3000 - i * 400).addScaled(rt, (i % 2 ? -1 : 1) * 400); pos.y = Math.max(ref.y, 0) + 1500 + i * 100; }
        else { pos = ref.clone().addScaled(rt, (i % 2 ? -1 : 1) * (180 + Math.floor(i / 2) * 160)).addScaled(fw, -120 - i * 80); pos.y = ref.y + 20; spd = p.fm.out.tas || spd; }
        ac.spawn(pos, h, 0, spd, false);
        ac.fm.ctl.gear = ac.fm.ctl.gearTarget = 0; ac.fm.eng.n = 0.9;
        if (cfg.arm === 'guns') { ac.wpn.ir = 0; ac.wpn.radar = 0; ac.wpn.sel = 'gun'; }
        ac.ai = new AIPilot(ac, Math.max(1, cfg.skill), this);
        this.aircraft.push(ac);
      }
      if (cfg.arm === 'guns') { p.wpn.ir = 0; p.wpn.radar = 0; p.wpn.sel = 'gun'; }
    }
  },

  restart() { if (this.cfg) this.startMission(this.cfg); },
  toMenu() { this.state = 'menu'; this.input.releasePointer(); this.showcase(UI.cfg); UI.stack = []; UI.show('menu'); this.audio.update(0, this.showAc, {}); },
  pause() { if (this.state !== 'flight') return; this.state = 'paused'; this.input.releasePointer(); UI.stack = []; UI.show('pause'); this.audio.suspend(); },
  resume() { this.state = 'flight'; UI.show(null, false); UI.stack = []; this.audio.resume(); this.last = performance.now(); },
  quit() { native({ cmd: 'quit' }); try { window.close(); } catch (e) { } },

  // ---------- main loop ----------
  loop(now) {
    requestAnimationFrame(t => this.loop(t));
    const dt = clamp((now - this.last) / 1000, 0.0005, 0.1); this.last = now;
    this.ft = lerp(this.ft, dt * 1000, 0.05);
    try {
      this.globalKeys();
      if (this.state === 'flight') this.updateFlight(dt);
      else if (this.state === 'menu') this.updateMenu(dt);
      else if (this.state === 'debrief') this.updateFlight(dt, true);
      this.renderFrame(this.state === 'paused' ? 0 : dt);
      this.dynamicRes(dt);
    } catch (e) { showError(e); this.state = 'error'; }
    this.input.endFrame();
  },
  dynamicRes(dt) {
    const R = this.renderer;
    this.drT = (this.drT || 0) + dt;
    if (this.drT > 0.5) {
      this.drT = 0;
      if (R.dynRes) {
        if (this.ft > 19.5 && R.renderScale > 0.56) R.renderScale = Math.max(0.55, R.renderScale - 0.06);
        else if (this.ft < 13 && R.renderScale < 1) R.renderScale = Math.min(1, R.renderScale + 0.04);
      }
      document.getElementById('fps').textContent = Math.round(1000 / this.ft) + ' FPS · ' + R.targetsW + '×' + R.targetsH;
    }
  },
  globalKeys() {
    const I = this.input;
    if (I.hit('Escape')) {
      if (this.state === 'flight') this.pause();
      else if (this.state === 'paused') { if (UI.current === 'pause') this.resume(); else UI.back(); }
      else if (this.state === 'menu' && UI.current !== 'menu') UI.back();
    }
    if (I.hit('KeyP') && this.state === 'flight') this.pause();
    if (I.hit('F1')) { if (this.state === 'flight') this.pause(); UI.show('controls'); }
    if (this.state === 'menu' && UI.current === 'setup' && I.hit('Enter')) UI.launch();
    if ((this.state === 'paused' || this.state === 'debrief') && I.hit('KeyR')) this.restart();
  },

  updateMenu(dt) {
    const ac = this.showAc; this.menuT += dt;
    // keep the showcase aircraft resting on its gear (physics) with brakes
    let acc = Math.min(dt, 0.05);
    while (acc > 1e-4) {
      const h = Math.min(PHYS_DT, acc); acc -= h;
      ac.input.pitch = 0; ac.input.roll = 0; ac.input.yaw = 0; ac.fm.ctl.brake = 1; ac.fm.ctl.throttle = 0.04;
      if (ac.fm.crashed) { this.showcase(UI.cfg); return; }
      ac.step(h, this.world, true);
      this.world.carrier.update(h);
    }
    // gentle surface movement for life
    const t = this.menuT;
    for (const s of ac.fm.segs) for (const c of s.ctls) if (c.kind === 'elevator' || c.kind === 'aileron' || c.kind === 'rudder') c.defl = Math.sin(t * 0.7 + s.pos.x) * c.max * 0.25 * Math.max(0, Math.sin(t * 0.21));
    ac.updateParts(false);
    const C = this.camera;
    C.orbitYaw += dt * 0.045;
    const R = ac.geo.radius;
    const d = R * 2.3 + 7, hgt = 1.2 + R * 0.18 + Math.sin(t * 0.13) * R * 0.08;
    const fwd = ac.fm.fwd(new V3()); const hdg = Math.atan2(fwd.x, -fwd.z);
    const a = hdg + C.orbitYaw;
    C.pos.set(ac.pos.x + Math.sin(a) * d, ac.pos.y + hgt, ac.pos.z - Math.cos(a) * d);
    const gh = this.groundUnder(C.pos); if (C.pos.y < gh + 1.2) C.pos.y = gh + 1.2;
    const tgt = ac.pos.clone().addScaled(fwd, -R * 0.1); tgt.y += R * 0.05;
    C.q.setFromBasis(tgt.sub(C.pos).normalize(), _t2.set(0, 1, 0));
    C.fov = 46 * DEG; C.near = 0.3;
    this.fx.beginFrame();
    this.emitAircraftFX(ac, dt);
    this.fx.update(dt, C.pos);
  },
  groundUnder(p) { const s = this.world.surfaceAt(p.x, p.z, { h: 0 }); return s.h; },

  // ---------- flight update ----------
  updateFlight(dt, frozenInput) {
    const p = this.player, fm = p.fm, I = this.input, W = this.world, cam = this.camera;
    this.stats.t += dt;
    if (!frozenInput && p.alive && !fm.crashed) this.playerControls(dt);
    // physics substeps
    this.acc = (this.acc || 0) + dt;
    let steps = 0;
    while (this.acc >= PHYS_DT && steps < 10) {
      this.acc -= PHYS_DT; steps++;
      this.aiTick = (this.aiTick || 0) + 1;
      // bandits hold (orbit, weapons safe) until the player is airborne for a few seconds
      if (!this.fightOn && (p.airT > 4 || !p.alive)) {
        this.fightOn = true;
        if (this.mode === 'dogfight' && p.alive) { this.hud.message('BANDITS COMMITTING', 'warn', 3); this.audio.say && this.audio.say('Bandits committing'); }
      }
      for (const ac of this.aircraft) {
        if (ac.ai && ac.alive && (this.aiTick & 1)) ac.ai.update(PHYS_DT * 2, this.aircraft, W);
        if (ac.alive && !ac.fm.crashed) {
          const trig = ac.isPlayer ? this.trigger : (ac.ai && ac.ai.trigger);
          if (trig) { const before = ac.wpn.ammo; this.weapons.fireGuns(ac, PHYS_DT); if (ac.isPlayer) this.stats.shots += before - ac.wpn.ammo; }
          else ac.wpn.firing = false;
        }
        ac.step(PHYS_DT, W, ac.isPlayer ? ac.assist : true);
      }
      this.weapons.update(PHYS_DT, this.aircraft, W, this.fx);
      W.carrier.update(PHYS_DT);
    }
    if (this.acc > PHYS_DT * 4) this.acc = 0;
    // per-frame systems
    for (const ac of this.aircraft) {
      this.weapons.updateLock(ac, this.aircraft, dt);
      const agl = ac.fm.out.agl;
      ac.fm.wind.copy(this.windAt(ac.pos, agl));
      if (ac.spec.id === 'condor' || ac.spec.engine.type === 'prop') ac.fm.wind.y += this.renderer.clouds.lift(ac.pos.x, ac.pos.y, ac.pos.z, this.renderer.time);
      ac.fm.gustScale = this.turb * (0.8 + (agl < 400 ? 0.6 : 0)) * 1.1;
    }
    this.handleEvents();
    this.checkCrashes(dt);
    this.missionLogic(dt);
    this.computeWarnings(dt);
    this.updateCamera(dt);
    // effects
    this.fx.beginFrame();
    this.weapons.emitRender(this.fx, cam);
    for (const ac of this.aircraft) { ac.updateParts(ac.isPlayer && cam.mode === 'cockpit'); this.emitAircraftFX(ac, dt); }
    if (this.aeroView && p.alive) this.emitAeroViz(dt);
    for (const f of this.fires) {
      f.t -= dt;
      const k = Math.min(1, f.t / 8), fx = this.fx;
      if (Math.random() < dt * 30) fx.emit(PT.DARK, f.x + (Math.random() - 0.5) * 6, f.y, f.z + (Math.random() - 0.5) * 6, 0, 6, 0, 10, 6, 40, 0.07, 0.07, 0.07, 0.75 * k, 0.15);
      for (let i = 0; i < dt * 32 * k + Math.random() - 0.5; i++) fx.puff(f.x + (Math.random() - 0.5) * 7, f.y + 0.5, f.z + (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 2, 3 + Math.random() * 3, (Math.random() - 0.5) * 2, 1.4 + Math.random(), 2.5, 6 + Math.random() * 3, 0.06, 0.85 * k, 0.8, 0.35, 1.0);
      if (Math.random() < dt * 6 * k) fx.emit(PT.EMBER, f.x + (Math.random() - 0.5) * 5, f.y + 2, f.z + (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3, 5 + Math.random() * 5, (Math.random() - 0.5) * 3, 3 + Math.random() * 2, 0.09, 0.04, 1, 0.45, 0.12, 1, 0.9);
      const fl = 0.75 + 0.15 * Math.sin(this.stats.t * 13 + f.x) + 0.1 * Math.sin(this.stats.t * 29 + f.z);
      fx.light(f.x, f.y + 7, f.z, 1.0, 0.45, 0.14, 5000 * k * fl, 8);
    }
    this.fires = this.fires.filter(f => f.t > 0);
    this.fx.update(dt, cam.pos);
    // audio
    this.audio.update(dt, p, { cockpit: cam.mode === 'cockpit', missileWarn: this.warn.missile, pullUp: this.warn.pullUp, stall: this.warn.stall, gearWarn: this.warn.gear });
    // G physiology
    const G = fm.out.G;
    this.stats.maxG = Math.max(this.stats.maxG, G);
    if (UI.settings.gfx && p.alive) {
      const onset = 5.2 + (p.spec.fcs.gLimit > 8 ? 0.6 : 0);
      if (G > onset) this.gl = Math.min(1, this.gl + (G - onset) * 0.07 * dt); else this.gl = Math.max(0, this.gl - (G < 3 ? 0.35 : 0.12) * dt);
      if (G < -2.2) this.rd = Math.min(1, this.rd + (-2.2 - G) * 0.15 * dt); else this.rd = Math.max(0, this.rd - 0.4 * dt);
    } else { this.gl = 0; this.rd = 0; }
  },

  playerControls(dt) {
    const p = this.player, fm = p.fm, I = this.input, cam = this.camera;
    const st = I.updateStick(dt);
    const mouse = I.mouseAim && cam.mode !== 'orbit';
    const pad = I.padState;
    // ---- mouse aim ----
    if (mouse) {
      const s = 0.0022 * I.sens;
      const aim = this.aimDir;
      const yaw = -I.mouse.dx * s, pit = -I.mouse.dy * s;
      if (yaw) aim.applyQuat(_qa2.setAxisAngle(0, 1, 0, yaw));
      if (pit) { const r = new V3().crossVecs(aim, _t2.set(0, 1, 0)).normalize(); const nq = _qa2.setAxisAngle(r.x, r.y, r.z, pit); const na = aim.clone().applyQuat(nq); if (Math.abs(na.y) < 0.985) aim.copy(na); }
      aim.normalize();
      const out = { pitch: 0, roll: 0, yaw: 0 };
      steerToward(p, aim, out, 1);
      const kb = Math.abs(st.pitch) > 0.05 || Math.abs(st.roll) > 0.05;
      p.input.pitch = kb ? st.pitch : out.pitch; p.input.roll = Math.abs(st.roll) > 0.05 ? st.roll : out.roll; p.input.yaw = st.yaw + (kb ? 0 : out.yaw * 0.5);
      if (fm.out.wow) { p.input.pitch = st.pitch; p.input.roll = st.roll; p.input.yaw = st.yaw; aim.copy(fm.fwd(_t1)); }
    } else {
      p.input.pitch = st.pitch; p.input.roll = st.roll; p.input.yaw = st.yaw;
      this.aimDir.copy(fm.fwd(_t1));
    }
    // ---- throttle ----
    let thr = fm.ctl.throttle;
    if (I.down('ShiftLeft', 'ShiftRight', 'Equal', 'NumpadAdd')) thr += 0.55 * dt;
    if (I.down('ControlLeft', 'ControlRight', 'Minus', 'NumpadSubtract')) thr -= 0.55 * dt;
    if (pad && Math.abs(pad.ry) > 0.1) thr += -pad.ry * 0.8 * dt;
    fm.ctl.throttle = clamp(thr, 0, 1);
    // ---- systems ----
    if (I.hit('KeyG') || (pad && pad.b[2] > 0.5 && !this._padG)) { fm.ctl.gearTarget = fm.ctl.gearTarget > 0.5 ? 0 : 1; if (!fm.gearRetract) this.hud.message('FIXED GEAR'); else this.hud.message(fm.ctl.gearTarget ? 'GEAR DOWN' : 'GEAR UP'); if (fm.out.wow && !fm.ctl.gearTarget) { fm.ctl.gearTarget = 1; this.hud.message('WEIGHT ON WHEELS — GEAR LOCKED', 'warn'); } }
    this._padG = pad && pad.b[2] > 0.5;
    if (I.hit('BracketRight')) { fm.ctl.flapsTarget = Math.min(1, Math.round(fm.ctl.flapsTarget * 4 + 1) / 4); this.hud.message('FLAPS ' + Math.round(fm.ctl.flapsTarget * 100) + '%'); }
    if (I.hit('BracketLeft')) { fm.ctl.flapsTarget = Math.max(0, Math.round(fm.ctl.flapsTarget * 4 - 1) / 4); this.hud.message('FLAPS ' + Math.round(fm.ctl.flapsTarget * 100) + '%'); }
    const parking = fm.out.wow && fm.ctl.throttle < 0.03 && fm.out.tas < 2;
    fm.ctl.brake = (I.down('KeyB') || parking) ? 1 : 0;
    if (I.hit('KeyN')) { fm.ctl.airbrake = fm.ctl.airbrake > 0.5 ? 0 : 1; this.hud.message(fm.ctl.airbrake ? 'SPEED BRAKE OUT' : 'SPEED BRAKE IN'); }
    if (I.hit('KeyH')) { fm.ctl.hookTarget = fm.ctl.hookTarget > 0.5 ? 0 : 1; this.hud.message(fm.ctl.hookTarget ? 'HOOK DOWN' : 'HOOK UP'); }
    if (I.hit('Comma')) p.fcs.trim = clamp(p.fcs.trim + 0.02, -0.5, 0.5);
    if (I.hit('Period')) p.fcs.trim = clamp(p.fcs.trim - 0.02, -0.5, 0.5);
    if (I.hit('Enter', 'NumpadEnter') && fm.catapult && fm.catapult.state === 'hold') {
      fm.catapult.state = 'launch'; fm.catapult.accel = clamp(78 * 78 / (2 * (fm.catapult.end - fm.catapult.u)), 18, 40);
      this.hud.message('CATAPULT LAUNCH', 'good'); this.audio.oneShot('launch', 1.2);
    }
    // ---- weapons ----
    this.trigger = I.down('Space') || (mouse && (I.mouse.buttons & 1)) || (pad && pad.b[7] > 0.5);
    if (I.hit('Digit1')) { p.wpn.sel = 'gun'; this.hud.message('GUN'); }
    if (I.hit('Digit2') && p.wpn.ir + (p.spec.weapons || {}).ir > 0) { p.wpn.sel = 'ir'; this.hud.message('IR MISSILE'); }
    if (I.hit('Digit3') && (p.spec.weapons || {}).radar > 0) { p.wpn.sel = 'radar'; this.hud.message('RADAR MISSILE'); }
    if (I.hit('KeyF', 'Mouse2') || (pad && pad.b[6] > 0.5 && !this._padM)) {
      if (p.wpn.sel === 'gun') { if (p.wpn.ir > 0) p.wpn.sel = 'ir'; else if (p.wpn.radar > 0) p.wpn.sel = 'radar'; }
      const tgt = p.wpn.lockState === 2 ? p.wpn.lock : null;
      if ((p.wpn.sel === 'ir' || p.wpn.sel === 'radar') && p.wpn[p.wpn.sel] > 0) {
        if (!tgt && p.wpn.sel === 'radar') this.hud.message('NO RADAR LOCK', 'warn');
        else if (this.weapons.launchMissile(p, tgt)) { this.stats.msl++; this.hud.message(p.wpn.sel === 'ir' ? 'FOX 2' : 'FOX 3', 'good', 1.5); this.audio.say(p.wpn.sel === 'ir' ? 'Fox two' : 'Fox three'); }
      } else this.hud.message('NO MISSILES', 'warn');
    }
    this._padM = pad && pad.b[6] > 0.5;
    if (I.hit('KeyT') || (pad && pad.b[3] > 0.5 && !this._padT)) this.cycleTarget();
    this._padT = pad && pad.b[3] > 0.5;
    if (I.down('KeyX') || (pad && pad.b[0] > 0.5)) { if (this.weapons.deployCM(p)) this.audio.oneShot('flare'); }
    // ---- views ----
    const modes = ['chase', 'cockpit', 'orbit', 'flyby', 'target'];
    if (I.hit('KeyC') || (pad && pad.b[1] > 0.5 && !this._padC)) { const i = modes.indexOf(this.camera.mode); this.setCam(modes[(i + 1) % modes.length]); }
    this._padC = pad && pad.b[1] > 0.5;
    if (I.hit('KeyV')) this.setCam(this.camera.mode === 'cockpit' ? 'chase' : 'cockpit');
    if (I.hit('KeyY')) this.setCam(this.camera.mode === 'target' ? 'chase' : 'target');
    if (I.hit('KeyO')) { this.aeroView = !this.aeroView; this.hud.message(this.aeroView ? 'AERO VISUALIZER ON — panel loads, force vectors, induced airflow' : 'AERO VISUALIZER OFF'); }
    if (I.hit('KeyU')) this.hud.mode = (this.hud.mode + 1) % 3;
    if (I.hit('KeyM')) { UI.settings.ctl = UI.settings.ctl === 'mouse' ? 'kbd' : 'mouse'; STORE.set('settings', UI.settings); UI.applySettings(); UI.buildSettings(); this.hud.message(UI.settings.ctl === 'mouse' ? 'MOUSE AIM — click to capture pointer' : 'KEYBOARD CONTROL'); if (UI.settings.ctl !== 'mouse') I.releasePointer(); }
    I.captureOK = true;
    if (I.hit('Backspace')) this.restart();
    if (I.mouse.wheel) this.camera.zoom = clamp(this.camera.zoom * Math.exp(I.mouse.wheel * 0.0015), 0.45, 4);
  },
  setCam(m) { this.camera.mode = m; this.camera.flyby = null; this.camera.lookYaw = this.camera.lookPitch = 0; this.hud.message('CAMERA · ' + m.toUpperCase(), 'info', 1.2); },
  cycleTarget() {
    const p = this.player; const enemies = this.aircraft.filter(a => a.team !== p.team && a.alive);
    if (!enemies.length) return;
    const fwd = p.fm.fwd(new V3());
    enemies.sort((a, b) => { const da = a.pos.clone().sub(p.pos), db = b.pos.clone().sub(p.pos); return (1 - da.normalize().dot(fwd)) - (1 - db.normalize().dot(fwd)); });
    const i = enemies.indexOf(p.preferTarget);
    p.preferTarget = enemies[(i + 1) % enemies.length];
    p.wpn.lock = null;
    this.hud.message('TARGET · ' + p.preferTarget.callsign);
  },

  handleEvents() {
    const p = this.player, H = this.hud, cam = this.camera.pos;
    for (const e of this.weapons.events) {
      if (e.type === 'launch') {
        const d = e.ac.pos.distTo(cam);
        if (d < 3000) this.audio.oneShot('launch', clamp(1 - d / 3000, 0.1, 1));
        if (e.m.target === p && e.ac !== p) { H.message('MISSILE LAUNCH', 'warn', 2); this.audio.say('Missile'); }
      } else if (e.type === 'hit' || e.type === 'mhit') {
        if (e.shooter === p) { if (e.type === 'hit') this.stats.hits++; else this.stats.mhits++; this.audio.oneShot('hit', 0.5); }
        if (e.target === p) { this.audio.oneShot('thud', 1); this.camera.shake = Math.min(1, this.camera.shake + (e.type === 'mhit' ? 1 : 0.25)); this.damageFlash = 1; }
        if (e.killed) {
          this.announceKill(e.shooter, e.target);
          const t = e.target; if (t && t.visible) this.fx.explosion(t.pos.x, t.pos.y, t.pos.z, 1.4, t.vel.x * 0.85, t.vel.y * 0.85, t.vel.z * 0.85, { debris: 6 });
        }
      } else if (e.type === 'boom') {
        const d = Math.hypot(e.x - cam.x, e.y - cam.y, e.z - cam.z);
        this.audio.oneShot('boom', clamp(1.2 - d / 6000, 0.05, 1), d / 340);
      } else if (e.type === 'cm') { }
    }
    this.weapons.events.length = 0;
  },
  announceKill(shooter, target) {
    const H = this.hud;
    H.kill((shooter ? shooter.callsign : '—') + '  ▸  ' + target.callsign + '  ' + target.spec.name);
    if (shooter === this.player) { this.stats.kills++; H.message('SPLASH ONE — ' + target.spec.name, 'good', 3); this.audio.say('Splash one'); }
    if (target === this.player) { H.message('YOU HAVE BEEN SHOT DOWN', 'warn', 4); }
  },

  checkCrashes(dt) {
    const W = this.world;
    for (const ac of this.aircraft) {
      const fm = ac.fm;
      if (!ac.alive && !fm.crashed) { ac.deadT += dt; if (ac.deadT > 12 && !ac.isPlayer) fm.crash('Wreck'); }
      if (fm.crashed && !ac.exploded) {
        ac.exploded = true;
        const wasAlive = ac.alive;
        if (ac.alive) { ac.alive = false; if (ac.lastHitBy && performance.now() - ac.lastHitT < 15000 && ac.lastHitBy !== ac) { ac.lastHitBy.kills++; this.announceKill(ac.lastHitBy, ac); } else if (ac !== this.player) this.hud.kill(ac.callsign + ' crashed'); }
        const s = W.surfaceAt(ac.pos.x, ac.pos.z, {});
        const water = s.water;
        const big = ac.spec.mass > 15000;
        this.fx.groundImpact(ac.pos.x, Math.max(ac.pos.y, s.h), ac.pos.z, water, true);
        if (!water) this.fires.push({ x: ac.pos.x, y: s.h, z: ac.pos.z, t: 50 });
        const d = ac.pos.distTo(this.camera.pos);
        this.audio.oneShot('boom', clamp(1.3 - d / 8000, 0.1, 1.2), d / 340);
        if (ac !== this.player) ac.visible = false;
        else {
          this.camera.shake = 1;
          this.crashReason = fm.crashReason;
          if (!this.mission.done) { this.mission.done = true; this.mission.endT = 2.8; this.mission.result = wasAlive ? 'crash' : 'shotdown'; }
        }
      }
    }
    // mid-air collisions
    const A = this.aircraft;
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
      const a = A[i], b = A[j];
      if (!a.visible || !b.visible || a.fm.crashed || b.fm.crashed) continue;
      const r = (a.geo.radius + b.geo.radius) * 0.55;
      if (a.pos.distSq(b.pos) < r * r) { a.fm.crash('Mid-air collision'); b.fm.crash('Mid-air collision'); }
    }
  },

  missionLogic(dt) {
    const p = this.player, fm = p.fm, M = this.mission, cfg = this.cfg;
    // player shot down but still falling
    if (!p.alive && !fm.crashed) { M.deadT += dt; if (M.deadT > 6 && !M.done) { M.done = true; M.endT = 0.5; M.result = 'shotdown'; } }
    // touchdown feedback / landing evaluation
    if (fm.touchdown && !M.tdShown) {
      M.tdShown = true;
      const td = fm.touchdown;
      M.landed = this.evalLanding(td);
      this.hud.message(`TOUCHDOWN · ${(td.sink).toFixed(1)} m/s` + (M.landed && M.landed.rw ? ` · ${Math.round(M.landed.dist)} m from aim point` : ''), 'good', 3.5);
    }
    if (fm.out.agl > 30 && M.tdShown && !fm.out.wow) { M.tdShown = false; fm.touchdown = null; }
    if (this.mode === 'landing' && !M.done && M.landed && fm.out.wow && fm.out.tas < 4 + (M.landed.carrier ? 14 : 0)) {
      M.done = true; M.endT = 1.2; M.result = 'landed';
    }
    if (this.mode === 'landing' && !M.done && fm.arrested) { M.done = true; M.endT = 1.5; M.result = 'landed'; }
    // dogfight objectives
    if (this.mode === 'dogfight' && !M.done) {
      const enemies = this.aircraft.filter(a => a.team !== p.team && a.alive);
      if (!enemies.length && p.alive) {
        if (cfg.waves) {
          M.waveT = (M.waveT || 0) + dt;
          if (M.waveT > 4.5) { M.waveT = 0; this.stats.wave++; this.aircraft = this.aircraft.filter(a => a.visible || a === p); this.spawnWave(cfg, this.stats.wave); this.hud.message('WAVE ' + this.stats.wave + ' INBOUND', 'big', 3); }
          else if (M.waveT < dt * 1.5) this.hud.message('WAVE CLEARED', 'good', 3);
        } else { M.done = true; M.endT = 3.5; M.result = 'victory'; this.hud.message('ALL BANDITS DESTROYED', 'big', 3.5); }
      }
    }
    if (M.done) {
      M.endT -= dt;
      if (M.endT <= 0 && this.state === 'flight') this.showDebrief();
    }
  },
  evalLanding(td) {
    const W = this.world, fm = this.player.fm;
    if (td.carrier) {
      return { carrier: true, sink: td.sink };
    }
    for (const rw of W.runways) {
      const rx = td.x - rw.x, rz = td.z - rw.z;
      const u = rx * rw.s - rz * rw.c, v = rx * rw.c + rz * rw.s;
      if (Math.abs(u) <= rw.hl + 20 && Math.abs(v) <= rw.hw + 5) {
        const f = fm.fwd(new V3()); const along = f.x * rw.s - f.z * rw.c;
        const s = along >= 0 ? u + rw.hl : rw.hl - u;
        const aim = Math.min(300, rw.hl * 2 * 0.2);
        return { rw, s, dist: s - aim, lat: v * (along >= 0 ? 1 : -1), sink: td.sink, onRwy: Math.abs(v) <= rw.hw };
      }
    }
    return { sink: td.sink };
  },
  showDebrief() {
    const M = this.mission, S = this.stats, p = this.player;
    this.state = 'debrief'; this.input.releasePointer();
    const time = `${Math.floor(S.t / 60)}:${pad(S.t % 60, 2)}`;
    if (M.result === 'landed' && M.landed) {
      const L = M.landed;
      let score = 100;
      const sink = L.sink;
      score -= clamp((sink - 1.0) * 18, 0, 50);
      if (L.rw) { score -= clamp(Math.abs(L.dist) / 12, 0, 30); score -= clamp(Math.abs(L.lat) / 0.6, 0, 25); }
      if (L.carrier) { const wire = (p.fm.wireIdx || 0) + 1; score = 100 - clamp((sink - 2.5) * 10, 0, 40) - Math.abs(wire - 3) * 12 - (p.fm.arrested ? 0 : 50); }
      score = clamp(Math.round(score), 0, 100);
      const grade = score >= 92 ? 'A+' : score >= 85 ? 'A' : score >= 75 ? 'B' : score >= 62 ? 'C' : score >= 50 ? 'D' : 'F';
      const rows = [['SINK RATE', sink.toFixed(2) + ' m/s'], ['MAX G', S.maxG.toFixed(1)]];
      if (L.rw) rows.push(['FROM AIM POINT', (L.dist >= 0 ? '+' : '') + Math.round(L.dist) + ' m'], ['CENTERLINE', Math.abs(L.lat).toFixed(1) + ' m ' + (L.lat > 0 ? 'R' : 'L')], ['RUNWAY', L.rw.def.name]);
      if (L.carrier) rows.push(['WIRE', p.fm.arrested ? String((p.fm.wireIdx || 0) + 1) : 'BOLTER'], ['TRAP', p.fm.arrested ? 'YES' : 'NO']);
      rows.push(['TIME', time], ['SCORE', score + ' / 100', 'grade'], ['GRADE', grade, 'grade']);
      UI.debrief('LANDING DEBRIEF', grade === 'F' ? 'Rough Arrival' : 'Wheels Down', `${p.spec.name} — ${sink < 1.2 ? 'butter.' : sink < 2.2 ? 'firm and controlled.' : sink < 3.5 ? 'carrier-grade firm.' : 'that one hurt.'}`, rows, true);
    } else if (M.result === 'victory') {
      UI.debrief('MISSION COMPLETE', 'Airspace Secured', `${S.kills} confirmed kill${S.kills === 1 ? '' : 's'} in the ${p.spec.name}.`, this.combatRows(time), true);
    } else if (M.result === 'shotdown') {
      UI.debrief('KIA', 'Shot Down', 'Your aircraft was destroyed by enemy fire.', this.combatRows(time), false);
    } else {
      UI.debrief('CRASH', 'Aircraft Lost', this.crashReason || 'The airframe did not survive.', this.mode === 'dogfight' ? this.combatRows(time) : [['MAX G', S.maxG.toFixed(1)], ['FLIGHT TIME', time]], false);
    }
  },
  combatRows(time) {
    const S = this.stats;
    return [['KILLS', S.kills], ['WAVE', S.wave], ['ROUNDS FIRED', S.shots], ['GUN HITS', S.hits], ['MISSILES FIRED', S.msl], ['MISSILE HITS', S.mhits], ['MAX G', S.maxG.toFixed(1)], ['TIME', time]];
  },

  computeWarnings(dt) {
    const p = this.player, fm = p.fm, W = this.warn;
    W.missile = false; W.missileDir = null;
    let md = 1e9;
    for (const m of this.weapons.missiles) if (m.active && m.target === p && !m.decoyed && !m.lost) { const d = m.pos.distTo(p.pos); if (d < md) { md = d; W.missile = true; W.missileDir = m.pos.clone().sub(p.pos); } }
    const o = fm.out;
    const landingCfg = fm.ctl.gear > 0.9 && o.tas < p.spec.approach * 1.6;
    W.pullUp = p.alive && !o.wow && o.agl < 1500 && fm.vel.y < -8 && o.agl + fm.vel.y * 5 < 0 && !(landingCfg && fm.vel.y > -12);
    W.stall = p.alive && !o.wow && o.stallFrac > 0.34 && o.tas > 3;
    W.gear = p.alive && fm.gearRetract && fm.ctl.gear < 0.5 && o.agl < 120 && fm.vel.y < -1 && o.tas < p.spec.approach * 1.35;
    W.overG = o.G > p.spec.fcs.gLimit * 1.08;
    this.damageFlash = Math.max(0, (this.damageFlash || 0) - dt * 1.5);
  },

  // ---------- camera ----------
  updateCamera(dt) {
    const C = this.camera, p = this.player, fm = p.fm, I = this.input;
    const R = p.geo.radius;
    const fov = UI.settings.fov * DEG;
    // free look with right mouse (keyboard mode)
    const freeLook = (I.mouse.buttons & 4 || I.mouse.buttons & 2) && !(I.mouseAim && C.mode === 'chase');
    if (freeLook) { C.lookYaw = clamp(C.lookYaw - I.mouse.dx * 0.004, -Math.PI, Math.PI); C.lookPitch = clamp(C.lookPitch - I.mouse.dy * 0.004, -1.2, 1.4); }
    else if (C.mode !== 'orbit') { C.lookYaw = damp(C.lookYaw, 0, 3, dt); C.lookPitch = damp(C.lookPitch, 0, 3, dt); }
    const up = _t2;
    C.near = 0.45;
    switch (C.mode) {
      case 'cockpit': {
        const e = p.spec.cockpit;
        const eye = new V3(e[0], e[1] + 0.02 - clamp((fm.out.G - 1) * 0.004, -0.02, 0.03), -e[2]).applyQuat(fm.q).add(p.pos);
        C.pos.copy(eye);
        const lq = _qa2.setEuler(-C.lookYaw * RAD * DEG, C.lookPitch, 0);
        C.q.copy(fm.q).mul(lq);
        C.near = 0.06; C.fov = fov;
        break;
      }
      case 'orbit': {
        if (I.mouse.buttons) { C.orbitYaw -= I.mouse.dx * 0.005; C.orbitPitch = clamp(C.orbitPitch + I.mouse.dy * 0.005, -1.2, 1.4); }
        const d = (R * 2.6 + 6) * C.zoom;
        C.pos.set(p.pos.x + Math.sin(C.orbitYaw) * Math.cos(C.orbitPitch) * d, p.pos.y + Math.sin(C.orbitPitch) * d, p.pos.z + Math.cos(C.orbitYaw) * Math.cos(C.orbitPitch) * d);
        C.q.setFromBasis(p.pos.clone().sub(C.pos).normalize(), up.set(0, 1, 0));
        C.fov = fov;
        break;
      }
      case 'flyby': {
        if (!C.flyby || C.flyby.distTo(p.pos) > 900 || (p.pos.clone().sub(C.flyby).dot(fm.vel) > 0 && C.flyby.distTo(p.pos) > 250)) {
          const r = fm.right(new V3());
          C.flyby = p.pos.clone().addScaled(fm.vel, 3.2).addScaled(r, R * 2 + 14).add(_t3.set(0, R * 0.6 + 4, 0));
          const gh = this.groundUnder(C.flyby); if (C.flyby.y < gh + 3) C.flyby.y = gh + 3;
        }
        C.pos.copy(C.flyby);
        C.q.setFromBasis(p.pos.clone().sub(C.pos).normalize(), up.set(0, 1, 0));
        C.fov = clamp(fov * 300 / Math.max(C.pos.distTo(p.pos), 60), 12 * DEG, fov);
        break;
      }
      case 'target': {
        const t = (p.wpn.lock && p.wpn.lock.alive) ? p.wpn.lock : this.aircraft.filter(a => a.team !== p.team && a.alive).sort((a, b) => a.pos.distSq(p.pos) - b.pos.distSq(p.pos))[0];
        if (t) {
          const dir = t.pos.clone().sub(p.pos).normalize();
          const pu = fm.up(new V3());
          C.pos.copy(p.pos).addScaled(dir, -(R * 2.3 + 8) * C.zoom).addScaled(pu, R * 0.5 + 2);
          const look = t.pos.clone().sub(C.pos).normalize().lerp(p.pos.clone().sub(C.pos).normalize(), 0.25).normalize();
          C.sq.slerp(new Quat().setFromBasis(look, pu), 1 - Math.exp(-dt * 6));
          C.q.copy(C.sq); C.fov = fov;
          break;
        }
        // fallthrough to chase if no target
      }
      default: {
        // chase
        C.sq.slerp(fm.q, 1 - Math.exp(-dt * 5.0));
        const mouseAim = I.mouseAim;
        const d = (R * 1.85 + 5) * C.zoom, h = R * 0.32 + 1.2;
        if (mouseAim) {
          const aim = this.aimDir;
          C.pos.copy(p.pos).addScaled(aim, -d); C.pos.y += h;
          C.q.setFromBasis(aim, up.set(0, 1, 0));
        } else {
          const lq = _qa2.setEuler(-C.lookYaw * RAD * DEG, -C.lookPitch * 0.6, 0);
          const cq = C.sq.clone().mul(lq);
          C.pos.copy(_t3.set(0, h, d).applyQuat(cq)).add(p.pos);
          const tgt = _t4.set(0, h * 0.42, -R * 0.4).applyQuat(cq).add(p.pos);
          C.q.setFromBasis(tgt.sub(C.pos).normalize(), up.set(0, 1, 0).applyQuat(cq));
        }
        C.fov = fov + clamp((fm.out.tas - 150) / 400, 0, 1) * 6 * DEG;
        C.near = 0.35;
      }
    }
    // keep above ground
    const gh = this.groundUnder(C.pos); if (C.pos.y < gh + 0.8 && C.mode !== 'cockpit') C.pos.y = gh + 0.8;
    // shake: guns, afterburner, buffet, hits
    C.shake = Math.max(0, C.shake - dt * 1.6);
    let sh = C.shake * 0.02 + (p.wpn.firing ? 0.0025 : 0) + fm.eng.ab * 0.0006 + (fm.out.stallFrac > 0.2 ? 0.004 * fm.out.stallFrac : 0) + clamp((fm.out.qbar - 60000) / 300000, 0, 1) * 0.002;
    if (sh > 0) { const t = performance.now() * 0.05; C.q.mul(_qa2.setEuler(Math.sin(t * 1.3) * sh * RAD * DEG, Math.sin(t * 1.7) * sh, Math.sin(t * 2.1) * sh * 0.5)); }
    // mouse aim reticle
    const ma = document.getElementById('mouseaim');
    if (I.mouseAim && this.state === 'flight' && C.mode !== 'orbit') {
      const pt = this.hud.projDir(this.renderer.VP, this.aimDir, [0, 0, 0]);
      if (pt) { ma.style.display = 'block'; ma.style.left = (pt[0] / this.hud.dpr) + 'px'; ma.style.top = (pt[1] / this.hud.dpr) + 'px'; } else ma.style.display = 'none';
    } else ma.style.display = 'none';
  },

  // ---------- visual effects per aircraft ----------
  emitAircraftFX(ac, dt) {
    const fm = ac.fm, fx = this.fx, q = fm.q, P = fm.pos;
    if (!ac.visible || fm.crashed) return;
    const E = ac.spec.engine;
    const camD = P.distTo(this.camera.pos);
    const t = this.renderer.time;
    const tmp = _t5, dir = _t6;
    // jet flames
    const nightK = 0.3 + 0.7 * this.renderer.env.night;
    if (E.type === 'jet' && ac.alive && camD < 6000) {
      const n = fm.eng.n, ab = fm.eng.ab, tv = fm.ctl.tvc;
      dir.set(0, Math.sin(tv), Math.cos(tv)).applyQuat(q);
      for (const nz of E.nozzles) {
        const r = nz[3];
        const ex = tmp.set(nz[0], nz[1], -nz[2] + 0.12).applyQuat(q).add(P);
        const ax = ex.x, ay = ex.y, az = ex.z;
        const fl = 1 + Math.sin(t * 47 + nz[0]) * 0.05 + Math.sin(t * 83 + nz[1]) * 0.03;
        const seed = (nz[0] * 7.31 + ac.uid * 0.37) % 1;
        if (ab > 0.03) {
          // raymarched plume: shock diamonds on the axis inside a turbulent orange envelope
          const spd = clamp(fm.out.tas / 300, 0, 1.3);
          fx.flame(ax, ay, az, r * (16 - spd * 3.5) * (0.35 + 0.65 * ab) * fl, dir.x, dir.y, dir.z, r, ab, n, seed, spd);
        }
        if (n > 0.3) { const L = r * 2.4 * n; fx.beam(ax, ay, az, r * 0.7, ax + dir.x * L, ay + dir.y * L, az + dir.z * L, r * 0.25, 1.1 * n * n, 0.4 * n * n, 0.12 * n, 0.4 * (1 - ab), 0, 0); }
        fx.glow(ax - dir.x * 0.3, ay - dir.y * 0.3, az - dir.z * 0.3, r * 0.95, 1.2 * n * n + 2.4 * ab, 0.45 * n * n + 1.2 * ab, 0.15 * n * n + 0.7 * ab);
        // engine glow lights the tail; afterburner lights the airframe and the ground when low.
        // (daylight swamps it, so it is scaled down by day to avoid an orange-tinted tail at noon)
        const Ieng = (8 * n * n * n + 140 * ab * fl) * (r / 0.5) * nightK;
        if (Ieng > 0.3) { const back = r * (1.5 + 3 * ab); fx.light(ax + dir.x * back, ay + dir.y * back, az + dir.z * back, 1.0, 0.5 + 0.12 * ab, 0.24 + 0.12 * ab, Ieng, 1 + ab); }
      }
    } else if (E.type === 'prop' && ac.alive && camD < 3000) {
      // exhaust stacks glow just aft of the cowling
      const thr = fm.ctl.throttle * (fm.eng.rpm / E.rpm);
      const ex = tmp.set(E.pos[0], E.pos[1], -E.pos[2] + 0.9).applyQuat(q).add(P);
      if (thr > 0.05) fx.light(ex.x, ex.y, ex.z, 1.0, 0.55, 0.3, 4 * thr * nightK, 0.8);
    }
    // navigation lights + strobes
    if (camD < 15000 && ac.alive) {
      if (!ac.nav) {
        const w = ac.spec.surfaces.find(s => s.kind === 'wing');
        const Fr = surfaceFrame(w, 1, 1), Fl = surfaceFrame(w, 1, -1);
        const lf = ac.spec.fuselage[ac.spec.fuselage.length - 1];
        ac.nav = [[Fl.le[0] - 0.05, Fl.le[1], Fl.le[2] + Fl.chord * 0.3], [Fr.le[0] + 0.05, Fr.le[1], Fr.le[2] + Fr.chord * 0.3], [0, lf[3] + lf[2] * 0.5, -lf[0] + 0.05]];
      }
      const night = this.renderer.env.night;
      const k = 0.6 + night * 1.6;
      const L = ac.nav;
      const pl = (i) => tmp.set(L[i][0], L[i][1], L[i][2]).applyQuat(q).add(P);
      let v = pl(0); fx.glow(v.x, v.y, v.z, 0.22, 3 * k, 0.1 * k, 0.08 * k);
      v = pl(0); fx.glow(v.x, v.y, v.z, 0.25, 4, 4, 4.5, 3);
      v = pl(1); fx.glow(v.x, v.y, v.z, 0.22, 0.1 * k, 2.6 * k, 0.6 * k);
      v = pl(1); fx.glow(v.x, v.y, v.z, 0.25, 4, 4, 4.5, 3);
      v = pl(2); fx.glow(v.x, v.y, v.z, 0.2, 2 * k, 2 * k, 2 * k);
    }
    // wingtip vortices (condensation at high load)
    const o = fm.out;
    const intensity = ac.alive ? clamp((o.G - 3.2) / 4, 0, 1) * smooth(60, 120, o.tas) * (1 - smooth(9000, 12000, P.y)) : 0;
    ac.trailT += dt;
    if (ac.trailT > 0.03) {
      ac.trailT = 0;
      for (let s = 0; s < 2; s++) {
        const tr = ac.trails[s];
        if (intensity > 0.02) { const L = ac.nav || [[-5, 0, 0], [5, 0, 0]]; const w = tmp.set(L[s][0], L[s][1], L[s][2]).applyQuat(q).add(P); tr.push([w.x, w.y, w.z, t, intensity]); }
        while (tr.length && t - tr[0][3] > 1.4) tr.shift();
        if (tr.length > 60) tr.shift();
      }
    }
    for (const tr of ac.trails) for (let i = 1; i < tr.length; i++) {
      const a = tr[i - 1], b = tr[i]; if (b[3] - a[3] > 0.1) continue;
      const fa = (1 - (t - a[3]) / 1.4) * a[4], fb = (1 - (t - b[3]) / 1.4) * b[4];
      fx.beam(a[0], a[1], a[2], 0.18 + (t - a[3]) * 0.3, b[0], b[1], b[2], 0.18 + (t - b[3]) * 0.3, 1, 1, 1, fa * 0.55, fb * 0.55, 1);
    }
    // contrails at altitude
    if (!ac.contrail) ac.contrail = { pts: [], acc: 0 };
    const CT = ac.contrail;
    if (P.y > 8200 && ac.alive && (E.type === 'jet' || E.type === 'prop')) {
      CT.acc += dt;
      if (CT.acc > 0.2) { CT.acc = 0; const zb = E.type === 'jet' ? -E.nozzles[0][2] + 3 : ac.geo.length * 0.5; const w = tmp.set(0, 0, zb).applyQuat(q).add(P); CT.pts.push([w.x, w.y, w.z, t]); }
    }
    while (CT.pts.length && (t - CT.pts[0][3] > 30 || CT.pts.length > 160)) CT.pts.shift();
    for (let i = 1; i < CT.pts.length; i++) {
      const a = CT.pts[i - 1], b = CT.pts[i]; if (b[3] - a[3] > 0.5) continue;
      const aa = (t - a[3]), bb = (t - b[3]);
      fx.beam(a[0], a[1], a[2], 1.2 + aa * 0.35, b[0], b[1], b[2], 1.2 + bb * 0.35, 1, 1, 1, 0.5 * (1 - aa / 30) * Math.min(1, aa * 3), 0.5 * (1 - bb / 30) * Math.min(1, bb * 3), 1);
    }
    // vapor: high-alpha wing condensation & transonic cone
    if (ac.alive && camD < 2500 && o.qbar > 12000) {
      for (const s of fm.mainWingSegs) {
        if (s.cl > 1.05 && Math.random() < 0.6) {
          const w = tmp.set(s.pos.x + s.n.x * 0.25, s.pos.y + s.n.y * 0.25 + 0.15, s.pos.z + 0.4).applyQuat(q).add(P);
          fx.emit(PT.VAPOR, w.x, w.y, w.z, fm.vel.x, fm.vel.y, fm.vel.z, 0.12, s.chord * 0.6, s.chord * 1.1, 1, 1, 1, clamp((s.cl - 1.05) * 0.6, 0, 0.35), 0);
        }
      }
      if (o.mach > 0.94 && o.mach < 1.03 && P.y < 7000) {
        for (let k = 0; k < 6; k++) {
          const a = Math.random() * 6.283, rr = ac.geo.radius * 0.45;
          const w = tmp.set(Math.cos(a) * rr, Math.sin(a) * rr, ac.geo.length * 0.05).applyQuat(q).add(P);
          fx.emit(PT.VAPOR, w.x, w.y, w.z, fm.vel.x, fm.vel.y, fm.vel.z, 0.07, ac.geo.radius * 0.3, ac.geo.radius * 0.5, 1, 1, 1, 0.35, 0);
        }
      }
    }
    // damage smoke and fire
    if (ac.smoke > 0 || !ac.alive) {
      // smoke and fire pour out of the worst wound (falls back to the airframe centre)
      const H = ac.hits; let wi = -1, ww = 0;
      for (let i = 0; i < 8; i++) if (H[i * 4 + 3] > ww) { ww = H[i * 4 + 3]; wi = i; }
      const src = wi >= 0 ? _t7.set(H[wi * 4], H[wi * 4 + 1], H[wi * 4 + 2]).applyQuat(q).add(P) : _t7.copy(P);
      const step = dt;   // spread emissions along the path flown this frame so trails stay continuous
      const rate = (ac.alive ? ac.smoke * 30 : 55) * dt;
      for (let k = 0; k < rate + Math.random() - 0.5; k++) {
        const c = ac.alive ? 0.32 * (1 - ac.smoke * 0.5) : 0.06, j = Math.random() * step;
        fx.emit(PT.DARK, src.x - fm.vel.x * j + (Math.random() - 0.5) * 2, src.y - fm.vel.y * j + (Math.random() - 0.5) * 2, src.z - fm.vel.z * j + (Math.random() - 0.5) * 2, fm.vel.x * 0.15, fm.vel.y * 0.15, fm.vel.z * 0.15, 3 + Math.random() * 3, 1.5, 10 + 8 * (1 - ac.hp / ac.maxHp), c, c, c, 0.7, 1.5);
      }
      if (ac.fire || !ac.alive) {
        const big = ac.alive ? 1 : 1.6;
        const nf = (ac.alive ? 50 : 90) * dt;
        for (let k = 0; k < nf + Math.random() - 0.5; k++) {
          const j = Math.random() * step;
          fx.puff(src.x - fm.vel.x * j, src.y - fm.vel.y * j, src.z - fm.vel.z * j, fm.vel.x * 0.62, fm.vel.y * 0.62, fm.vel.z * 0.62,
            0.5 + Math.random() * 0.4, 0.6 * big, (2 + Math.random() * 1.2) * big, 0.06, 0.85, 3, 0.14 + 0.06 * big, 0.95);
        }
        const fl = 0.75 + 0.25 * Math.sin(this.renderer.time * 21 + ac.seed * 40) * Math.sin(this.renderer.time * 13.7);
        // the light sits in the flame trail just aft of the wound, so the airframe isn't blown out
        const vl = fm.vel.len() || 1, la = Math.min(6, vl * 0.03);
        fx.light(src.x - fm.vel.x / vl * la, src.y - fm.vel.y / vl * la, src.z - fm.vel.z / vl * la, 1.0, 0.46, 0.15, (ac.alive ? 600 : 1200) * fl, 5);
      }
    }
    // muzzle flash
    if (ac.wpn.firing && ac.spec.guns) {
      const g = ac.spec.guns.pts[ac.wpn.barrel % ac.spec.guns.pts.length];
      const w = tmp.set(g[0], g[1], -g[2] - 0.6).applyQuat(q).add(P);
      if (Math.random() < 0.7) { fx.glow(w.x, w.y, w.z, 0.9 + Math.random() * 0.6, 6, 4.2, 2); fx.light(w.x, w.y, w.z, 1.0, 0.75, 0.4, 120, 2.5); }
    }
    // ground scraping sparks
    if (fm.scraping > 4) { for (let k = 0; k < 4; k++) fx.emit(PT.SPARK, P.x, P.y - 1, P.z, (Math.random() - 0.5) * 8, 3, (Math.random() - 0.5) * 8, 0.4, 0.3, 0.1, 1, 0.7, 0.3, 1, 1); fm.scraping = 0; }
  },

  // aero visualization: force vectors + induced-flow streamlines (player)
  emitAeroViz(dt) {
    const ac = this.player, fm = ac.fm, fx = this.fx, q = fm.q, P = fm.pos;
    const scale = ac.geo.length * 0.45 / (fm.mass * G0);
    const a = _t5, b = _t6;
    for (const s of fm.segs) {
      if (s.kind === 'body') continue;
      a.copy(s.pos).applyQuat(q).add(P);
      b.copy(s.force).applyQuat(q);
      const L = b.len(); if (L < 1) continue;
      const k = Math.min(scale * 1.5, ac.geo.length * 0.6 / L);
      const col = s.stalled ? [3, 0.4, 2.4] : s.cl >= 0 ? [3.2, 1.2, 0.4] : [0.4, 1.4, 3.2];
      fx.beam(a.x, a.y, a.z, 0.05, a.x + b.x * k, a.y + b.y * k, a.z + b.z * k, 0.03, col[0], col[1], col[2], 0.9, 0.6, 0);
      fx.glow(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k, 0.12, col[0], col[1], col[2]);
    }
    // streamlines advected through the vortex field in body frame
    const R = ac.geo.radius, span = ac.geo.wingSpan || R;
    if (!this.streams || this.streams.ac !== ac) {
      this.streams = { ac, p: [] };
      for (let i = 0; i < 260; i++) this.streams.p.push({ v: new V3(), age: 99 });
    }
    const vb = _t1.copy(fm.vel).sub(fm.wind).applyQuatInv(q);
    const V = vb.len(); if (V < 5) return;
    const segs = fm.segs, wl = 60, wx = -vb.x / V, wy = -vb.y / V, wz = -vb.z / V;
    const noseZ = -ac.spec.fuselage[0][0] - 3;
    const h = Math.min(dt, 0.03);
    const vi = new V3();
    for (const sp of this.streams.p) {
      if (sp.age > 2.2 || sp.v.z > ac.geo.length * 0.8 + 12 || Math.abs(sp.v.x) > span * 1.6) {
        sp.v.set((Math.random() * 2 - 1) * span * 1.2, (Math.random() * 2 - 1) * R * 0.35 + (Math.random() < 0.5 ? 0.3 : -0.3), noseZ - Math.random() * 4);
        sp.age = 0; sp.prev = null;
      }
      // local flow = freestream + induced velocity of all panels
      vi.set(-vb.x, -vb.y, -vb.z);
      for (const o of segs) {
        if (o.kind === 'body' || Math.abs(o.gamma) < 1e-3) continue;
        const A = o.A, B = o.B, rc = o.chord * 0.3, G = o.gamma;
        bsSeg(sp.v, A.x + wx * wl, A.y + wy * wl, A.z + wz * wl, A.x, A.y, A.z, G, rc, vi);
        bsSeg(sp.v, A.x, A.y, A.z, B.x, B.y, B.z, G, rc, vi);
        bsSeg(sp.v, B.x, B.y, B.z, B.x + wx * wl, B.y + wy * wl, B.z + wz * wl, G, rc, vi);
      }
      // slipstream
      if (fm.prop && fm.eng.vi > 0.1) { const pr = fm.prop.pos; const dz = sp.v.z - pr.z; const rr = Math.hypot(sp.v.x - pr.x, sp.v.y - pr.y); if (dz > -0.5 && rr < fm.prop.R) { vi.z += fm.eng.vi * (1 + dz / Math.sqrt(dz * dz + fm.prop.R * fm.prop.R)); vi.x += (sp.v.y - pr.y) / (rr + 0.1) * fm.eng.vi * 0.5 * fm.prop.sense; vi.y -= (sp.v.x - pr.x) / (rr + 0.1) * fm.eng.vi * 0.5 * fm.prop.sense; } }
      // slow-motion advection so the flow is readable (time-scaled by 1/V)
      const ts = h * 9 / V * Math.max(ac.geo.length, 8) * 0.18;
      const ox = sp.v.x, oy = sp.v.y, oz = sp.v.z;
      sp.v.x += vi.x * ts; sp.v.y += vi.y * ts; sp.v.z += vi.z * ts;
      sp.age += h;
      const w0 = a.set(ox, oy, oz).applyQuat(q).add(P), w1 = b.copy(sp.v).applyQuat(q).add(P);
      const down = clamp(-(vi.y + vb.y) / V * 6, -1, 1);
      const al = Math.min(1, sp.age * 4) * Math.max(0, 1 - sp.age / 2.2);
      fx.beam(w0.x, w0.y, w0.z, 0.03, w1.x, w1.y, w1.z, 0.03, 0.8 + Math.max(0, -down) * 2, 1.6, 2.4 + Math.max(0, down) * 1.5, al * 0.9, al * 0.9, 0);
    }
  },

  // ---------- render ----------
  renderFrame(dt) {
    const S = {
      camera: this.camera, aircraft: this.aircraft, weapons: this.weapons, fx: this.fx, player: this.player,
      aeroView: this.aeroView, wind: this.wind, shadowFocus: this.player ? this.player.pos : (this.showAc ? this.showAc.pos : null),
      gloc: this.state === 'flight' || this.state === 'debrief' ? this.gl : 0, redout: this.rd, damageFx: this.damageFlash || 0,
      cockpit: this.camera.mode === 'cockpit' && this.state !== 'menu', overcastAlt: 1500, fade: 1,
    };
    if (this.state === 'flight' && this.player && !this.player.alive) S.damageFx = 0.6;
    this.renderer.render(S, dt);
    if ((this.state === 'flight' || this.state === 'paused') && this.player) { this.hudMode(); this.hud.draw(this, dt); }
    else this.hud.clear();
  },
  hudMode() { }
};

// developer hooks (used by debug builds to capture frames)
window.__dbg = {
  log(x) { native({ cmd: 'log', text: typeof x === 'string' ? x : JSON.stringify(x) }); },
  shot(name = 'shot.jpg', w = 1280) {
    Game.renderFrame(0);
    const gc = document.getElementById('gl'), hc = document.getElementById('hud');
    const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * gc.height / gc.width);
    const g = c.getContext('2d'); g.drawImage(gc, 0, 0, c.width, c.height); g.drawImage(hc, 0, 0, c.width, c.height);
    native({ cmd: 'shot', name, data: c.toDataURL('image/jpeg', 0.88).split(',')[1] });
  },
};

window.addEventListener('load', () => { Game.init().catch(showError); });
