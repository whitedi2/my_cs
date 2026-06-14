// input.js — pointer lock, settings, mouse/keyboard/weapon input, render loop.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── Pointer Lock ──────────────────────────────────────────────────────────
let isLocked = false;
document.getElementById('overlay').addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});
document.getElementById('settings').addEventListener('click', e => e.stopPropagation());
let mouseIgnore = 0;   // events to skip after pointer lock (avoid initial large delta)
document.addEventListener('pointerlockchange', () => {
  isLocked = document.pointerLockElement === renderer.domElement;
  if (isLocked) mouseIgnore = 5;
  document.getElementById('overlay').style.display    = isLocked ? 'none'  : 'flex';
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
  if (e.code === 'Digit1') switchWeapon(WPNS.findIndex(w => w.id === 'm4'));
  if (e.code === 'Digit2') switchWeapon(WPNS.findIndex(w => w.id === 'usp'));
  if (e.code === 'Digit3') switchWeapon(WPNS.findIndex(w => w.id === 'knife'));
  if (e.code === 'KeyQ')   switchWeapon((curWpnIdx + WPNS.length - 1) % WPNS.length);
  if (e.code === 'KeyF')   toggleSilencer();
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

  if (isLocked && gsPos) {
    playerMove(dt);
    updateWeapon(dt);
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

  // FPS camera: yaw on parent (world Y), pitch on child (local X), roll on view axis
  yawObj.rotation.y   = isFinite(yaw)   ? yaw   + recoilYaw   : 0;
  pitchObj.rotation.x = isFinite(pitch) ? pitch + punchPitch + recoilPitch : 0;
  camera.rotation.z   = punchRoll;   // landing tilt to one side

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  vmCamera.updateProjectionMatrix();
  const shouldFlip = curW().id === 'knife' ? !rightHand : rightHand;
  if (shouldFlip) vmCamera.projectionMatrix.elements[0] *= -1;
  vmCamera.projectionMatrixInverse.copy(vmCamera.projectionMatrix).invert();
  _updateShells(dt);
  _tickFlash();
  renderer.render(_flashScene2D, _flashOrtho);
  renderer.render(vmScene, vmCamera);
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
  renderer.setSize(innerWidth, innerHeight);
});
