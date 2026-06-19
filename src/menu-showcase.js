// menu-showcase.js — animated start-menu backdrop that cycles several scenes, each
// separated by a black cross-fade:
//   1. 'map'    — the rotating bird's-eye of de_dust2 (existing menuCamera orbit).
//   2. 'passCT' — a CT (gign, M4) slides in from the LEFT on a sideways strafe, firing
//                 toward the screen (muzzle flashes + brass), fading out near the centre.
//   3. 'passT'  — same from the RIGHT with a T (leet, AK-47).
//   4. 'arena'  — both models on the map, facing each other, trading fire.
//
// Classic script, shared global scope. Loads after player.js (_buildRig, _initModelRig,
// animateThirdPerson, _weaponTypeOf), weapons.js (WPNS, WS), effects.js (_spawnShell,
// _updateShells), scene.js (scene, menuCamera, _showFlashWorld, _tickFlashWorld,
// MENU_LEFT_FRAC), net.js (_netModelCache) and reads load.js's mapRoot/mapReady.
//
// No invented animation: the models run through the SAME third-person core as networked
// players (animateThirdPerson). We only feed it a synthetic strafe + continuous-fire state,
// then add the original third-person muzzle flash / brass on each shot.

// ── Tunables ────────────────────────────────────────────────────────────────
const _DUEL = {
  SLOWMO:     0.45,       // time scale for the gunfights (cinematic slow motion)
  STRAFE_W:   3.0,        // arena strafe angular speed (rad / slow-second)
  STRAFE_AMP: 28,         // arena strafe amplitude (GS units)
  SEP:        46,         // arena: half-distance between the two fighters
  FIRE_DT:    0.09,       // shot cadence in slow time (≈ rifle rate, stretched by SLOWMO)
  FADE_T:     0.8,        // black cross-fade duration (s)
  CAM_DIST:   200,        // camera distance from the fighters (GS units)
  VOID:       [50000, 0, 40],   // void anchor: far from the map so floor-light always misses → bright
  // Single-actor crossing (pass scenes): travel from the screen edge toward the centre.
  PASS_T:     5.0,        // slow-seconds for one full crossing (higher = slower screen travel)
  PASS_X0:    82,         // start X (screen edge, GS units)
  PASS_X1:    6,          // end X (just past centre)
  AIM_PITCH:  0.70,       // pass: raise the muzzle UP (clamped to the model's aim-pitch range)
  AIM_YAW:    0.12,       // pass: small torso turn (centres the right-hand-held gun)
  GUN_COMP:   0.60,       // pass: turn the BODY+GUN together toward the camera by this × the leg-twist
                          //       (torso holds the aim, gun follows — like aiming in-game). Tune the amount.
  FLASH_FWD:  4.0,        // pass: push the muzzle flash forward along the barrel onto the visible tip
  ct: { model: 'gign', team: 'ct', weapon: 'm4'   },
  t:  { model: 'leet', team: 't',  weapon: 'ak47' },
};

// Scene cycle: key + how long it holds (seconds) before the next cross-fade + a label.
// ('arena' — the on-map fight — is parked for now; the pass scenes drive the showcase.)
const _SCENES = [
  { key: 'map',    hold: 11, label: 'карта' },
  { key: 'passCT', hold: 8,  label: 'CT · M4 (слева)' },
  { key: 'passT',  hold: 8,  label: 'T · AK (справа)' },
];

const duelCamera = new THREE.PerspectiveCamera(46, 1, 1, 80000);

let _insts = null;              // { ct, t } once built
let _arenaAnchor = null;        // [x,y,z] GS floor anchor for the on-map fight (a CT spawn)
let _duelClock = 0;             // accumulated SLOW time for the CURRENT scene (reset on switch)

// Cross-fade state machine (real dt, independent of the slow-mo animation clock).
let _sceneIdx = 0;
let _holdT = _SCENES[0].hold;
let _fade = 0, _fadeDir = 0;    // darkness 0..1; dir: 0 hold, +1 fading out, −1 fading in
let _fadeEl = null, _hintEl = null, _nameEl = null;
let _lastScene = null;          // detect scene entry (to reset the fighter's gait once)

function _curScene() { return _SCENES[_sceneIdx].key; }

// Manual scene switch (testing arrows): jump instantly, restart the animation clock.
function showcaseGo(delta) {
  _sceneIdx = (_sceneIdx + delta + _SCENES.length) % _SCENES.length;
  _holdT = _SCENES[_sceneIdx].hold;
  _fade = 0; _fadeDir = 0; _duelClock = 0;
  if (_nameEl) _nameEl.textContent = _SCENES[_sceneIdx].label;
}

// ── GS (x,y,z, Z-up) → three (x, z, −y) ─────────────────────────────────────
const _camTmp = new THREE.Vector3();
function _g2t(v, x, y, z) { v.set(x, z, -y); return v; }

// Rotate a world point `v` about a vertical axis through `c` by `ang` (matches root.rotation.y += ang).
function _rotAboutY(v, c, ang) {
  const s = Math.sin(ang), co = Math.cos(ang);
  const dx = v.x - c.x, dz = v.z - c.z;
  v.x = c.x + dx * co + dz * s;
  v.z = c.z - dx * s + dz * co;
}
const _fwdTmp = new THREE.Vector3();
const _handLocal = new THREE.Vector3();

// ── Build the two fighters (lazy, once the models are ready) ────────────────
function _makeInst(cfg) {
  return {
    id: 'duel_' + cfg.model, model: cfg.model, weapon: cfg.weapon, team: cfg.team,
    root: null, ready: false, gunRigs: {},
    lightCol: new THREE.Color(1, 1, 1),
    handWorld: new THREE.Vector3(), muzzleWorld: new THREE.Vector3(),
    phase: 0, frame: 0, dk: 0, yaw: 0, wsT: 0, shotT: 0,
  };
}

function _buildInst(inst) {
  const finish = (data) => {
    if (!inst.__alive) return;
    const rig = _buildRig(data.meshes);
    scene.add(rig.root);
    inst.root = rig.root; inst.meshes = rig.meshes;
    inst.originalPositions = rig.originalPositions; inst.boneIndices = rig.boneIndices;
    _initModelRig(inst, data);
    inst.root.visible = false;
    inst.ready = true;
  };
  const name = inst.model;
  if (_netModelCache[name]) { finish(_netModelCache[name]); return; }
  fetch(`models/player_${name}.json`).then(r => r.json())
    .then(d => { _netModelCache[name] = d; finish(d); })
    .catch(err => console.warn('[showcase] model not loaded:', name, err));
}

function _ensureBuilt() {
  if (_insts || !mapReady) return;
  _insts = { ct: _makeInst(_DUEL.ct), t: _makeInst(_DUEL.t) };
  if (typeof spawnPoints !== 'undefined' && spawnPoints.ct && spawnPoints.ct[0])
    _arenaAnchor = spawnPoints.ct[0].origin.slice();
  else _arenaAnchor = [0, 0, 64];
  let i = 0;
  for (const inst of [_insts.ct, _insts.t]) {
    inst.__alive = true;
    inst.phase = i === 0 ? 0 : Math.PI;                 // arena: opposite strafe phase
    inst.shotT = i === 0 ? 0 : _DUEL.FIRE_DT * 0.5;     // stagger shots (shared flash sprite)
    inst.dx = i === 0 ? -1 : +1;
    _buildInst(inst);
    i++;
  }
}

// Per-mesh opacity for the cross-screen fade.
function _applyAlpha(inst, a) {
  const set = (m) => { m.transparent = a < 0.985; m.opacity = a; m.depthWrite = a >= 0.5; };
  for (const m of inst.meshes) set(m);
  const gun = inst.gunRigs[inst.weapon];
  if (gun) for (const m of gun.meshes) set(m);
}

// Eject a brass shell from a fighter's gun (world space) — generalised _ejectShellThirdPerson.
const _ejR = new THREE.Vector3(), _ejU = new THREE.Vector3(0, 1, 0), _ejF = new THREE.Vector3();
function _ejectShell(inst) {
  if (!inst.hasHandWorld || typeof _spawnShell !== 'function') return;
  const wpn = (typeof WPNS !== 'undefined') ? WPNS.find(w => w.id === inst.weapon) : null;
  const type = (wpn && wpn.shellType) || 'rifle';
  const cy = Math.cos(inst.yaw), sy = Math.sin(inst.yaw);
  _ejR.set(cy, 0, -sy);            // right
  _ejF.set(-sy, 0, -cy);           // forward
  const rv = () => (Math.random() - 0.5) * 2;
  const pos = inst.handWorld.clone().addScaledVector(_ejU, 3);
  const vel = new THREE.Vector3()
    .addScaledVector(_ejR, 75 + rv() * 35)
    .addScaledVector(_ejU, 85 + rv() * 25)
    .addScaledVector(_ejF, -10 + rv() * 25);
  _spawnShell(type, pos, vel);
}

// Pose for a fighter this frame: position / velocity / facing / opacity, per scene.
function _pose(inst, key) {
  const t = _duelClock;
  if (key === 'arena') {
    const a = _arenaAnchor;
    const sway  = Math.sin(t * _DUEL.STRAFE_W + inst.phase) * _DUEL.STRAFE_AMP;
    const dsway = Math.cos(t * _DUEL.STRAFE_W + inst.phase) * _DUEL.STRAFE_W * _DUEL.STRAFE_AMP;
    // CT (−X) faces +X (yaw −π/2), T (+X) faces −X (yaw +π/2) → they face each other; the
    // arena strafe moves along Y, 90° from the aim, so it reads as a strafe too.
    return { pos: [a[0] + inst.dx * _DUEL.SEP, a[1] + sway, a[2]], vel: [0, dsway, 0],
             yaw: inst.dx < 0 ? -Math.PI / 2 : Math.PI / 2, alpha: 1 };
  }
  // Pass scene: the fighter FACES the camera and strafes sideways (torso square to the
  // camera, legs angled toward the motion — a real strafe). yaw = π makes the torso face the
  // −Y camera AND keeps move-vs-aim at 90° (a strafe, not a back-pedal). Movement along GS X
  // is screen-horizontal. "Left/right" are the FIGHTER's own: at yaw π his left is +X (screen
  // right), so CT (strafe-left) enters from the LEFT and slides right; T (strafe-right) the
  // mirror — enters from the RIGHT, slides left.
  // Full sideways crossing (edge → far edge) so the fighter never stops at the centre
  // ("invisible wall"): it keeps strafing at constant speed and FADES OUT on the move.
  const ctScene = (key === 'passCT');
  const x0 = ctScene ? -_DUEL.PASS_X0 :  _DUEL.PASS_X0;
  const x1 = -x0;                                               // keep moving past centre (never stops)
  const p = Math.min(1, t / _DUEL.PASS_T);
  const b = _DUEL.VOID;
  const x  = x0 + (x1 - x0) * p;
  const vx = (x1 - x0) / _DUEL.PASS_T;                          // GS / slow-second (drives strafe gait)
  // Fade in on entry, then fade out (still mid-stride) a bit past centre — fully gone by
  // p≈0.70, well before the screen edge, so it never bumps the border.
  const alpha = Math.max(0, Math.min(1, p / 0.12)) * (1 - Math.max(0, Math.min(1, (p - 0.42) / 0.28)));
  // yaw = π faces the camera; the torso turn that centres the right-held gun is MIRRORED for
  // CT vs T (they strafe opposite ways, so the gait pulls the gun opposite ways). +AIM_PITCH
  // lifts the muzzle to the camera. (Tunables in _DUEL.)
  // Sideways velocity → real strafe gait (legs twist toward the motion; the spine counter-twist
  // keeps the torso/gun on the aim). yaw = π aims the torso straight at the camera.
  return { pos: [b[0] + x, b[1], b[2]], vel: [vx, 0, 0], yaw: Math.PI, pitch: _DUEL.AIM_PITCH, alpha };
}

// Animate one fighter: place per scene, aim flat, auto-fire with flash + brass, set opacity.
function _animate(inst, key, dtSlow) {
  if (!inst.ready || !inst.root) return;
  inst.root.visible = true;
  const p = _pose(inst, key);
  inst.yaw = p.yaw;

  let fired = false;
  inst.shotT += dtSlow;
  if (inst.shotT >= _DUEL.FIRE_DT) { inst.shotT -= _DUEL.FIRE_DT; inst.wsT = 0; fired = true; }
  else inst.wsT += dtSlow;

  animateThirdPerson(inst, {
    pos: p.pos, vel: p.vel, yaw: p.yaw, pitch: p.pitch || 0,
    onGround: true, duckAmount: 0, phyDucked: false,
    weaponId: inst.weapon,
    weaponType: (typeof _weaponTypeOf === 'function') ? _weaponTypeOf(inst.weapon) : 'gun',
    ws: WS.FIRE, wsT: inst.wsT,
  }, dtSlow);
  _applyAlpha(inst, p.alpha);

  // Turn the BODY+GUN together toward the camera (the torso holds the aim, the gun follows — the
  // in-game aim mechanic), countering the gait twist that otherwise leaks the gun off-aim.
  // Proportional to the leg-twist so it mirrors for CT vs T. Rotate the cached muzzle/hand world
  // to match so the flash & brass stay on the gun.
  const legTwist = (typeof _angleDiff === 'function') ? _angleDiff(inst.gaitYaw, p.yaw) : 0;
  const comp = legTwist * _DUEL.GUN_COMP;
  if (comp) {
    inst.root.rotation.y += comp;
    _rotAboutY(inst.muzzleWorld, inst.root.position, comp);
    _rotAboutY(inst.handWorld,   inst.root.position, comp);
  }
  // Nudge the flash forward along the barrel onto the visible muzzle ('flash' bone sits back a bit).
  if (inst.hasHandWorld && _DUEL.FLASH_FWD) {
    _fwdTmp.subVectors(inst.muzzleWorld, inst.handWorld);
    if (_fwdTmp.lengthSq() > 0.001) inst.muzzleWorld.addScaledVector(_fwdTmp.normalize(), _DUEL.FLASH_FWD);
  }

  if (fired && p.alpha > 0.05) {
    if (inst.hasMuzzleWorld && typeof _showFlashWorld === 'function') {
      const wpn = (typeof WPNS !== 'undefined') ? WPNS.find(w => w.id === inst.weapon) : null;
      _showFlashWorld(inst.muzzleWorld, wpn || { flashType: 'rifle', silencer: false });
    }
    _ejectShell(inst);
  }
}

function _hideAll() {
  if (!_insts) return;
  for (const inst of [_insts.ct, _insts.t]) {
    if (inst.root) inst.root.visible = false;
    for (const k in inst.gunRigs) { const g = inst.gunRigs[k]; if (g && g.root) g.root.visible = false; }
  }
}

function _activeInsts(key) {
  if (key === 'passCT') return [_insts.ct];
  if (key === 'passT')  return [_insts.t];
  if (key === 'arena')  return [_insts.ct, _insts.t];
  return [];
}

// Aim the duel camera at the action: from the −Y side, slightly high, looking at the centre.
function _aimCamera(key) {
  const a = (key === 'arena') ? _arenaAnchor : _DUEL.VOID;
  const driftX = Math.sin(_duelClock * 0.1) * 16;
  const up   = (key === 'arena') ? 70 : 8;    // pass: lower the camera toward the gun line
  const look = (key === 'arena') ? 44 : 12;   // so the (aim-limited) muzzle reads as pointing at us
  duelCamera.aspect = (innerWidth * (1 - MENU_LEFT_FRAC)) / innerHeight;
  _g2t(_camTmp, a[0] + driftX, a[1] - _DUEL.CAM_DIST, a[2] + up); duelCamera.position.copy(_camTmp);
  _g2t(_camTmp, a[0], a[1], a[2] + look);                         duelCamera.lookAt(_camTmp);
  duelCamera.updateProjectionMatrix();
}

// ── Public: advance the showcase; return the camera to render the region with ───
function showcaseTick(dt) {
  if (!mapReady) return null;
  _ensureBuilt();
  if (!_fadeEl) _fadeEl = document.getElementById('backdrop-fade');
  if (_hintEl === null) _hintEl = document.getElementById('map-hint') || undefined;
  if (_nameEl === null) _nameEl = document.getElementById('sc-name') || undefined;

  // Cross-fade / hold timeline (real time): hold → fade to black → next scene → fade in.
  if (_fadeDir === 0) {
    _holdT -= dt;
    if (_holdT <= 0) _fadeDir = 1;
  } else if (_fadeDir > 0) {
    _fade += dt / _DUEL.FADE_T;
    if (_fade >= 1) {
      _fade = 1;
      _sceneIdx = (_sceneIdx + 1) % _SCENES.length;
      _holdT = _SCENES[_sceneIdx].hold;
      _duelClock = 0;
      _fadeDir = -1;
    }
  } else {
    _fade -= dt / _DUEL.FADE_T;
    if (_fade <= 0) { _fade = 0; _fadeDir = 0; }
  }
  if (_fadeEl) _fadeEl.style.opacity = _fade.toFixed(3);

  const key = _curScene();
  // On entering a pass, reset the fighter's gait to aim straight at the camera (no leg twist),
  // so the gun points at us from the first frame (the "good" entry pose) and stays there.
  if (key !== _lastScene) {
    _lastScene = key;
    if ((key === 'passCT' || key === 'passT') && _insts) {
      const ctScene = (key === 'passCT');
      for (const inst of _activeInsts(key)) {
        inst.gaitYaw = ctScene ? -Math.PI / 2 : Math.PI / 2;   // settled strafe legs from frame 1
        inst.phase = 0; inst._upperMix = null; inst._lastGesture = null;
        inst.wsT = 0; inst.shotT = 0; inst.flinchT = 0;
      }
    }
  }
  if (_hintEl) _hintEl.style.visibility = (key === 'map') ? 'visible' : 'hidden';
  if (_nameEl) _nameEl.textContent = _SCENES[_sceneIdx].label;
  if (typeof _tickFlashWorld === 'function') _tickFlashWorld();       // fade muzzle flashes
  // Map mesh is hidden only in the pass (void) scenes; shown for map & arena.
  const showMap = (key === 'map' || key === 'arena');
  if (typeof mapRoot !== 'undefined' && mapRoot) mapRoot.visible = showMap;

  if (key === 'map') { _hideAll(); return null; }

  _duelClock += dt * _DUEL.SLOWMO;
  _hideAll();
  for (const inst of _activeInsts(key)) _animate(inst, key, dt * _DUEL.SLOWMO);
  if (typeof _updateShells === 'function') _updateShells(dt * _DUEL.SLOWMO);   // slow-mo brass
  _aimCamera(key);
  return { camera: duelCamera };
}

// Game start (pointer lock): hide the duel models and restore the map (the pass scenes
// hide the map mesh — must not leak into gameplay).
function showcaseStop() {
  _hideAll();
  if (typeof mapRoot !== 'undefined' && mapRoot) mapRoot.visible = true;
}

// Whether a drag should rotate the map (only meaningful in the map scene).
function showcaseInMap() { return _curScene() === 'map'; }
