// rounds.js — match flow (freeze/buy → live → round end → restart) + the C4 bomb
// objective. Classic script, shared global scope. Loads after physics (bombSites,
// respawn, gsPos), game (playerMoney, hasJoined, ownedWeapons), grenades
// (_spawnHEExplosion) and enemy (enemies, _enemyRespawn, enemyRadiusDamage); the main
// loop (input.js) calls updateRound(dt) each frame.
//
// No opponent team yet (bots are future): a round therefore ends by the bomb or the
// clock — T win if the bomb explodes, CT win if it's defused or time runs out. Money
// rewards approximate CS (win/loss bonus + plant bonus).

const BUY_TIME      = 15;    // s you can buy from round start (CS mp_buytime-ish)
const ROUND_TIME    = 115;   // 1:55 main round clock
const C4_TIME       = 40;    // bomb fuse after a successful plant
const PLANT_TIME    = 3.0;   // hold E in the site to plant
const DEFUSE_TIME   = 10;    // hold E on the bomb to defuse (no kit)
const DEFUSE_KIT    = 5;     // with a defuse kit
const ROUND_END     = 5;     // banner before the next round
const C4_DAMAGE     = 500, C4_RADIUS = 700;
const PLANT_REWARD  = 800, WIN_REWARD = 3250, LOSS_REWARD = 1400;

let roundPhase = 'idle';     // 'idle' (no match) | 'buy' | 'live' | 'over'
let roundTimer = ROUND_TIME; // counts down during 'live'
let buyTimer   = BUY_TIME;   // counts down during 'buy'
let roundNum   = 0;
let endTimer   = 0, endMsg = '', endColor = '#fff';
let hasDefuseKit = false;

// ── Server-driven round flow (Phase 6A) ──────────────────────────────────────
// When connected to an authoritative server, IT owns phase/timer/score/restart; we
// stop ticking our own state machine and just display `gstate` (see applyServerRound).
// Solo (no server) keeps the local logic below unchanged.
let _netDriven = false;
let scoreT = 0, scoreCT = 0;   // team score (server-authoritative in MP; 0 solo)
let mpRoster = [];             // connected players for scoreboard/kill feed (from gstate.roster, 6E)
let mpHlWeapons = false;       // server allows non-canon HL weapons (RPG/crossbow) — from gstate.hlWeapons
let scoreboardOpen = false;    // Tab held → show the scoreboard
const _killFeed = [];          // recent kills: { byTeam, byMe, vicTeam, vicMe, w, until }
let serverMap = null;          // map name the server reports

// Bomb state. `bomb` is null until planted; `carrying` is the un-planted C4 (T only).
let carryingC4 = false;
let plantProg  = 0;          // plant hold progress (s)
let bomb = null;             // { pos:[gs], site, timer, beepT, beepIv, defuse, mesh, blinkMesh }

// Called by game.js _chooseClass once the player picks a team/class.
function startMatch() {
  roundNum = 0;
  hasDefuseKit = false;
  _clearBomb();
  startRound(true);                                    // _chooseClass already spawned the player
}

function startRound(skipRespawn) {
  roundNum++;
  roundPhase = 'buy';
  buyTimer   = BUY_TIME;
  roundTimer = ROUND_TIME;
  _localRoundReset(skipRespawn);
}

// The LOCAL side effects of a new round (respawn, ammo refill, HP reset). Split out so
// the server-driven path can trigger them on a round bump without re-running the local
// state machine. HP/spawn stay client-side until 6B.
function _localRoundReset(skipRespawn) {
  plantProg = 0;
  _clearBomb();
  if (typeof clearProjectiles === 'function') clearProjectiles();   // wipe rockets/bolts/laser
  if (!skipRespawn && typeof respawn === 'function') respawn();   // reset to a team spawn
  // Refill ammo of owned guns (CS tops you up each round); weapons persist.
  if (typeof WPNS !== 'undefined')
    WPNS.forEach(w => { if (w.type === 'gun' && ownedWeapons.has(w.id)) { w.ammo = w.maxAmmo; w.reserve = w._reserve0 ?? w.reserve; } });
  // Reset the practice dummies for the new round.
  if (typeof enemies !== 'undefined') enemies.forEach(e => { if (typeof _enemyRespawn === 'function') _enemyRespawn(e); });
  // Refill HP (armor/helmet persist) and clear the dead state.
  if (typeof resetPlayerHealth === 'function') resetPlayerHealth();
  // The T player carries the C4.
  carryingC4 = (playerTeam === 't');
  _banner('');
}

// ── Server-driven round state (Phase 6A) ─────────────────────────────────────
// Called by net.js on every `gstate`. The server owns phase/timer/score/restart; we
// display them and run the LOCAL body reset when the round number bumps.
function applyServerRound(m) {
  _netDriven = true;
  serverMap = m.map;
  scoreT = m.scoreT | 0; scoreCT = m.scoreCT | 0;
  mpRoster = m.roster || [];
  mpHlWeapons = !!m.hlWeapons;
  const prevRound = roundNum;
  roundPhase = (m.phase === 'warmup') ? 'idle' : m.phase;   // 'buy' | 'live' | 'over'
  roundNum   = m.round | 0;
  if (m.phase === 'buy')        buyTimer = m.timer;
  else if (m.phase === 'live')  roundTimer = m.timer;
  else if (m.phase === 'over') { endTimer = m.timer; endMsg = m.reason || ''; endColor = (m.winner === 't') ? '#e8a33d' : '#78a8f0'; }
  // New round (buy phase) → reset our body once we've actually joined a team. Only on a
  // genuine round-number change (joining a fresh round 1 we already spawned in _chooseClass).
  if (hasJoined && m.phase === 'buy' && m.round > 0 && m.round !== prevRound) {
    _localRoundReset(false);
  }
  _syncDrivenBomb(m.bomb, m.bombResult);   // server-authoritative C4 (6D): build/clear mesh + cues
  _syncDroppedC4(m.dropC4);                // loose C4 on the ground (carrier died/left)
  // HUD is drawn by the in-game loop (updateRound → _updateRoundDriven); don't draw it
  // here, or it would appear over the start menu on a status-only connection.
}

// Reconcile the local bomb visuals with the server's bomb state (driven mode). Builds the mesh
// + plays the plant cue when it appears, updates the fuse/defuse, and plays the right cue
// (defused vs exploded, from the round winner) + explosion when it disappears.
function _syncDrivenBomb(sb, result) {
  if (sb) {
    if (!bomb) {
      bomb = { pos: sb.pos.slice(), site: sb.site, timer: sb.timer, defuse: sb.defuseProg || 0,
               live: true, mesh: null, blink: null, _beepT: 0, _defuseNeed: sb.defuseNeed || DEFUSE_TIME };
      _buildBombMesh();
      if (typeof playSound === 'function') playSound('weapons/c4_plant.wav', { volume: 0.9 });
    } else {
      bomb.timer = sb.timer; bomb.site = sb.site;
      bomb.defuse = sb.defuseProg || 0; bomb._defuseNeed = sb.defuseNeed || bomb._defuseNeed;
    }
  } else if (bomb) {
    const pos = bomb.pos.slice();
    if (result === 'explode') {
      if (typeof playSound === 'function') playSound('weapons/c4_explode1.wav', { volume: 1.0 });
      if (typeof _spawnHEExplosion === 'function') { _spawnHEExplosion(pos); _spawnHEExplosion([pos[0], pos[1], pos[2] + 40]); }
    } else if (result === 'defuse') {
      if (typeof playSound === 'function') playSound('weapons/c4_disarmed.wav', { volume: 0.9 });
    }
    _clearBomb();   // any other reason (elimination with bomb live) → silent clear
  }
}

// Dropped C4 on the ground (carrier died/left) — a small box + orange marker LED so a T can
// find and walk over it (pickup is automatic, server-side). Built/cleared from gstate.dropC4.
// Real C4 world model (models/w_c4.json, converted from w_c4.mdl) — replaces the placeholder box
// for both the dropped and the planted bomb. Built from cached data (one fetch), reusing the
// grenade world-mesh builder; GoldSrc Z-up → Three Y-up via rotation.x = -90° so it lies flat.
let _c4Data = null;
function _buildC4Into(container) {
  const make = d => {
    if (!container || typeof _buildWorldMesh !== 'function') return;
    const g = _buildWorldMesh(d);
    g.rotation.x = -Math.PI / 2;
    g.traverse(o => { o.userData.noHitscan = true; });
    container.add(g);
  };
  if (_c4Data) { make(_c4Data); return; }
  if (typeof fetch === 'undefined') return;
  fetch('models/w_c4.json').then(r => r.json()).then(d => { _c4Data = d; make(d); }).catch(() => {});
}
function _disposeObj(obj) { obj.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }

let _dropC4Mesh = null;
function _syncDroppedC4(pos) {
  if (pos) {
    if (!_dropC4Mesh && typeof scene !== 'undefined') {
      const m = new THREE.Group();
      m.userData.noHitscan = true; scene.add(m);
      _buildC4Into(m);
      m._led = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffaa33, toneMapped: false, fog: false }));
      m._led.userData.noHitscan = true; scene.add(m._led);
      _dropC4Mesh = m;
    }
    if (_dropC4Mesh) {
      _dropC4Mesh.position.set(pos[0], pos[2] + 3, -pos[1]);          // gs → three
      _dropC4Mesh._led.position.set(pos[0], pos[2] + 8, -pos[1]);
    }
  } else if (_dropC4Mesh) {
    scene.remove(_dropC4Mesh); _disposeObj(_dropC4Mesh);
    scene.remove(_dropC4Mesh._led); _dropC4Mesh._led.geometry.dispose();
    _dropC4Mesh = null;
  }
}

// ── Kill feed + scoreboard (Phase 6E) ───────────────────────────────────────
function _rosterTeam(id) { const r = mpRoster.find(p => p.id === id); return r ? r.team : null; }
// Special-case the non-weapon causes; real weapons get their proper label from WPNS below.
const _KF_WEAPON = { c4: '💣 C4', fall: 'падение', knife: 'нож' };
function _weaponLabel(w) {
  if (_KF_WEAPON[w]) return _KF_WEAPON[w];
  if (typeof WPNS !== 'undefined') { const o = WPNS.find(x => x.id === w); if (o && o.label) return o.label; }
  return w ? String(w).toUpperCase() : '☠';
}

// Original CS death-notice sprite icons (tools/extract_kill_icons.py → sprites/kill/d_*.png).
// Weapon id → icon name (most map 1:1; a few differ); causes with no gun fall back to text.
const _KF_ICON_MAP = { m4: 'm4a1', mp5: 'mp5navy', hegrenade: 'grenade', smokegrenade: 'grenade', c4: 'skull', fall: 'skull' };
// Icon pixel widths (all 16px tall) from extract_kill_icons.py — needed to size the masked span.
const _KF_ICON_W = { knife: 48, ak47: 48, awp: 48, deagle: 32, famas: 48, fiveseven: 32, flashbang: 48,
  g3sg1: 48, galil: 48, glock18: 32, grenade: 32, m249: 48, m3: 48, m4a1: 48, mp5navy: 32, p228: 32,
  p90: 48, scout: 48, sg550: 48, sg552: 48, ump45: 48, usp: 32, tmp: 32, xm1014: 48, skull: 32,
  tracktrain: 32, aug: 44, mac10: 34, elite: 57, headshot: 36 };
const _KF_ICONS = new Set(Object.keys(_KF_ICON_W));
// Team tint = the original CS death-notice colours (HLSDK GetClientColor): T = g_ColorRed
// {255,64,64}, CT = g_ColorBlue {153,204,255}; neutral grey for world/fall/C4.
function _killTint(team) { return team === 't' ? '#ff4040' : team === 'ct' ? '#99ccff' : '#d8d8d8'; }
// A white death-notice sprite recoloured to `col` via CSS mask (so any team colour works).
function _killIconSpan(name, col, w, extraCls, title) {
  const wpx = _KF_ICON_W[name] || 40;
  return `<span class="kf-icon${extraCls ? ' ' + extraCls : ''}" title="${title || ''}" ` +
    `style="width:${wpx}px;background-color:${col};` +
    `-webkit-mask-image:url(sprites/kill/d_${name}.png);mask-image:url(sprites/kill/d_${name}.png)"></span>`;
}
function _killWeaponHtml(w, team) {
  const name = _KF_ICON_MAP[w] || w;
  if (name && _KF_ICONS.has(name)) return _killIconSpan(name, _killTint(team), w, null, _weaponLabel(w));
  return `<span class="kf-w">${_weaponLabel(w)}</span>`;        // e.g. 'падение' if no icon
}

// Push a kill onto the feed (called from net.js _onDamage on a death). by=0 → world/fall (no killer).
// hg = victim hitgroup (1 = head) so the feed can flag headshots like the original.
function pushKillFeed(byId, vicId, w, hg) {
  _killFeed.push({ byId: byId || 0, byTeam: byId ? _rosterTeam(byId) : null,
                   vicId, vicTeam: _rosterTeam(vicId), w, hs: (hg | 0) === 1,
                   until: performance.now() + 5000 });
  while (_killFeed.length > 6) _killFeed.shift();
}

function _renderKillFeed() {
  const el = document.getElementById('killfeed');
  if (!el) return;
  const now = performance.now();
  while (_killFeed.length && _killFeed[0].until < now) _killFeed.shift();
  const my = (typeof netMyId === 'function') ? netMyId() : null;
  // Names tinted by team in the original colours (same as the icon tint).
  const nameSpan = (id, tm) => `<span style="color:${_killTint(tm)};font-weight:700">${id === my ? 'Вы' : `${(tm || '').toUpperCase()}#${id}`}</span>`;
  // Headshot marker like the original (the d_headshot sprite, red, next to the weapon icon).
  const hsMark = k => k.hs ? _killIconSpan('headshot', '#ff4040', null, 'kf-hs', 'в голову') : '';
  el.innerHTML = _killFeed.map(k => k.byId
    ? `<div class="kf">${nameSpan(k.byId, k.byTeam)}${_killWeaponHtml(k.w, k.byTeam)}${hsMark(k)}${nameSpan(k.vicId, k.vicTeam)}</div>`
    : `<div class="kf">${_killWeaponHtml(k.w, null)} ${nameSpan(k.vicId, k.vicTeam)}</div>`
  ).join('');
}

function _renderScoreboard() {
  const el = document.getElementById('scoreboard');
  if (!el) return;
  if (!scoreboardOpen || !_netDriven) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
  const my = (typeof netMyId === 'function') ? netMyId() : null;
  const sort = a => a.slice().sort((x, y) => y.kills - x.kills || x.deaths - y.deaths);
  const name = r => r.id === my ? 'Вы' : ((r.team || '').toUpperCase() + '#' + r.id);
  const rows = list => sort(list).map(r =>
    `<div class="sb-row ${r.id === my ? 'me' : ''} ${r.alive ? '' : 'dead'}">` +
    `<span>${name(r)}${r.alive ? '' : ' ☠'}</span>` +
    `<span class="sb-kd">${r.kills} / ${r.deaths}</span>` +
    `<span class="sb-ping">${r.ping || 0} мс</span></div>`).join('');
  const ct = mpRoster.filter(r => r.team === 'ct' && !r.spec);
  const t  = mpRoster.filter(r => r.team === 't'  && !r.spec);
  const spec = mpRoster.filter(r => r.spec);
  const specRows = spec.map(r =>
    `<div class="sb-row ${r.id === my ? 'me' : ''}"><span>${r.id === my ? 'Вы' : ('SPEC#' + r.id)}</span>` +
    `<span class="sb-kd"></span><span class="sb-ping">${r.ping || 0} мс</span></div>`).join('');
  el.innerHTML =
    `<div class="sb-head"><span class="sb-title">${serverMap || 'de_dust2'} · Раунд ${roundNum}</span>` +
    `<span class="sb-score"><b class="t">T ${scoreT}</b> : <b class="ct">${scoreCT} CT</b></span></div>` +
    `<div class="sb-team"><span class="sb-team-h ct">Контр-террористы (${ct.length})</span>${rows(ct)}</div>` +
    `<div class="sb-team"><span class="sb-team-h t">Террористы (${t.length})</span>${rows(t)}</div>` +
    (spec.length ? `<div class="sb-team"><span class="sb-team-h">Наблюдатели (${spec.length})</span>${specRows}</div>` : '');
  el.style.display = 'block';
}

// Server connection lost → resume a local (solo) match so play continues.
function onNetRoundReset() {
  if (!_netDriven) return;
  _netDriven = false;
  if (hasJoined && typeof startMatch === 'function') startMatch();
}

function endRound(winner, msg) {
  if (roundPhase === 'over') return;
  roundPhase = 'over';
  endTimer = ROUND_END;
  endMsg = msg;
  endColor = winner === 't' ? '#e8a33d' : '#78a8f0';
  const won = (winner === playerTeam);
  if (typeof playerMoney !== 'undefined') {
    playerMoney = Math.min(16000, playerMoney + (won ? WIN_REWARD : LOSS_REWARD));
  }
  carryingC4 = false; plantProg = 0;
  if (bomb) { bomb.defuse = 0; bomb.live = false; }   // keep the model visible on the banner, stop ticking
}

// ── Bomb plant / defuse / detonate ──────────────────────────────────────────
function _inBombSite() {
  if (!gsPos || typeof bombSites === 'undefined') return null;
  for (const s of bombSites) {
    if (gsPos[0] >= s.min[0] && gsPos[0] <= s.max[0] &&
        gsPos[1] >= s.min[1] && gsPos[1] <= s.max[1] &&
        gsPos[2] >= s.min[2] - 64 && gsPos[2] <= s.max[2] + 64) return s;
  }
  return null;
}

function _plantBomb(site) {
  const footZ = gsPos[2] - (phyDucked ? 18 : 36);   // origin (centre) → feet, so the bomb rests on the floor
  bomb = { pos: [gsPos[0], gsPos[1], footZ], site: site.site, timer: C4_TIME,
           beepT: 0, defuse: 0, live: true, mesh: null };
  carryingC4 = false;
  _buildBombMesh();
  if (typeof playSound === 'function') playSound('weapons/c4_plant.wav', { volume: 0.9 });
  if (typeof playerMoney !== 'undefined') playerMoney = Math.min(16000, playerMoney + PLANT_REWARD);
  _banner(`Бомба заложена на точке ${bomb.site.toUpperCase()}`, '#e8a33d', 1.6);
}

function _buildBombMesh() {
  if (!bomb || typeof scene === 'undefined') return;
  bomb.mesh = new THREE.Group();
  bomb.mesh.userData.noHitscan = true;
  bomb.mesh.position.set(bomb.pos[0], bomb.pos[2] + 3, -bomb.pos[1]);   // gs → three
  scene.add(bomb.mesh);
  _buildC4Into(bomb.mesh);                                              // real C4 model
  // A small blinking light on top (the C4's red LED).
  const lg = new THREE.SphereGeometry(1.6, 8, 8);
  const lm = new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false, fog: false });
  bomb.blink = new THREE.Mesh(lg, lm);
  bomb.blink.userData.noHitscan = true;
  bomb.blink.position.set(bomb.pos[0], bomb.pos[2] + 8, -bomb.pos[1]);
  scene.add(bomb.blink);
}

function _clearBomb() {
  if (bomb) {
    if (bomb.mesh)  { scene.remove(bomb.mesh);  _disposeObj(bomb.mesh); }
    if (bomb.blink) { scene.remove(bomb.blink); bomb.blink.geometry.dispose(); }
  }
  bomb = null;
}

function _detonateBomb() {
  if (!bomb) return;
  const pos = bomb.pos;
  if (typeof playSound === 'function') playSound('weapons/c4_explode1.wav', { volume: 1.0 });
  if (typeof _spawnHEExplosion === 'function') { _spawnHEExplosion(pos); _spawnHEExplosion([pos[0], pos[1], pos[2] + 40]); }
  if (typeof enemyRadiusDamage === 'function')  enemyRadiusDamage(pos, C4_DAMAGE, C4_RADIUS);
  if (typeof playerRadiusDamage === 'function') playerRadiusDamage(pos, C4_DAMAGE, C4_RADIUS);
  _clearBomb();
  endRound('t', 'Бомба взорвана — победа Террористов');
}

// ── Per-frame update (called from the main loop) ────────────────────────────
function updateRound(dt) {
  if (_netDriven) { _updateRoundDriven(dt); return; }
  if (roundPhase === 'idle') return;

  if (roundPhase === 'over') {
    endTimer -= dt;
    if (bomb && bomb.blink) bomb.blink.visible = !bomb.blink.visible;   // keep blinking on the banner
    if (endTimer <= 0) startRound();
    _updateRoundHUD();
    return;
  }

  if (roundPhase === 'buy') {
    buyTimer -= dt;
    if (buyTimer <= 0) roundPhase = 'live';
    _updateRoundHUD();
    return;
  }

  // live
  if (bomb && bomb.live) {
    _updatePlantedBomb(dt);
  } else {
    _updatePlanting(dt);
    roundTimer -= dt;
    if (roundTimer <= 0) endRound('ct', 'Время вышло — победа Контр-террористов');
  }
  _updateRoundHUD();
}

// Server-driven per-frame: the server owns phase/timer/score; we only tick the displayed
// timer locally between `gstate` (re-synced on arrival) and draw the HUD. Bomb/plant are
// disabled in MP until they move server-side (6D).
function _updateRoundDriven(dt) {
  if (roundPhase === 'buy')        buyTimer   = Math.max(0, buyTimer - dt);
  else if (roundPhase === 'live')  roundTimer = Math.max(0, roundTimer - dt);
  else if (roundPhase === 'over')  endTimer   = Math.max(0, endTimer - dt);
  // Server-driven bomb: smooth-tick the fuse between gstates + accelerating beep / LED blink.
  if (bomb && bomb.live) {
    bomb.timer = Math.max(0, bomb.timer - dt);
    bomb._beepT = (bomb._beepT || 0) - dt;
    if (bomb._beepT <= 0) {
      const frac = Math.max(0, bomb.timer / C4_TIME);
      bomb._beepT = 0.18 + frac * 1.2;                     // faster near the end
      if (typeof playRandom === 'function')
        playRandom(['weapons/c4_beep1.wav', 'weapons/c4_beep2.wav', 'weapons/c4_beep3.wav',
                    'weapons/c4_beep4.wav', 'weapons/c4_beep5.wav'], { volume: 0.5 });
      if (bomb.blink) bomb.blink.visible = !bomb.blink.visible;
    }
  }
  _updateRoundHUD();
}

// True while we're actively planting or defusing (holding E in position) — drives the auto-crouch
// (CS kneel) in physics.js. Works in solo and MP (carryingC4/plantProg come from gstate.me, bomb
// from gstate in driven mode).
function bombActionActive() {
  if (typeof keys === 'undefined' || !keys['KeyE'] || typeof onGround === 'undefined' || !onGround) return false;
  if (carryingC4 && typeof playerTeam !== 'undefined' && playerTeam === 't' &&
      typeof _inBombSite === 'function' && _inBombSite()) return true;
  if (bomb && bomb.live && typeof playerTeam !== 'undefined' && playerTeam === 'ct' && typeof gsPos !== 'undefined' && gsPos &&
      Math.hypot(gsPos[0] - bomb.pos[0], gsPos[1] - bomb.pos[1]) < 64 && Math.abs(gsPos[2] - bomb.pos[2]) < 80) return true;
  return false;
}

// T holds E inside a bomb site (on the ground) to plant.
function _updatePlanting(dt) {
  const held = typeof keys !== 'undefined' && keys['KeyE'];
  const site = _inBombSite();
  if (carryingC4 && playerTeam === 't' && site && onGround && held) {
    if (plantProg === 0 && typeof playSound === 'function') playSound('weapons/c4_click.wav', { volume: 0.7 });
    plantProg += dt;
    if (plantProg >= PLANT_TIME) { plantProg = 0; _plantBomb(site); }
  } else {
    plantProg = 0;
  }
}

function _updatePlantedBomb(dt) {
  bomb.timer -= dt;
  // Accelerating beeps + LED blink as the fuse runs down.
  bomb.beepT -= dt;
  if (bomb.beepT <= 0) {
    const frac = Math.max(0, bomb.timer / C4_TIME);
    bomb.beepT = 0.18 + frac * 1.2;                       // faster near the end
    if (typeof playRandom === 'function')
      playRandom(['weapons/c4_beep1.wav', 'weapons/c4_beep2.wav', 'weapons/c4_beep3.wav',
                  'weapons/c4_beep4.wav', 'weapons/c4_beep5.wav'], { volume: 0.5 });
    if (bomb.blink) bomb.blink.visible = !bomb.blink.visible;
  }
  // CT defuses by holding E next to the bomb on the ground.
  const held = typeof keys !== 'undefined' && keys['KeyE'];
  const near = gsPos && Math.hypot(gsPos[0] - bomb.pos[0], gsPos[1] - bomb.pos[1]) < 64 &&
               Math.abs((gsPos[2]) - bomb.pos[2]) < 80;
  if (playerTeam === 'ct' && near && onGround && held) {
    if (bomb.defuse === 0 && typeof playSound === 'function') playSound('weapons/c4_disarm.wav', { volume: 0.7 });
    bomb.defuse += dt;
    const need = hasDefuseKit ? DEFUSE_KIT : DEFUSE_TIME;
    if (bomb.defuse >= need) {
      if (typeof playSound === 'function') playSound('weapons/c4_disarmed.wav', { volume: 0.9 });
      _clearBomb();
      endRound('ct', 'Бомба обезврежена — победа Контр-террористов');
      return;
    }
  } else {
    bomb.defuse = 0;
  }
  if (bomb.timer <= 0) _detonateBomb();
}

// ── HUD ──────────────────────────────────────────────────────────────────────
function _banner(text, color, secs) {
  const el = document.getElementById('round-banner');
  if (!el) return;
  if (!text) { el.style.display = 'none'; el._until = 0; return; }
  el.textContent = text; el.style.color = color || '#fff'; el.style.display = 'block';
  el._until = performance.now() + (secs || 0) * 1000;   // 0 = sticky (used for round end)
}

function _fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function buyTimeOpen() { return roundPhase === 'buy'; }

function _updateRoundHUD() {
  const hud = document.getElementById('round-hud');
  if (hud) {
    let cls = 'rh-time', t, sub;
    if (roundPhase === 'over')      { t = '—'; sub = `Раунд ${roundNum}`; }
    else if (bomb && bomb.live)     { cls += ' bomb'; t = _fmtTime(bomb.timer); sub = `Бомба на ${bomb.site.toUpperCase()}`; }
    else if (roundPhase === 'buy')  { cls += ' buy';  t = _fmtTime(buyTimer); sub = 'Время закупки (B)'; }
    else                            { t = _fmtTime(roundTimer); sub = `Раунд ${roundNum}`; }
    const score = _netDriven ? `<div class="rh-score">T ${scoreT} : ${scoreCT} CT</div>` : '';
    hud.innerHTML = score + `<div class="${cls}">${t}</div><div class="rh-sub">${sub}</div>`;
    hud.style.display = 'block';
  }

  // Round-end banner (sticky during 'over').
  const ban = document.getElementById('round-banner');
  if (ban) {
    if (roundPhase === 'over') { ban.textContent = endMsg; ban.style.color = endColor; ban.style.display = 'block'; }
    else if (ban._until && performance.now() > ban._until) ban.style.display = 'none';
  }

  // Plant / defuse progress bar. Works in both solo and MP (6D): in driven mode plantProg /
  // carryingC4 come from gstate.me and bomb.defuse from gstate.bomb.
  const ba = document.getElementById('bomb-action');
  if (ba) {
    let label = '', frac = 0;
    const defNeed = (bomb && bomb._defuseNeed) || (hasDefuseKit ? DEFUSE_KIT : DEFUSE_TIME);
    if (plantProg > 0)              { label = 'Закладка бомбы…';   frac = plantProg / PLANT_TIME; }
    else if (bomb && bomb.defuse > 0) { label = 'Разминирование…'; frac = bomb.defuse / defNeed; }
    else if (roundPhase === 'live' && carryingC4 && _inBombSite()) { label = 'Удерживайте E — заложить бомбу'; frac = 0; }
    else if (bomb && bomb.live && playerTeam === 'ct') {
      const near = gsPos && Math.hypot(gsPos[0] - bomb.pos[0], gsPos[1] - bomb.pos[1]) < 64;
      if (near) { label = 'Удерживайте E — разминировать'; frac = 0; }
    }
    if (label) {
      ba.innerHTML = `<div class="ba-label">${label}</div><div class="ba-bar"><div class="ba-fill" style="width:${Math.round(frac * 100)}%"></div></div>`;
      ba.style.display = 'block';
    } else ba.style.display = 'none';
  }

  _renderKillFeed();      // MP kill feed (top-right) — empty/no-op in solo
  _renderScoreboard();    // MP scoreboard (Tab) — hidden in solo / when not held
}
