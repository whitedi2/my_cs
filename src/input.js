// input.js — pointer lock, settings, mouse/keyboard/weapon input, render loop.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── Pointer Lock ──────────────────────────────────────────────────────────
let isLocked = false, hasStarted = false;
const $overlay    = document.getElementById('overlay');
const $btnPlay    = document.getElementById('btn-play');
const $btnRestart = document.getElementById('btn-restart');
let gameLoading = false;
const $gameload = document.getElementById('gameload');
const $glFill = document.getElementById('gl-fill');
const $glPct  = document.getElementById('gl-pct');

function _startGame() {
  if (!mapReady) return;          // map still streaming
  loadWeaponModels();             // other assets load lazily on first Start
  loadPlayerModel();
  // Lock now (needs the click gesture); cover the still-loading models with a
  // progress screen and reveal the game only once everything is ready.
  if (!gameAssetsReady()) { gameLoading = true; $gameload.style.display = 'flex'; }
  renderer.domElement.requestPointerLock();
}
$btnPlay.addEventListener('click', _startGame);
$btnRestart.addEventListener('click', () => { if (typeof respawn === 'function') respawn(); _startGame(); });

// ── Menu map preview: drag to rotate (auto-rotates otherwise) ───────────────
let _menuDragging = false, _menuLastX = 0, _menuLastY = 0;
$overlay.addEventListener('mousedown', e => {
  if (isLocked || !mapReady) return;
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

// Render the rotating map into the right-hand region; dark fill elsewhere.
function _renderMenuBackdrop(dt) {
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.setClearColor(0x0a0c10, 1);
  renderer.clear(true, true, true);
  if (!mapReady) return;
  if (!_menuDragging) menuAzimuth += dt * 0.12;   // slow auto-rotate
  frameMenuCamera();
  const reg = _menuRegion();
  renderer.setScissorTest(true);
  renderer.setViewport(reg.x, reg.y, reg.w, reg.h);
  renderer.setScissor(reg.x, reg.y, reg.w, reg.h);
  renderer.clear(true, true, true);
  const savedFog = scene.fog, savedBg = scene.background;
  scene.fog = null; scene.background = null;       // dark backdrop, only the map shows
  renderer.render(scene, menuCamera);
  scene.fog = savedFog; scene.background = savedBg;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
}
let mouseIgnore = 0;   // events to skip after pointer lock (avoid initial large delta)
document.addEventListener('pointerlockchange', () => {
  isLocked = document.pointerLockElement === renderer.domElement;
  if (isLocked) { mouseIgnore = 5; hasStarted = true; }
  else {
    // Menu shown (first time or paused): primary button label + restart visibility.
    $btnPlay.textContent      = hasStarted ? 'Продолжить' : 'Начать игру';
    $btnRestart.style.display = hasStarted ? '' : 'none';
    gameLoading = false; $gameload.style.display = 'none';   // ESC during load → back to menu
  }
  $overlay.style.display = isLocked ? 'none' : 'flex';
  document.getElementById('crosshair').style.display  = isLocked ? 'block' : 'none';
  document.getElementById('hud').style.display        = isLocked ? 'block' : 'none';
  document.getElementById('keys').style.display       = isLocked ? 'block' : 'none';
  document.getElementById('weapon-hud').style.display = isLocked ? 'block' : 'none';
});

// ── Settings ──────────────────────────────────────────────────────────────
let invertY          = CONFIG.invertY;
let widescreenFOV    = CONFIG.widescreenFOV;
let rightHand        = CONFIG.rightHand;
let dynamicCrosshair = CONFIG.dynamicCrosshair ?? false;  // cl_dynamiccrosshair (off by default)

function updateFOV() {
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
document.getElementById('opt-third-person').addEventListener('change', e => { toggleThirdPerson(e.target.checked); });

// ── Mouse look ────────────────────────────────────────────────────────────
let yaw = 0, pitch = 0;
let pendingYaw = 0, pendingPitch = 0;
const SENS = CONFIG.sensitivity;
const MAX_DELTA_PER_FRAME = Math.PI / 2;   // max 90° yaw or pitch change per frame

document.addEventListener('mousemove', e => {
  if (!isLocked) return;
  if (mouseIgnore > 0) { mouseIgnore--; return; }
  // Discard spurious huge deltas (Edge pointer-lock bug can emit movementX in thousands)
  if (Math.abs(e.movementX) > 200 || Math.abs(e.movementY) > 200) return;
  pendingYaw   -= e.movementX * SENS;
  pendingPitch -= e.movementY * SENS * (invertY ? -1 : 1);
});

// ── Keyboard ──────────────────────────────────────────────────────────────
const keys = {};
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (!isLocked) return;
  // Arrow keys orbit the third-person camera — keep them from scrolling the page.
  if (thirdPerson && e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'Digit1') switchWeapon(WPNS.findIndex(w => w.id === 'm4'));
  if (e.code === 'Digit2') switchWeapon(WPNS.findIndex(w => w.id === 'usp'));
  if (e.code === 'Digit3') switchWeapon(WPNS.findIndex(w => w.id === 'knife'));
  if (e.code === 'KeyQ')   switchWeapon((curWpnIdx + WPNS.length - 1) % WPNS.length);
  if (e.code === 'KeyF')   toggleSilencer();
  if (e.code === 'KeyV')   toggleThirdPerson();
  if (e.code === 'KeyR') {
    const wpn = curW();
    if (wpn.type === 'gun' && ws === WS.IDLE && wpn.ammo < wpn.maxAmmo && wpn.reserve > 0) {
      ws = WS.RELOAD; wsT = 0;
    }
  }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// ── Weapon input ──────────────────────────────────────────────────────────
let lmbHeld = false, rmbHeld = false;
document.addEventListener('mousedown', e => {
  if (e.button === 0) lmbHeld = true;
  if (e.button === 2) rmbHeld = true;
  if (!isLocked) return;
  const wpn = curW();
  // Knife: gated by meleeCooldown (CS rate); held-repeat handled in updateWeapon.
  if (wpn.type === 'melee') {
    if (meleeCooldown <= 0 && (ws === WS.IDLE || ws === WS.SLASH || ws === WS.STAB)) {
      if      (e.button === 0) _startMeleeAttack(wpn, false);
      else if (e.button === 2) _startMeleeAttack(wpn, true);
    }
    return;
  }
  if (ws !== WS.IDLE) return;
  if (e.button === 0) {
    if (wpn.type === 'gun') {
      if (wpn.ammo > 0) {
        wpn.ammo--; ws = WS.FIRE; wsT = 0; wsHit = false;
      } else if (wpn.reserve > 0) {
        ws = WS.RELOAD; wsT = 0;
      }
    }
  }
  if (e.button === 2 && wpn.type === 'gun')   toggleSilencer();
});
document.addEventListener('mouseup',  e => {
  if (e.button === 0) lmbHeld = false;
  if (e.button === 2) rmbHeld = false;
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
    $glPct.textContent = p + '%';
    if (gameAssetsReady()) { gameLoading = false; $gameload.style.display = 'none'; }
  }

  if (isLocked && gsPos && !gameLoading) {
    playerMove(dt);
    updateWeapon(dt);
    updatePlayerModel(dt);
    updateHUD();
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
    camera.rotation.z   = punchRoll;   // landing tilt to one side
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
    // In third-person the view-model/muzzle-flash overlay is hidden (we see the
    // world-space player model instead).
    if (!thirdPerson) {
      vmCamera.updateProjectionMatrix();
      const shouldFlip = curW().id === 'knife' ? !rightHand : rightHand;
      if (shouldFlip) vmCamera.projectionMatrix.elements[0] *= -1;
      vmCamera.projectionMatrixInverse.copy(vmCamera.projectionMatrix).invert();
      _tickFlash();
      renderer.render(_flashScene2D, _flashOrtho);
      renderer.render(vmScene, vmCamera);
    }
  }
}
animate(0);

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
