'use strict';
// ---------------------------------------------------------------------------
// Menus, setup forms, settings persistence, map, controls reference.
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const STORE = {
  get(k, d) { try { const v = localStorage.getItem('slipstream.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('slipstream.' + k, JSON.stringify(v)); } catch (e) { } },
};

const DEFAULT_SETTINGS = { quality: 'medium', dynRes: true, gfx: true, fov: 72, assist: true, ctl: 'kbd', invert: false, sens: 1, units: 'avi', volume: 0.8, music: 0.5, jetVol: 1, propVol: 1, windVol: 1 };
const DEFAULT_CFG = { mode: 'free', aircraft: 'viper', location: 'HPI', spawn: 'runway', tod: 15.5, wx: 'scattered', wind: 4, wdir: 250, turb: 1, enemies: 2, enemyType: 'same', skill: 1, allies: 1, start: 'merge', arm: 'all', waves: false };
const WEATHER = {
  clear: { label: 'CLEAR', cover: 0.06, haze: 0.8, overcast: 0 },
  scattered: { label: 'SCATTERED', cover: 0.42, haze: 1.0, overcast: 0 },
  broken: { label: 'BROKEN', cover: 0.64, haze: 1.3, overcast: 0 },
  overcast: { label: 'OVERCAST', cover: 0.93, haze: 1.9, overcast: 0.88 },
};

const UI = {
  stack: [],
  init(game) {
    this.g = game;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, STORE.get('settings', {}));
    this.cfg = Object.assign({}, DEFAULT_CFG, STORE.get('cfg', {}));
    // main nav
    $$('#menu .mainnav button').forEach(b => b.addEventListener('click', () => this.navMain(b.dataset.go)));
    $$('[data-back]').forEach(b => b.addEventListener('click', () => this.back()));
    $$('[data-pause]').forEach(b => b.addEventListener('click', () => this.pauseAction(b.dataset.pause)));
    $$('[data-db]').forEach(b => b.addEventListener('click', () => this.debriefAction(b.dataset.db)));
    $('#launchBtn').addEventListener('click', () => this.launch());
    $$('button').forEach(b => b.addEventListener('mouseenter', () => game.audio.oneShot('click')));
    this.buildSettings();
    this.buildControls();
    this.applySettings();
  },
  show(id, push = true) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    if (id) $('#' + id).classList.add('active');
    if (push) this.stack.push(id);
    this.current = id;
  },
  back() {
    this.stack.pop();
    const prev = this.stack.pop() || 'menu';
    if (prev === 'pause') { this.show('pause'); return; }
    this.show(prev);
  },
  navMain(go) {
    if (go === 'quit') { this.g.quit(); return; }
    if (go === 'settings') return this.show('settings');
    if (go === 'controls') return this.show('controls');
    this.cfg.mode = go;
    this.buildSetup();
    this.show('setup');
  },

  // ---------- setup ----------
  seg(el, options, value, onChange) {
    el.innerHTML = '';
    options.forEach(([v, label]) => {
      const b = document.createElement('button'); b.textContent = label; if (v === value) b.classList.add('on');
      b.addEventListener('click', () => { $$('#' + el.id + ' button').forEach(x => x.classList.remove('on')); b.classList.add('on'); onChange(v); this.g.audio.oneShot('click'); });
      el.appendChild(b);
    });
  },
  stepper(el, value, min, max, onChange) {
    el.innerHTML = '';
    const m = document.createElement('button'), s = document.createElement('span'), p = document.createElement('button');
    m.textContent = '−'; p.textContent = '+'; s.textContent = value;
    const set = (v) => { value = clamp(v, min, max); s.textContent = value; onChange(value); };
    m.onclick = () => set(value - 1); p.onclick = () => set(value + 1);
    el.append(m, s, p);
  },
  acStats(a) {
    const vmax = { skylark: 0.15, zephyr: 0.22, mustang: 0.42, spitfire: 0.4, tiger: 0.62, viper: 0.85, flanker: 0.88, raptor: 0.98, warthog: 0.38, typhoon: 0.9, skyliner: 0.55, condor: 0.08 }[a.id];
    const agi = clamp(a.fcs.pmax / 7 * 0.6 + a.fcs.gLimit / 10 * 0.4, 0.08, 1);
    const fire = a.guns ? clamp((a.guns.rof * a.guns.dmg) / 1500 * 0.6 + ((a.weapons.ir || 0) + (a.weapons.radar || 0)) / 8 * 0.4, 0.1, 1) : 0;
    return [vmax, agi, fire];
  },
  buildSetup() {
    const c = this.cfg, mode = c.mode;
    $('#setupMode').textContent = { free: 'FREE FLIGHT', dogfight: 'DOGFIGHT', landing: 'LANDING CHALLENGE' }[mode];
    const list = mode === 'dogfight' ? COMBAT_AIRCRAFT : AIRCRAFT;
    if (!list.find(a => a.id === c.aircraft)) c.aircraft = list.find(a => a.id === 'viper') ? 'viper' : list[0].id;
    // aircraft list
    const acl = $('#acList'); acl.innerHTML = '';
    list.forEach(a => {
      const [v, ag, f] = this.acStats(a);
      const d = document.createElement('div'); d.className = 'item' + (a.id === c.aircraft ? ' sel' : '');
      d.innerHTML = `<div><div class="nm">${a.name}</div><div class="rl">${a.role} · ${a.era}</div></div>
        <div class="bars"><span>SPD</span><i style="--v:${v * 100}%"></i><span>AGI</span><i style="--v:${ag * 100}%"></i>${f ? `<span>GUN</span><i style="--v:${f * 100}%"></i>` : ''}</div>`;
      d.onclick = () => { c.aircraft = a.id; $$('#acList .item').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); this.updateSummary(); this.g.showcase(c); this.g.audio.oneShot('click'); };
      acl.appendChild(d);
    });
    // locations
    const locs = AIRPORTS.map(a => ({ id: a.id, name: a.short, sub: a.desc })).concat([{ id: 'CVN', name: 'CVN-79 RESOLUTE', sub: 'Nuclear carrier steaming south of the island. Catapult launches and arrested landings.' }]);
    if (mode === 'dogfight') { locs.unshift({ id: 'AIR', name: 'OPEN SKY', sub: 'Start already airborne over the island.' }); if (!locs.find(l => l.id === c.location)) c.location = 'AIR'; }
    else if (c.location === 'AIR') c.location = 'HPI';
    const ll = $('#locList'); ll.innerHTML = '';
    locs.forEach(l => {
      const d = document.createElement('div'); d.className = 'item' + (l.id === c.location ? ' sel' : '');
      d.innerHTML = `<div><div class="nm">${l.name}</div><div class="rl">${l.id === 'AIR' ? 'AIRBORNE' : l.id === 'CVN' ? 'CARRIER · 330 M DECK' : this.rwyText(l.id)}</div></div>`;
      d.title = l.sub;
      d.onclick = () => { c.location = l.id; $$('#locList .item').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); this.drawMap(); this.updateSummary(); this.g.showcase(c); this.g.audio.oneShot('click'); };
      ll.appendChild(d);
    });
    const spawns = mode === 'landing' ? [['approach', 'APPROACH'], ['long', 'LONG FINAL']] : [['runway', c.location === 'CVN' ? 'CATAPULT' : 'RUNWAY'], ['approach', 'APPROACH'], ['air', 'AIRBORNE']];
    if (!spawns.find(s => s[0] === c.spawn)) c.spawn = spawns[0][0];
    this.seg($('#spawnSeg'), spawns, c.spawn, v => { c.spawn = v; this.updateSummary(); });
    $('#spawnField').style.display = mode === 'dogfight' ? 'none' : '';
    // conditions
    const tod = $('#tod'); tod.value = c.tod;
    const fmtT = (t) => { const h = Math.floor(t), m = Math.round((t - h) * 60); const n = t < 5 || t > 20.5 ? 'NIGHT' : t < 7.5 ? 'DAWN' : t > 18 ? 'DUSK' : t < 11 ? 'MORNING' : t < 15 ? 'MIDDAY' : 'AFTERNOON'; return pad(h, 2) + ':' + pad(m, 2) + '  ' + n; };
    tod.oninput = () => { c.tod = +tod.value; $('#todOut').textContent = fmtT(c.tod); this.updateSummary(); };
    tod.onchange = () => this.g.showcase(c);
    $('#todOut').textContent = fmtT(c.tod);
    this.seg($('#wxSeg'), Object.entries(WEATHER).map(([k, v]) => [k, v.label]), c.wx, v => { c.wx = v; this.updateSummary(); this.g.showcase(c); });
    const wind = $('#wind'), wdir = $('#wdir'), turb = $('#turb');
    wind.value = c.wind; wdir.value = c.wdir; turb.value = c.turb;
    const upW = () => { $('#windOut').textContent = c.wind + ' KT'; $('#wdirOut').textContent = pad(c.wdir, 3) + '°'; $('#turbOut').textContent = ['CALM', 'LIGHT', 'MODERATE', 'SEVERE'][c.turb]; };
    wind.oninput = () => { c.wind = +wind.value; upW(); }; wdir.oninput = () => { c.wdir = +wdir.value; upW(); }; turb.oninput = () => { c.turb = +turb.value; upW(); };
    upW();
    // combat
    $('#combatBox').style.display = mode === 'dogfight' ? '' : 'none';
    if (mode === 'dogfight') {
      this.stepper($('#nEnemy'), c.enemies, 1, 8, v => { c.enemies = v; this.updateSummary(); });
      this.stepper($('#nAlly'), c.allies, 0, 4, v => { c.allies = v; this.updateSummary(); });
      const sel = $('#enemyType'); sel.innerHTML = '';
      [['same', 'SAME AS PLAYER'], ['mixed', 'MIXED'], ...COMBAT_AIRCRAFT.map(a => [a.id, a.name])].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === c.enemyType) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { c.enemyType = sel.value; this.updateSummary(); };
      this.seg($('#skillSeg'), [[0, 'ROOKIE'], [1, 'VETERAN'], [2, 'ACE']], c.skill, v => { c.skill = v; this.updateSummary(); });
      this.seg($('#startSeg'), [['merge', 'HEAD-ON'], ['neutral', 'NEUTRAL'], ['offensive', 'OFFENSIVE'], ['defensive', 'DEFENSIVE'], ['bvr', 'BVR']], c.start, v => { c.start = v; });
      this.seg($('#armSeg'), [['all', 'GUNS + MISSILES'], ['guns', 'GUNS ONLY']], c.arm, v => { c.arm = v; });
      this.seg($('#waveSeg'), [[false, 'SINGLE'], [true, 'ENDLESS WAVES']], c.waves, v => { c.waves = v; });
    }
    this.drawMap();
    this.updateSummary();
    this.g.showcase(c);
  },
  rwyText(id) {
    const ap = AIRPORTS.find(a => a.id === id); if (!ap) return '';
    const r = ap.rects.filter(r => r.t <= 3).map(r => r.name).join(' · ');
    return 'RWY ' + r;
  },
  updateSummary() {
    const c = this.cfg; const a = AIRCRAFT_BY_ID[c.aircraft];
    const loc = c.location === 'CVN' ? 'CVN-79' : c.location === 'AIR' ? 'OPEN SKY' : (AIRPORTS.find(x => x.id === c.location) || {}).short;
    let s = `<b>${a.name}</b> &nbsp;·&nbsp; ${loc} &nbsp;·&nbsp; ${WEATHER[c.wx].label} &nbsp;·&nbsp; ${pad(Math.floor(c.tod), 2)}:${pad((c.tod % 1) * 60, 2)}`;
    if (c.mode === 'dogfight') s += ` &nbsp;·&nbsp; <b>${c.enemies}</b> HOSTILE${c.enemies > 1 ? 'S' : ''} · ${['ROOKIE', 'VETERAN', 'ACE'][c.skill]}`;
    $('#summary').innerHTML = s;
  },
  drawMap() {
    const cv = $('#mapCv'), g = cv.getContext('2d'), N = cv.width;
    const T = this.g.world.terrain;
    if (!this.mapImg) {
      const img = g.createImageData(N, N); const d = img.data;
      const half = TERRAIN.SIZE / 2;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const x = -half + (i + 0.5) / N * TERRAIN.SIZE, z = -half + (j + 0.5) / N * TERRAIN.SIZE;
        const h = T.heightAt(x, z), hx = T.heightAt(x + 40, z), hz = T.heightAt(x, z + 40);
        const sh = clamp(0.75 + ((h - hx) - (h - hz)) * 0.02, 0.35, 1.25);
        let r, gg, b;
        if (h < 0) { const k = clamp(-h / 250, 0, 1); r = 10 + 10 * (1 - k); gg = 30 + 40 * (1 - k); b = 48 + 50 * (1 - k); }
        else {
          const m = T.sampleF(T.M, x, z);
          const k = clamp(h / 2200, 0, 1);
          r = (40 + 70 * k + (1 - m) * 60) * sh; gg = (60 + 50 * k + m * 20) * sh; b = (40 + 60 * k) * sh;
          if (h > 1800) { r = gg = b = 200 * sh; }
        }
        const o = (j * N + i) * 4; d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
      }
      this.mapImg = img;
    }
    g.putImageData(this.mapImg, 0, 0);
    const toPx = (x, z) => [(x / TERRAIN.SIZE + 0.5) * N, (z / TERRAIN.SIZE + 0.5) * N];
    // grid
    g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1;
    for (let k = 1; k < 8; k++) { g.beginPath(); g.moveTo(k * N / 8, 0); g.lineTo(k * N / 8, N); g.moveTo(0, k * N / 8); g.lineTo(N, k * N / 8); g.stroke(); }
    g.font = '600 12px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
    const sel = this.cfg.location;
    for (const ap of AIRPORTS) {
      const [px, py] = toPx(ap.x, ap.z);
      for (const r of ap.rects) if (r.t <= 3) {
        const [x, z] = apLocal(ap, r.u, r.v); const h = (ap.hdg + r.h) * DEG; const [cx, cy] = toPx(x, z); const L = r.len / TERRAIN.SIZE * N / 2;
        g.strokeStyle = ap.id === sel ? '#ffb347' : 'rgba(255,255,255,0.85)'; g.lineWidth = ap.id === sel ? 3 : 2;
        g.beginPath(); g.moveTo(cx - Math.sin(h) * L, cy + Math.cos(h) * L); g.lineTo(cx + Math.sin(h) * L, cy - Math.cos(h) * L); g.stroke();
      }
      g.fillStyle = ap.id === sel ? '#ffb347' : 'rgba(255,255,255,0.8)';
      g.fillText(ap.short, px + 10, py - 14);
    }
    const C = this.g.world.carrier; const [cx, cy] = toPx(C.pos.x, C.pos.z);
    g.fillStyle = sel === 'CVN' ? '#ffb347' : 'rgba(255,255,255,0.8)'; g.beginPath(); g.moveTo(cx, cy - 6); g.lineTo(cx + 5, cy + 5); g.lineTo(cx - 5, cy + 5); g.closePath(); g.fill();
    g.fillText('CVN-79', cx + 10, cy);
    // north arrow
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillText('N ▲', N - 40, 16);
    g.fillText('10 KM', 12, N - 14); g.fillRect(12, N - 26, N * 10000 / TERRAIN.SIZE, 2);
  },
  launch() {
    STORE.set('cfg', this.cfg);
    this.g.startMission(Object.assign({}, this.cfg));
  },

  // ---------- settings ----------
  buildSettings() {
    const s = this.settings;
    const save = () => { STORE.set('settings', s); this.applySettings(); };
    this.seg($('#qSeg'), [['low', 'PERFORMANCE'], ['medium', 'BALANCED'], ['high', 'ULTRA'], ['max', 'MAX']], s.quality, v => { s.quality = v; save(); });
    this.seg($('#dynSeg'), [[true, 'ON'], [false, 'OFF']], s.dynRes, v => { s.dynRes = v; save(); });
    this.seg($('#gfxSeg'), [[true, 'ON'], [false, 'OFF']], s.gfx, v => { s.gfx = v; save(); });
    this.seg($('#assistSeg'), [[true, 'ON'], [false, 'OFF']], s.assist, v => { s.assist = v; save(); });
    this.seg($('#ctlSeg'), [['kbd', 'KEYBOARD / PAD'], ['mouse', 'MOUSE AIM']], s.ctl, v => { s.ctl = v; save(); });
    this.seg($('#invSeg'), [[false, 'NORMAL'], [true, 'INVERTED']], s.invert, v => { s.invert = v; save(); });
    this.seg($('#unitSeg'), [['avi', 'KT · FT'], ['met', 'KM/H · M']], s.units, v => { s.units = v; save(); });
    const rng = (id, out, fmt, key) => { const el = $('#' + id); el.value = s[key]; const up = () => $('#' + out).textContent = fmt(s[key]); el.oninput = () => { s[key] = +el.value; up(); save(); }; up(); };
    rng('fov', 'fovOut', v => v + '°', 'fov');
    rng('sens', 'sensOut', v => v.toFixed(1) + '×', 'sens');
    rng('vol', 'volOut', v => Math.round(v * 100) + '%', 'volume');
    rng('mus', 'musOut', v => v > 0 ? Math.round(v * 100) + '%' : 'OFF', 'music');
    rng('jetv', 'jetvOut', v => v > 0 ? Math.round(v * 100) + '%' : 'OFF', 'jetVol');
    rng('propv', 'propvOut', v => v > 0 ? Math.round(v * 100) + '%' : 'OFF', 'propVol');
    rng('windv', 'windvOut', v => v > 0 ? Math.round(v * 100) + '%' : 'OFF', 'windVol');
  },
  applySettings() {
    const s = this.settings, g = this.g;
    if (g.renderer.qualityName !== s.quality) g.renderer.setQuality(s.quality);
    g.renderer.dynRes = s.dynRes; if (!s.dynRes) g.renderer.renderScale = 1;
    g.input.invert = s.invert; g.input.sens = s.sens; g.input.mouseAim = s.ctl === 'mouse';
    g.hud.units = s.units;
    g.audio.setVolume(s.volume); g.audio.setMusicVolume(s.music); g.audio.setEngineVolumes(s.jetVol, s.propVol, s.windVol);
  },

  buildControls() {
    const groups = [
      ['Flight', [['Pitch', ['W', 'S'], '↑ ↓'], ['Roll', ['A', 'D'], '← →'], ['Rudder / nosewheel', ['Q', 'E']], ['Throttle', ['⇧', '⌃'], '+ −'], ['Landing gear', ['G']], ['Flaps up / down', ['[', ']']], ['Wheel brakes (hold)', ['B']], ['Speed brake', ['N']], ['Tail hook', ['H']], ['Catapult launch', ['↵']], ['Trim nose up / down', [',', '.']]]],
      ['Combat', [['Guns', ['SPACE']], ['Fire missile', ['F']], ['Select gun / IR / radar', ['1', '2', '3']], ['Cycle target', ['T']], ['Flares + chaff', ['X']], ['Mouse aim: guns / missile', ['LMB', 'RMB']]]],
      ['View & System', [['Cycle camera', ['C']], ['Cockpit view', ['V']], ['Target padlock camera', ['Y']], ['Free look (hold & drag)', ['RMB']], ['Zoom', ['WHEEL']], ['Aero visualizer', ['O']], ['HUD mode', ['U']], ['Toggle mouse aim', ['M']], ['Respawn', ['⌫']], ['Pause', ['ESC']], ['Controls', ['F1']]]],
    ];
    const grid = $('#keyGrid'); grid.innerHTML = '';
    for (const [title, rows] of groups) {
      const p = document.createElement('div'); p.className = 'panel';
      p.innerHTML = `<h3><b class="mono">${title[0]}</b>${title}</h3>` + rows.map(([n, k, alt]) => `<div class="krow"><span>${n}</span><span class="kc">${k.map(x => `<kbd>${x}</kbd>`).join('')}${alt ? `<kbd>${alt}</kbd>` : ''}</span></div>`).join('');
      grid.appendChild(p);
    }
    const gp = document.createElement('div'); gp.className = 'panel';
    gp.innerHTML = `<h3><b class="mono">G</b>Gamepad</h3>` + [['Pitch / roll', 'L-STICK'], ['Rudder', 'R-STICK X'], ['Throttle', 'R-STICK Y'], ['Guns', 'RT'], ['Missile', 'LT'], ['Flares', 'A'], ['Camera', 'B'], ['Gear', 'X'], ['Target', 'Y']].map(([n, k]) => `<div class="krow"><span>${n}</span><span class="kc"><kbd>${k}</kbd></span></div>`).join('');
    grid.appendChild(gp);
  },

  // ---------- pause & debrief ----------
  pauseAction(a) {
    if (a === 'resume') this.g.resume();
    else if (a === 'restart') this.g.restart();
    else if (a === 'menu') this.g.toMenu();
    else if (a === 'settings') this.show('settings');
    else if (a === 'controls') this.show('controls');
  },
  debriefAction(a) {
    if (a === 'restart') this.g.restart();
    else if (a === 'menu') this.g.toMenu();
    else if (a === 'continue') { this.show(null, false); this.g.state = 'flight'; }
  },
  debrief(kind, title, sub, rows, canContinue) {
    $('#dbKind').textContent = kind; $('#dbTitle').textContent = title; $('#dbSub').textContent = sub;
    $('#dbGrid').innerHTML = rows.map(([k, v, cls]) => `<div class="${cls || ''}"><span>${k}</span><b>${v}</b></div>`).join('');
    $('#dbContinue').style.display = canContinue ? '' : 'none';
    this.show('debrief');
  },
  toast(text, t = 4) {
    const el = $('#toast'); el.textContent = text; el.classList.add('show');
    clearTimeout(this._tt); this._tt = setTimeout(() => el.classList.remove('show'), t * 1000);
  },
};
