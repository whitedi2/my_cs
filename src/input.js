// input.js — pointer lock, settings, mouse/keyboard/weapon input, render loop.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── Pointer Lock ──────────────────────────────────────────────────────────
let isLocked = false, hasStarted = false;
const $overlay    = document.getElementById('overlay');
const $btnPlay    = document.getElementById('btn-play');
const $btnRestart = document.getElementById('btn-restart');
let gameLoading = false, gameLoadStart = 0;
const $gameload = document.getElementById('gameload');
const $glFill = document.getElementById('gl-fill');
const $glPct  = document.getElementById('gl-pct');

function _startGame() {
  if (!mapReady) return;          // map still streaming
  if (typeof initAudio === 'function') initAudio();   // unlock WebAudio on the click gesture
  if (typeof warmAllWeaponSounds === 'function') warmAllWeaponSounds();  // decode gunfire up front
  loadWeaponModels();             // other assets load lazily on first Start
  loadEnemy();                    // player model loads after team/class is chosen
  // Lock now (needs the click gesture); cover the still-loading models with a
  // progress screen and reveal the game only once everything is ready.
  if (!gameAssetsReady()) { gameLoading = true; gameLoadStart = performance.now(); $gameload.style.display = 'flex'; }
  // Optional fullscreen (settings) — lets the Keyboard Lock API capture reserved Ctrl
  // combos (Ctrl+W/Ctrl+digit) so crouch-walking can't close/switch the Chrome tab.
  if (fullscreenMode) {
    try {
      const el = document.documentElement;
      if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
    } catch (e) { /* ignore */ }
  }
  renderer.domElement.requestPointerLock();
}

// Capture the game's reserved-combo keys (NOT Escape — keep single-press pause) so
// Chrome doesn't act on Ctrl+W / Ctrl+digit / Ctrl+T while playing. Requires fullscreen.
const _LOCK_KEYS = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyG', 'KeyV', 'KeyQ', 'KeyB', 'KeyE',
  'KeyT', 'KeyN', 'KeyP', 'KeyJ', 'KeyL', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
];
function _kbLock() {
  try {
    if (navigator.keyboard && navigator.keyboard.lock && document.fullscreenElement)
      navigator.keyboard.lock(_LOCK_KEYS).catch(() => {});
  } catch (e) { /* unsupported */ }
}
function _kbUnlock() {
  try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch (e) { /* unsupported */ }
}
// Fullscreen may engage just after the click — lock the keyboard once it does (if playing).
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement && isLocked) _kbLock(); });
$btnPlay.addEventListener('click', _startGame);
$btnRestart.addEventListener('click', () => { if (typeof respawn === 'function') respawn(); _startGame(); });

// ── Menu map preview: drag to rotate (auto-rotates otherwise) ───────────────
let _menuDragging = false, _menuLastX = 0, _menuLastY = 0;
$overlay.addEventListener('mousedown', e => {
  if (isLocked || !mapReady) return;
  if (e.target.closest('#showcase-ctrl')) return;        // scene switch arrows
  if (typeof showcaseInMap === 'function' && !showcaseInMap()) return;   // duel phase: no drag
  if (e.target.closest('#menu')) return;                 // not over the card
  if (e.clientX < innerWidth * MENU_LEFT_FRAC) return;   // only over the map area
  _menuDragging = true; _menuLastX = e.clientX; _menuLastY = e.clientY;
});
window.addEventListener('mousemove', e => {
  if (!_menuDragging) return;
  menuAzimuth -= (e.clientX - _menuLastX) * 0.006;
  menuElev = Math.max(0.25, Math.min(1.45, menuElev - (e.clientY - _menuLastY) * 0.006));
  _menuLastX = e.clientX; _menuLastY = e.clientY;
});
window.addEventListener('mouseup', () => { _menuDragging = false; });

// Grab/hand cursor only over the rotating map region (right side, not the card).
$overlay.addEventListener('mousemove', e => {
  if (isLocked) return;
  const inMap = (typeof showcaseInMap !== 'function') || showcaseInMap();
  const overMap = inMap && mapReady && !e.target.closest('#menu') && e.clientX >= innerWidth * MENU_LEFT_FRAC;
  $overlay.style.cursor = _menuDragging ? 'grabbing' : (overMap ? 'grab' : 'default');
});

// Render the rotating map into the right-hand region; dark fill elsewhere.
function _renderMenuBackdrop(dt) {
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.setClearColor(0x0a0c10, 1);
  renderer.clear(true, true, true);
  if (!mapReady) return;
  // Showcase decides the scene: a slow-mo duel (its own camera) or the rotating map.
  const show = (typeof showcaseTick === 'function') ? showcaseTick(dt) : null;
  let cam;
  if (show && show.camera) {
    cam = show.camera;
  } else {
    if (!_menuDragging) menuAzimuth += dt * 0.12;   // slow auto-rotate
    frameMenuCamera();
    cam = menuCamera;
  }
  const reg = _menuRegion();
  renderer.setScissorTest(true);
  renderer.setViewport(reg.x, reg.y, reg.w, reg.h);
  renderer.setScissor(reg.x, reg.y, reg.w, reg.h);
  renderer.clear(true, true, true);
  const savedFog = scene.fog, savedBg = scene.background;
  scene.fog = null; scene.background = null;       // dark backdrop, only the map/duel shows
  renderer.render(scene, cam);
  scene.fog = savedFog; scene.background = savedBg;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
}
let mouseIgnore = 0;   // events to skip after pointer lock (avoid initial large delta)
document.addEventListener('pointerlockchange', () => {
  isLocked = document.pointerLockElement === renderer.domElement;
  if (isLocked) {
    mouseIgnore = 5; hasStarted = true;
    if (typeof showcaseStop === 'function') showcaseStop();   // drop the menu duel models
    _kbLock();                       // grab reserved browser combos while playing
    // First time in: choose team & class (old-style menu) before playing.
    if (typeof hasJoined !== 'undefined' && !hasJoined) openTeamMenu();
  } else {
    _kbUnlock();
    // Menu shown (first time or paused): primary button label + restart visibility.
    if (hasStarted) $btnPlay.textContent = 'Продолжить';
    else if (typeof updateMenuChrome === 'function') updateMenuChrome();
    $btnRestart.style.display = hasStarted ? '' : 'none';
    gameLoading = false; $gameload.style.display = 'none';   // ESC during load → back to menu
    if (typeof closeBuyMenu === 'function') closeBuyMenu();
    document.getElementById('teammenu').style.display = 'none';
    if (typeof scoreboardOpen !== 'undefined') scoreboardOpen = false;   // don't leave it stuck over the menu
    const _sb = document.getElementById('scoreboard'); if (_sb) _sb.style.display = 'none';
    const _kf = document.getElementById('killfeed');   if (_kf) _kf.innerHTML = '';
  }
  if (!isLocked && typeof resetScope === 'function') resetScope();   // drop the AWP scope on pause
  $overlay.style.display = isLocked ? 'none' : 'flex';
  document.getElementById('crosshair').style.display  = isLocked ? 'block' : 'none';
  document.getElementById('hud').style.display        = isLocked ? 'block' : 'none';
  document.getElementById('weapon-hud').style.display = isLocked ? 'block' : 'none';
  document.getElementById('money').style.display      = isLocked ? 'block' : 'none';
  if (!isLocked) {                                     // pause: drop the HP HUD + damage overlay
    document.getElementById('player-status').style.display = 'none';
    document.getElementById('hurt-overlay').style.opacity  = '0';
  }
});

// ── Settings ──────────────────────────────────────────────────────────────
let invertY          = CONFIG.invertY;
let widescreenFOV    = CONFIG.widescreenFOV;
let rightHand        = CONFIG.rightHand;
let dynamicCrosshair = CONFIG.dynamicCrosshair ?? false;  // cl_dynamiccrosshair: только расширение от движения
let enhancedGore     = CONFIG.enhancedGore ?? false;      // our procedural blood vs original sprites (off = original)
let showHitboxes     = false;                             // debug: draw dummy hit-zone cylinders
let fullscreenMode   = CONFIG.fullscreenMode ?? false;    // Start → fullscreen (enables Keyboard Lock vs Ctrl combos)
let hlWeaponsEnabled = CONFIG.hlWeapons ?? false;         // non-canon HL weapons (RPG/crossbow) in solo; MP uses the server flag

function updateFOV() {
  // Scoped (AWP): the zoom FOV is the horizontal FOV — derive vertical for the aspect.
  const zf = (typeof scopeFov === 'function') ? scopeFov() : null;
  if (zf != null) {
    camera.fov = 2 * Math.atan(Math.tan((zf * Math.PI / 180) / 2) / (innerWidth / innerHeight)) * (180 / Math.PI);
    camera.updateProjectionMatrix();
    return;
  }
  if (widescreenFOV) {
    // CS 1.6 allow_widescreen: horizontal FOV = 90° at 4:3 → vertical ≈ 73.74°
    // extending horizontally to fill 16:9 (gives ~106° hFOV on 16:9)
    const hFov4x3 = 2 * Math.atan(Math.tan(Math.PI / 4) * (4 / 3));
    camera.fov = 2 * Math.atan(Math.tan(hFov4x3 / 2) / (innerWidth / innerHeight)) * (180 / Math.PI);
  } else {
    // CS 1.6 4:3 emulation: lock horizontal FOV = 90°, derive vertical for current aspect
    // On 16:9 this gives ~58.7° vertical (more zoomed in than widescreen)
    camera.fov = 2 * Math.atan(Math.tan(Math.PI / 4) / (innerWidth / innerHeight)) * (180 / Math.PI);
  }
  camera.updateProjectionMatrix();
}

// HL viewmodels (rpg/crossbow) are un-modelled at the BACK; when held they render with this LOCKED
// horizontal FOV (a touch closer than the 4:3 look) so a widescreen aspect can't widen the gun and
// expose the rear gap. Applied per-frame in the render loop — every other (CS) gun is unchanged.
const VM_HFOV = 2 * Math.atan(Math.tan(49 * Math.PI / 180 / 2) * (4 / 3)) * 0.9;
function updateVmCamera() {
  vmCamera.aspect = innerWidth / innerHeight;
  vmCamera.updateProjectionMatrix();
}

updateFOV();
updateVmCamera();

document.getElementById('opt-invert-y').addEventListener('change',   e => { invertY       = e.target.checked; });
document.getElementById('opt-widescreen').addEventListener('change', e => { widescreenFOV = e.target.checked; updateFOV(); });
document.getElementById('opt-right-hand').addEventListener('change', e => { rightHand = e.target.checked; updateVmCamera(); });
document.getElementById('opt-dynamic-crosshair').addEventListener('change', e => { dynamicCrosshair = e.target.checked; });
document.getElementById('opt-enhanced-gore').addEventListener('change', e => { enhancedGore = e.target.checked; });
{ const _optHl = document.getElementById('opt-hl-weapons');
  if (_optHl) _optHl.addEventListener('change', e => { hlWeaponsEnabled = e.target.checked; }); }
document.getElementById('opt-show-hitboxes').addEventListener('change', e => { showHitboxes = e.target.checked; if (typeof setHitboxDebug === 'function') setHitboxDebug(showHitboxes); });
document.getElementById('opt-third-person').addEventListener('change', e => { toggleThirdPerson(e.target.checked); });
const _optFs = document.getElementById('opt-fullscreen');
if (_optFs) _optFs.addEventListener('change', e => {
  fullscreenMode = e.target.checked;
  // Toggling off while in fullscreen → leave it; toggling on while playing → enter now.
  if (fullscreenMode && isLocked) { try { document.documentElement.requestFullscreen().catch(() => {}); } catch (e2) {} }
  else if (!fullscreenMode && document.fullscreenElement) { try { document.exitFullscreen().catch(() => {}); } catch (e2) {} }
});
// Null-guarded: if a stale cached viewer.html lacks #opt-volume, a hard throw here
// would abort the rest of input.js (key handlers, render loop) — so guard it.
const _volSlider = document.getElementById('opt-volume');
const _volVal    = document.getElementById('opt-volume-val');
if (_volSlider) _volSlider.addEventListener('input', e => {
  if (typeof setMasterVolume === 'function') setMasterVolume(e.target.value / 100);
  if (_volVal) _volVal.textContent = e.target.value + '%';
});

// ── Start-menu chrome: map name over the preview + Play/Connect label ────────
// Solo (no server) → pick a map from the list; online → server owns the map and
// the list is hidden. Driven by net.js's _setMpStatus via mpOnline/mpServerMap.
let mpOnline = false, mpServerMap = null;       // server presence + its current map
let selectedMapName = 'de_dust2';               // solo map choice
function updateMenuChrome() {
  const maplist = document.getElementById('maplist');
  const mapName = document.getElementById('map-name');
  if (maplist) maplist.style.display = mpOnline ? 'none' : 'flex';
  if (mapName) mapName.textContent = mpOnline ? (mpServerMap || selectedMapName) : selectedMapName;
  // Play button label — only while in the menu, map loaded and not yet started.
  if (mapReady && !hasStarted) $btnPlay.textContent = mpOnline ? 'Подключиться' : 'Начать игру';
}

// Solo map selection (the list is shown only offline).
document.querySelectorAll('#maplist .map-item').forEach(it => it.addEventListener('click', () => {
  if (mpOnline) return;
  document.querySelectorAll('#maplist .map-item').forEach(x => x.classList.remove('selected'));
  it.classList.add('selected');
  selectedMapName = it.dataset.map || it.textContent.trim();
  updateMenuChrome();
}));

// Showcase scene switch arrows (testing): jump between map / void duel / arena duel.
const _scPrev = document.getElementById('sc-prev');
const _scNext = document.getElementById('sc-next');
if (_scPrev) _scPrev.addEventListener('click', e => { e.stopPropagation(); if (typeof showcaseGo === 'function') showcaseGo(-1); });
if (_scNext) _scNext.addEventListener('click', e => { e.stopPropagation(); if (typeof showcaseGo === 'function') showcaseGo(1); });

// Settings tabs (Игра / Видео / Отладка).
document.querySelectorAll('#settings .tab-btn').forEach(btn => btn.addEventListener('click', () => {
  const tab = btn.dataset.tab;
  document.querySelectorAll('#settings .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('#settings .tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
}));

// Mouse sensitivity slider: slider value v → sensitivity = v·0.0001 (shown as v/10).
let sensitivity = CONFIG.sensitivity;   // movementX/Y → radians (declared before the slider uses it)
const _sensSlider = document.getElementById('opt-sens');
const _sensVal    = document.getElementById('opt-sens-val');
if (_sensSlider) {
  _sensSlider.value = Math.round(sensitivity / 0.0001);   // init from CONFIG
  const _applySens = () => {
    sensitivity = _sensSlider.value * 0.0001;
    const shown = (_sensSlider.value / 10).toFixed(2);
    if (_sensVal) _sensVal.textContent = shown;
    _sensSlider.title = shown;            // numeric value on hover over the thumb
  };
  _applySens();
  _sensSlider.addEventListener('input', _applySens);
}

// ── Mouse look ────────────────────────────────────────────────────────────
let yaw = 0, pitch = 0;
let pendingYaw = 0, pendingPitch = 0;
const MAX_DELTA_PER_FRAME = Math.PI / 2;   // max 90° yaw or pitch change per frame

document.addEventListener('mousemove', e => {
  if (!isLocked) return;
  if (mouseIgnore > 0) { mouseIgnore--; return; }
  // Discard spurious huge deltas (Edge pointer-lock bug can emit movementX in thousands)
  if (Math.abs(e.movementX) > 200 || Math.abs(e.movementY) > 200) return;
  // Scoped: scale look speed by the zoom ratio so aiming stays controllable (CS-style).
  const zf = (typeof scopeFov === 'function') ? scopeFov() : null;
  const sm = zf != null ? zf / 90 : 1;
  pendingYaw   -= e.movementX * sensitivity * sm;
  pendingPitch -= e.movementY * sensitivity * sm * (invertY ? -1 : 1);
});

// ── Keyboard ──────────────────────────────────────────────────────────────
const keys = {};
// The single weapon-switch beep (plays on every weapon-key press, as in the original),
// with a small cooldown so holding/mashing slot keys doesn't retrigger it every event.
// No sound when the slot is empty (the engine has no separate "no weapon" beep here).
let _selSoundT = 0;
function _playSwitchSound() {
  const now = performance.now();
  if (now - _selSoundT < 150) return;
  _selSoundT = now;
  if (typeof playSound === 'function') playSound('common/wpn_hudon.wav');
}
// Game keys we own while playing — their browser defaults are suppressed so combos
// like Ctrl+W (duck + forward → close tab) or Ctrl+S don't hijack the page. The
// manual reload shortcut (Ctrl/⌘+R, incl. Ctrl+Shift+R) is deliberately let through.
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyG', 'KeyV', 'KeyQ', 'KeyB', 'KeyE',
  'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'Tab',
]);
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  // ESC on the pause menu = the "Продолжить" button (resume / re-lock the pointer).
  if (e.code === 'Escape' && !isLocked && hasStarted) { _startGame(); return; }
  if (!isLocked) return;
  // Dead or spectating → Space cycles the spectator camera (free 3rd / locked 3rd / 1st person).
  if (((typeof playerDead !== 'undefined' && playerDead) || (typeof spectating !== 'undefined' && spectating)) && e.code === 'Space') {
    if (typeof cycleSpecCam === 'function') cycleSpecCam();
    e.preventDefault(); return;
  }
  if (e.code === 'Tab' && typeof scoreboardOpen !== 'undefined') { scoreboardOpen = true; e.preventDefault(); }   // hold Tab → scoreboard (6E)
  // Stop browser hotkeys (Ctrl+W close, Ctrl+S save, …) while playing — but keep
  // the page-reload shortcut working (the project relies on Ctrl+Shift+R).
  if (GAME_KEYS.has(e.code) && !((e.ctrlKey || e.metaKey) && e.code === 'KeyR')) e.preventDefault();
  // Team/buy menus are numeric (CS-style): route number keys to them, block gameplay.
  if (teamStage || buyOpen) {
    const m = e.code.match(/^(?:Digit|Numpad)(\d)$/);
    if (m) { const n = +m[1]; if (teamStage) teamMenuKey(n); else buyMenuKey(n); e.preventDefault(); return; }
    if (buyOpen && (e.code === 'KeyB' || e.code === 'KeyO')) { closeBuyMenu(); return; }
    if (teamStage) return;                 // nothing else works during team select
  }
  if (e.code === 'KeyB') { openBuyMenu(); return; }
  if (e.code === 'KeyO' && typeof openEquipMenu === 'function') { openEquipMenu(); return; }  // equipment (grenades/armor/kit)
  if (e.code === 'KeyM' && typeof openTeamMenu === 'function') { openTeamMenu(); return; }   // switch team / spectate
  // Quick ammo buy (CS binds): ',' = primary ammo, '.' = secondary ammo.
  if (e.code === 'Comma'  && typeof buyAmmo === 'function') { buyAmmo('primary');   return; }
  if (e.code === 'Period' && typeof buyAmmo === 'function') { buyAmmo('secondary'); return; }
  // Arrow keys orbit the third-person camera — keep them from scrolling the page.
  if (thirdPerson && e.code.startsWith('Arrow')) e.preventDefault();
  // Slot keys pick the OWNED weapon in that slot (1 primary, 2 secondary, 3 knife).
  const _ownedSlot = slot => WPNS.findIndex(w => w.slot === slot &&
    (slot === 'melee' || typeof ownedWeapons === 'undefined' || ownedWeapons.has(w.id)));
  // fastswitch-1 selection: a valid slot key plays the switch beep and switches; an
  // empty slot plays the deny beep. Cooldown so mashing keys doesn't machine-gun it.
  // Slot keys 1-6 ALWAYS beep (as in the original — even an empty slot makes the
  // sound); 1/2/3 also switch to the owned weapon in that slot.
  const _digit = e.code.match(/^Digit([1-6])$/);
  if (_digit) {
    _playSwitchSound();
    const n = +_digit[1];
    if (n === 4) {
      // Slot 4 cycles through the owned grenade types (HE/flash/smoke).
      const owned = WPNS.map((w, i) => ({ w, i })).filter(o => o.w.slot === 'grenade' && ownedWeapons.has(o.w.id));
      if (owned.length) {
        const ci = owned.findIndex(o => o.i === curWpnIdx);            // -1 if not on a grenade
        switchWeapon(owned[(ci + 1) % owned.length].i);
      }
    } else {
      const slot = { 1: 'primary', 2: 'secondary', 3: 'melee' }[n];
      if (slot) { const i = _ownedSlot(slot); if (i >= 0) switchWeapon(i); }
    }
  }
  if (e.code === 'KeyQ') {   // previous owned weapon
    for (let k = 1; k < WPNS.length; k++) {
      const i = (curWpnIdx + WPNS.length - k) % WPNS.length;
      if (WPNS[i].slot === 'melee' || typeof ownedWeapons === 'undefined' || ownedWeapons.has(WPNS[i].id)) {
        _playSwitchSound(); switchWeapon(i); break;
      }
    }
  }
  if (e.code === 'KeyF')   toggleSilencer();
  if (e.code === 'KeyG' && typeof dropWeapon === 'function') dropWeapon();   // drop current weapon
  if (e.code === 'KeyV')   toggleThirdPerson();
  if (e.code === 'KeyR') {
    const wpn = curW();
    if (wpn.type === 'gun' && ws === WS.IDLE && wpn.ammo < wpn.maxAmmo && wpn.reserve > 0) {
      ws = WS.RELOAD; wsT = 0;
    }
  }
});
document.addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'Tab' && typeof scoreboardOpen !== 'undefined') scoreboardOpen = false;   // release Tab → hide scoreboard
});

// ── Weapon input ──────────────────────────────────────────────────────────
let lmbHeld = false, rmbHeld = false;
document.addEventListener('mousedown', e => {
  if (e.button === 0) lmbHeld = true;
  if (e.button === 2) rmbHeld = true;
  if (!isLocked) return;
  if ((typeof playerDead !== 'undefined' && playerDead) || (typeof spectating !== 'undefined' && spectating)) {
    if (typeof specCycle === 'function') specCycle(e.button === 2 ? -1 : 1);   // spectate: click cycles target
    return;
  }
  const wpn = curW();
  // Knife: gated by meleeCooldown (CS rate); held-repeat handled in updateWeapon.
  if (wpn.type === 'melee') {
    if (meleeCooldown <= 0 && (ws === WS.IDLE || ws === WS.SLASH || ws === WS.STAB)) {
      if      (e.button === 0) _startMeleeAttack(wpn, false);
      else if (e.button === 2) _startMeleeAttack(wpn, true);
    }
    return;
  }
  // Grenade: hold LMB to pull the pin (cook), release to throw (handled on mouseup).
  if (wpn.type === 'grenade') {
    if (e.button === 0 && ws === WS.IDLE) {
      ws = WS.PULLPIN; wsT = 0; wsHit = false;
      if (wpn.anim) { wpn.anim._prevAnimWs = undefined; wpn.anim.curFrame = 0; }
    }
    return;
  }
  if (wpn.type !== 'gun') return;
  // RMB: scope zoom (AWP), burst toggle (Glock), or silencer toggle (M4/USP).
  // Works from idle only — cycleScope/toggleSilencer self-gate, burst is harmless.
  if (e.button === 2) {
    if      (wpn.zoomFovs)    cycleScope();
    else if (wpn.burstCapable) wpn._burstMode = !wpn._burstMode;
    else                       toggleSilencer();
    return;
  }
  // LMB: one trigger pull = one shot, capped at the weapon's cycletime. If the
  // click lands mid-cooldown (FIRE state), buffer it (latch one pending shot) so
  // it fires the instant the cooldown ends — instead of being dropped. Dropping
  // made evenly-spaced clicks beat against the 0.15s cycle and feel like random
  // pauses; buffering makes the cadence track the player's clicking.
  if (e.button === 0) {
    if (wpn.ammo > 0) {
      if (ws === WS.IDLE) _beginFire(wpn);
      else if (ws === WS.FIRE && !wpn.autofire) wpn._fireQueued = true;
    } else if (wpn.reserve > 0 && ws === WS.IDLE) {
      ws = WS.RELOAD; wsT = 0;
    }
  }
});
document.addEventListener('mouseup',  e => {
  if (e.button === 0) lmbHeld = false;
  if (e.button === 2) rmbHeld = false;
  if (!isLocked) return;
  // Grenade: releasing LMB after pulling the pin throws it.
  const wpn = curW();
  if (e.button === 0 && wpn.type === 'grenade' && ws === WS.PULLPIN) {
    ws = WS.THROW; wsT = 0; wsHit = false;
    if (wpn.anim) { wpn.anim._prevAnimWs = undefined; wpn.anim.curFrame = 0; }
  }
});
document.addEventListener('contextmenu', e => e.preventDefault());

// ── Render loop ───────────────────────────────────────────────────────────
let lastT = 0;
function animate(t) {
  requestAnimationFrame(animate);
  const rawDt = (t - lastT) / 1000;
  const dt = Math.min(rawDt, 0.05);
  lastT = t;

  // If frame was stalled >300ms (GPU switch / tab switch) — discard accumulated mouse input
  if (rawDt > 0.3) { pendingYaw = pendingPitch = 0; }

  // Apply accumulated mouse delta — capped to MAX_DELTA_PER_FRAME
  const clamp = (v, a) => Math.max(-a, Math.min(a, v));
  yaw   += clamp(pendingYaw,   MAX_DELTA_PER_FRAME);
  pitch += clamp(pendingPitch, MAX_DELTA_PER_FRAME);
  pitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
  pendingYaw = pendingPitch = 0;

  // While the Start loading screen is up, update it and don't simulate yet.
  if (gameLoading) {
    const p = Math.round(gameAssetsProgress() * 100);
    $glFill.style.width = p + '%';
    $glPct.textContent = `${p}%  (модели ${_modelFetchTotal - _modelFetchPending}/${_modelFetchTotal}, текстуры ${_assetMgr.itemsLoaded}/${_assetMgr.itemsTotal})`;
    let ready = false;
    try { ready = gameAssetsReady(); } catch (e) { console.error('gameAssetsReady', e); ready = true; }
    // Safety: never hang the loading screen — reveal after 15s no matter what.
    if (ready || performance.now() - gameLoadStart > 15000) {
      gameLoading = false; $gameload.style.display = 'none';
    }
  }

  if (isLocked && gsPos && !gameLoading) {
    if (teamStage) {
      syncCameraToPlayer();        // keep the frozen view at the spawn (team/class menu)
    } else if ((typeof spectating !== 'undefined' && spectating) && typeof updateDeathCam === 'function') {
      updateDeathCam(dt);          // pure spectator: follow living players
    } else if (!playerDead) {
      playerMove(dt);
      if (typeof updateMovementSounds === 'function') updateMovementSounds(dt);
      updateWeapon(dt);
    } else if (typeof updateDeathCam === 'function') {
      updateDeathCam(dt);          // death cam: 3rd-person death anim → spectate living players
    } else {
      syncCameraToPlayer();
    }
    updatePlayerModel(dt);
    if (typeof updatePickups === 'function') updatePickups(dt);   // dropped-weapon physics + pickup
    if (typeof updateGrenades === 'function') updateGrenades(dt); // thrown nades: physics + detonation
    if (typeof updateProjectiles === 'function') updateProjectiles(dt); // HL rocket/bolt + RPG laser dot
    updateEnemy(dt);
    if (typeof netUpdate === 'function') netUpdate(dt);       // multiplayer: send/recv + remote players
    if (typeof updateRound === 'function') updateRound(dt);   // match flow + C4 bomb
    updateHUD();
    if (typeof updateBuyHUD === 'function') updateBuyHUD();
    const spd = Math.hypot(vel[0], vel[1]);
    document.getElementById('pos').textContent =
      `XYZ  ${gsPos[0].toFixed(0)}  ${gsPos[1].toFixed(0)}  ${gsPos[2].toFixed(0)}`;
    document.getElementById('spd').textContent =
      `Speed ${spd.toFixed(0)}  ${onGround ? 'GROUND' : 'AIR'}  ${duckAmount > 0.1 ? 'DUCK' : ''}`;
  }
  // Safety: clamp punch and guard against NaN
  if (!isFinite(punchPitch)) { punchPitch = punchVel = 0; }
  if (!isFinite(punchRoll))  { punchRoll  = punchRollVel = 0; }
  punchPitch = Math.max(-0.4, Math.min(0.4, punchPitch));
  punchRoll  = Math.max(-0.4, Math.min(0.4, punchRoll));
  if (!isFinite(recoilPitch)) recoilPitch = 0;
  if (!isFinite(recoilYaw))   recoilYaw   = 0;

  // Camera orientation. First-person: follows mouse-look (+ recoil/punch).
  // Third-person: DECOUPLED from the mouse — the camera holds a fixed angle
  // (orbited only by arrow keys) so the mouse turns just the player model; this
  // lets you watch the body/torso posture change as you look around.
  updateOrbit(dt);
  if (thirdPerson) {
    yawObj.rotation.y   = orbitYaw;
    pitchObj.rotation.x = orbitPitch;
    camera.rotation.z   = 0;
  } else {
    yawObj.rotation.y   = isFinite(yaw)   ? yaw   + recoilYaw   : 0;
    pitchObj.rotation.x = isFinite(pitch) ? pitch + punchPitch + recoilPitch : 0;
    camera.rotation.z   = punchRoll;   // landing tilt to one side (dead uses the 3rd-person cam)
  }
  updateChaseCamera();               // third-person: pull camera back; else recenter

  if (!isLocked) {
    _renderMenuBackdrop(dt);     // rotating map in the right region; card is HTML on the left
  } else {
    _tickFlashWorld();              // fade the third-person world muzzle flash
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    _updateShells(dt);
    _updateBlood(dt);              // blood spray/mist from dummy hits
    // In third-person the view-model/muzzle-flash overlay is hidden (we see the
    // world-space player model instead). Scoped (AWP) also hides it — you're
    // looking through the lens, not over the gun.
    // Viewmodel: shown in first person, AND while spectating a player in first-person
    // (_specEye) — there we render THEIR weapon's viewmodel (driven in updateDeathCam).
    if ((!thirdPerson || (typeof _specEye !== 'undefined' && _specEye)) && !isScoped()) {
      const _cw = curW();
      // HL guns (rpg/crossbow): locked, slightly-closer horizontal FOV so the un-modelled back
      // isn't exposed on widescreen. Every other gun keeps the standard 49° vertical FOV.
      vmCamera.fov = (_cw && _cw.leftHandModel)
        ? 2 * Math.atan(Math.tan(VM_HFOV / 2) / vmCamera.aspect) * (180 / Math.PI)
        : 49;
      vmCamera.updateProjectionMatrix();
      // Knife + the Half-Life viewmodels (RPG/crossbow) are LEFT-handed in their MDL, so they
      // flip opposite to the right-handed CS viewmodels.
      const shouldFlip = (_cw.id === 'knife' || _cw.leftHandModel) ? !rightHand : rightHand;
      if (shouldFlip) vmCamera.projectionMatrix.elements[0] *= -1;
      vmCamera.projectionMatrixInverse.copy(vmCamera.projectionMatrix).invert();
      _tickFlash();
      renderer.render(_flashScene2D, _flashOrtho);
      renderer.render(vmScene, vmCamera);
    }
  }
}
animate(0);

// Probe the multiplayer server on load so the start menu shows its status (read-only;
// no team is sent until you pick one). Silently stays solo if no server is running.
if (typeof netConnect === 'function') netConnect(false);

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  updateFOV();
  vmCamera.aspect = innerWidth / innerHeight;
  updateVmCamera();
  const ar = innerWidth / innerHeight;
  _flashOrtho.left = -ar; _flashOrtho.right = ar;
  _flashOrtho.updateProjectionMatrix();
  frameMenuCamera();                  // re-fit the top-down menu view to the new aspect
  renderer.setSize(innerWidth, innerHeight);
});
