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
  plantProg  = 0;
  _clearBomb();
  if (!skipRespawn && typeof respawn === 'function') respawn();   // reset to a team spawn
  // Refill ammo of owned guns (CS tops you up each round); weapons persist.
  if (typeof WPNS !== 'undefined')
    WPNS.forEach(w => { if (w.type === 'gun' && ownedWeapons.has(w.id)) { w.ammo = w.maxAmmo; w.reserve = w._reserve0 ?? w.reserve; } });
  // Reset the practice dummies for the new round.
  if (typeof enemies !== 'undefined') enemies.forEach(e => { if (typeof _enemyRespawn === 'function') _enemyRespawn(e); });
  // The T player carries the C4.
  carryingC4 = (playerTeam === 't');
  _banner('');
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
  bomb = { pos: [gsPos[0], gsPos[1], gsPos[2]], site: site.site, timer: C4_TIME,
           beepT: 0, defuse: 0, live: true, mesh: null };
  carryingC4 = false;
  _buildBombMesh();
  if (typeof playSound === 'function') playSound('weapons/c4_plant.wav', { volume: 0.9 });
  if (typeof playerMoney !== 'undefined') playerMoney = Math.min(16000, playerMoney + PLANT_REWARD);
  _banner(`Бомба заложена на точке ${bomb.site.toUpperCase()}`, '#e8a33d', 1.6);
}

function _buildBombMesh() {
  if (!bomb || typeof scene === 'undefined') return;
  const g = new THREE.BoxGeometry(9, 6, 13);
  const m = new THREE.MeshBasicMaterial({ color: 0x222222, toneMapped: false, fog: false });
  bomb.mesh = new THREE.Mesh(g, m);
  bomb.mesh.userData.noHitscan = true;
  bomb.mesh.position.set(bomb.pos[0], bomb.pos[2] + 3, -bomb.pos[1]);   // gs → three
  scene.add(bomb.mesh);
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
    if (bomb.mesh)  { scene.remove(bomb.mesh);  bomb.mesh.geometry.dispose(); }
    if (bomb.blink) { scene.remove(bomb.blink); bomb.blink.geometry.dispose(); }
  }
  bomb = null;
}

function _detonateBomb() {
  if (!bomb) return;
  const pos = bomb.pos;
  if (typeof playSound === 'function') playSound('weapons/c4_explode1.wav', { volume: 1.0 });
  if (typeof _spawnHEExplosion === 'function') { _spawnHEExplosion(pos); _spawnHEExplosion([pos[0], pos[1], pos[2] + 40]); }
  if (typeof enemyRadiusDamage === 'function') enemyRadiusDamage(pos, C4_DAMAGE, C4_RADIUS);
  _clearBomb();
  endRound('t', 'Бомба взорвана — победа Террористов');
}

// ── Per-frame update (called from the main loop) ────────────────────────────
function updateRound(dt) {
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
    hud.innerHTML = `<div class="${cls}">${t}</div><div class="rh-sub">${sub}</div>`;
    hud.style.display = 'block';
  }

  // Round-end banner (sticky during 'over').
  const ban = document.getElementById('round-banner');
  if (ban) {
    if (roundPhase === 'over') { ban.textContent = endMsg; ban.style.color = endColor; ban.style.display = 'block'; }
    else if (ban._until && performance.now() > ban._until) ban.style.display = 'none';
  }

  // Plant / defuse progress bar.
  const ba = document.getElementById('bomb-action');
  if (ba) {
    let label = '', frac = 0;
    if (plantProg > 0)              { label = 'Закладка бомбы…';   frac = plantProg / PLANT_TIME; }
    else if (bomb && bomb.defuse > 0) { label = 'Разминирование…'; frac = bomb.defuse / (hasDefuseKit ? DEFUSE_KIT : DEFUSE_TIME); }
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
}
