// projectiles.js — travelling projectiles for the Half-Life weapons (non-canon, gated by
// mp_hl_weapons / the solo setting). Classic script, shared global scope — no imports.
//
//   • RPG rocket  — flies from the launcher, STEERS toward the laser spot (CLaserSpot, the
//     red dot where the RPG is aimed), and detonates with radius damage on impact (HL rpg.cpp).
//   • Crossbow bolt — flies fast (light gravity) and STICKS where it lands, dealing its hit
//     damage to a body at the impact (HL crossbow.cpp).
//
// Reuses the grenade infrastructure (one global scope): `_traceGren` (swept BSP/entity trace),
// `_buildWorldMesh`, `_spawnHEExplosion`, `enemyRadiusDamage` / `playerRadiusDamage`,
// `_distVolume`. Coordinates are GoldSrc internal (x,y,z up); convert to Three (x, z, -y) only
// when placing meshes.  Solo-playable now; the authoritative netcode sync is a later step.

const _projectiles = [];      // live rockets/bolts in flight
const _stuckBolts  = [];      // bolts embedded in the world (despawn on a timer)
let   _rpgLaserPoint = null;   // [x,y,z] GoldSrc world point under the RPG aim (rocket homing target)
let   _rpgLaserDot   = null;   // the red-dot sprite (lazily built)

const _PROJ_MESH = {};         // id → built THREE.Group template (cloned per projectile)
const _PROJ_FILES = { rocket: 'models/v_rpgrocket.json', bolt: 'models/v_bolt.json' };

// Lazily fetch + build a projectile's world mesh template (reuses the grenade mesh builder).
function _ensureProjMesh(kind, cb) {
  if (_PROJ_MESH[kind]) { cb(_PROJ_MESH[kind]); return; }
  const file = _PROJ_FILES[kind];
  if (!file || typeof _buildWorldMesh !== 'function') { cb(null); return; }
  fetch(file).then(r => r.json()).then(data => {
    _PROJ_MESH[kind] = _buildWorldMesh(data);
    cb(_PROJ_MESH[kind]);
  }).catch(() => cb(null));
}

// View ray in GoldSrc coords (matches hitCheck/decal aim, so projectiles fly where you point).
function _aimRay() {
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const from = [gsPos[0], gsPos[1], gsPos[2] + eyeH];
  // fz = +sin(pitch): the real look direction (matches the camera + grenade throw, grenades.js).
  // (hitCheck uses -sin(pitch), but that's only the rarely-used knife wall-check; bullets ray the
  //  camera directly. Using -sp here flipped the laser dot AND the projectile vertically.)
  const fwd  = [-Math.sin(yaw) * cp, Math.cos(yaw) * cp, sp];
  return { from, fwd };
}

// Orient a projectile mesh so its local +X (the model's length axis) points along the GoldSrc
// velocity `v`. Mesh space is Three (x, z, -y).
const _PROJ_FWD0 = new THREE.Vector3(1, 0, 0);
function _orientMesh(mesh, v) {
  const dir = new THREE.Vector3(v[0], v[2], -v[1]);
  if (dir.lengthSq() < 1e-6) return;
  dir.normalize();
  mesh.quaternion.setFromUnitVectors(_PROJ_FWD0, dir);
}

// Spawn a rocket or bolt from the muzzle along the aim ray. Called by weapons.js WS.FIRE for a
// `wpn.projectile` weapon. dyaw/dpitch are the (usually ~0) scatter deflection.
function _fireProjectile(wpn, dyaw, dpitch) {
  if (!gsPos || !wpn.projectile) return;
  const p = wpn.projectile;
  const { from, fwd } = _aimRay();
  // Nudge the spawn out of the muzzle, but trace so firing point-blank into a wall doesn't
  // spawn the projectile inside solid.
  let pos = [from[0] + fwd[0] * 24, from[1] + fwd[1] * 24, from[2] + fwd[2] * 24];
  if (typeof _traceGren === 'function') {
    const tr0 = _traceGren(from, pos);
    if (tr0.fraction < 1) pos = [...tr0.end];
  }
  const speed = p.speed || 1000;
  const proj = {
    kind: p.kind, def: p, wid: wpn.id,
    pos, vel: [fwd[0] * speed, fwd[1] * speed, fwd[2] * speed],
    life: 0, maxLife: 6, mesh: null,
  };
  _ensureProjMesh(p.kind, tmpl => {
    if (!tmpl || proj._dead) return;
    proj.mesh = tmpl.clone();
    proj.mesh.position.set(pos[0], pos[2], -pos[1]);
    _orientMesh(proj.mesh, proj.vel);
    if (typeof scene !== 'undefined') scene.add(proj.mesh);
  });
  // In-flight loop sound (rocket motor / bolt whoosh).
  if (p.flySound && typeof playSound === 'function')
    playSound(p.flySound, { volume: Math.max(0.3, _distVolume ? _distVolume(pos, 1) : 1) });
  _projectiles.push(proj);
  // Multiplayer: the SERVER owns flight + damage and streams the projectile to everyone. Send the
  // intent; the local projectile above stays as instant visual PREDICTION (it deals no damage in
  // MP — playerRadiusDamage/enemyRadiusDamage are server-owned/solo). Remotes render the server copy.
  if (typeof _netDriven !== 'undefined' && _netDriven && typeof netSendProjectile === 'function')
    netSendProjectile([pos[0], pos[1], pos[2]], [fwd[0], fwd[1], fwd[2]], wpn.id,
                      p.kind === 'rocket' ? _rpgLaserPoint : null);
}

// Per-frame: advance projectiles, home rockets onto the laser dot, resolve impacts.
function updateProjectiles(dt) {
  _updateRpgLaser();
  for (let i = _projectiles.length - 1; i >= 0; i--) {
    const pr = _projectiles[i];
    pr.life += dt;
    if (pr.kind === 'rocket') _steerRocket(pr, dt);
    else pr.vel[2] -= SV.gravity * 0.4 * dt;          // bolt: light drop (🔹 HL bolt has gravity)

    const to = [pr.pos[0] + pr.vel[0] * dt, pr.pos[1] + pr.vel[1] * dt, pr.pos[2] + pr.vel[2] * dt];
    const tr = (typeof _traceGren === 'function') ? _traceGren(pr.pos, to) : { fraction: 1, end: to };
    pr.pos = (tr.fraction > 0) ? [...tr.end] : pr.pos;

    if (pr.mesh) { pr.mesh.position.set(pr.pos[0], pr.pos[2], -pr.pos[1]); _orientMesh(pr.mesh, pr.vel); }

    if (tr.fraction < 1 || tr.allsolid) {              // hit the world → impact
      if (pr.kind === 'rocket') _detonateRocket(pr);
      else                      _stickBolt(pr);
      _killProjectile(pr, i);
      continue;
    }
    if (pr.life >= pr.maxLife) {                       // ran out of fuel/time
      if (pr.kind === 'rocket') _detonateRocket(pr);
      _killProjectile(pr, i);
    }
  }
  _updateStuckBolts(dt);
}

// Laser-guided steering (HL CRpgRocket::FollowThink): turn the velocity toward the laser spot at
// a bounded rate so the rocket curves onto the red dot rather than snapping to it.
function _steerRocket(pr, dt) {
  if (!_rpgLaserPoint) return;
  const speed = Math.hypot(pr.vel[0], pr.vel[1], pr.vel[2]) || 1;
  const desired = [_rpgLaserPoint[0] - pr.pos[0], _rpgLaserPoint[1] - pr.pos[1], _rpgLaserPoint[2] - pr.pos[2]];
  const dl = Math.hypot(desired[0], desired[1], desired[2]) || 1;
  const dir = [desired[0] / dl, desired[1] / dl, desired[2] / dl];
  const cur = [pr.vel[0] / speed, pr.vel[1] / speed, pr.vel[2] / speed];
  const turn = Math.min(1, dt * 3.0);                 // steering authority (~3 rad/s blend)
  const nx = cur[0] + (dir[0] - cur[0]) * turn;
  const ny = cur[1] + (dir[1] - cur[1]) * turn;
  const nz = cur[2] + (dir[2] - cur[2]) * turn;
  const nl = Math.hypot(nx, ny, nz) || 1;
  pr.vel = [nx / nl * speed, ny / nl * speed, nz / nl * speed];
}

function _detonateRocket(pr) {
  const def = pr.def;
  if (typeof _spawnHEExplosion === 'function') _spawnHEExplosion(pr.pos);
  if (typeof playRandom === 'function') {
    const v = Math.max(0.3, _distVolume ? _distVolume(pr.pos, 1) : 1);
    playRandom(['weapons/explode3.wav', 'weapons/explode4.wav', 'weapons/explode5.wav'], { volume: v });
  }
  // Radius damage (covers dummies + the player) — reuses the HE grenade blast model.
  if (typeof enemyRadiusDamage === 'function')  enemyRadiusDamage(pr.pos, def.damage || 100, def.radius || 250);
  if (typeof playerRadiusDamage === 'function') playerRadiusDamage(pr.pos, def.damage || 100, def.radius || 250);
}

// Bolt sticks where it lands: drop the spent mesh into the world (oriented along its flight) and
// deal its direct damage to a body at the impact via a tight radius. 🔹 First pass: world-hit
// sound + small-radius damage (precise mid-flight body hits come with the netcode pass).
function _stickBolt(pr) {
  const def = pr.def;
  if (typeof enemyRadiusDamage === 'function')  enemyRadiusDamage(pr.pos, def.damage || 10, 24);
  if (typeof playerRadiusDamage === 'function') playerRadiusDamage(pr.pos, def.damage || 10, 24);
  if (typeof playRandom === 'function')
    playRandom(def.hitWorld || ['weapons/xbow_hit1.wav', 'weapons/xbow_hit2.wav'],
               { volume: Math.max(0.25, _distVolume ? _distVolume(pr.pos, 1) : 1) });
  if (pr.mesh) { _stuckBolts.push({ mesh: pr.mesh, life: 0 }); pr.mesh = null; }   // keep it embedded
}

function _killProjectile(pr, i) {
  pr._dead = true;
  if (pr.mesh && typeof scene !== 'undefined') scene.remove(pr.mesh);
  pr.mesh = null;
  if (i != null) _projectiles.splice(i, 1);
}

function _updateStuckBolts(dt) {
  for (let i = _stuckBolts.length - 1; i >= 0; i--) {
    const s = _stuckBolts[i]; s.life += dt;
    if (s.life > 12) { if (s.mesh && typeof scene !== 'undefined') scene.remove(s.mesh); _stuckBolts.splice(i, 1); }
  }
}

// ── RPG laser spot (CLaserSpot) ──────────────────────────────────────────────
// Red dot where the RPG is aimed. Visible only while holding the RPG (alive). The rocket homes
// onto `_rpgLaserPoint`. Built lazily as an additive red sprite that always faces the camera.
function _ensureLaserDot() {
  if (_rpgLaserDot || typeof scene === 'undefined') return;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,40,30,1)'); g.addColorStop(0.4, 'rgba(255,20,20,0.6)'); g.addColorStop(1, 'rgba(255,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, toneMapped: false });
  _rpgLaserDot = new THREE.Sprite(mat);
  _rpgLaserDot.scale.setScalar(6);
  _rpgLaserDot.renderOrder = 999;
  scene.add(_rpgLaserDot);
}

function _updateRpgLaser() {
  const holdingRpg = (typeof curW === 'function' && curW() && curW().id === 'rpg')
                  && !(typeof playerDead !== 'undefined' && playerDead) && gsPos;
  if (!holdingRpg) {
    _rpgLaserPoint = null;
    if (_rpgLaserDot) _rpgLaserDot.visible = false;
    return;
  }
  const { from, fwd } = _aimRay();
  const far = [from[0] + fwd[0] * 8192, from[1] + fwd[1] * 8192, from[2] + fwd[2] * 8192];
  const tr = (typeof _traceGren === 'function') ? _traceGren(from, far) : { fraction: 1, end: far };
  _rpgLaserPoint = [...tr.end];
  _ensureLaserDot();
  if (_rpgLaserDot) {
    _rpgLaserDot.visible = true;
    _rpgLaserDot.position.set(_rpgLaserPoint[0], _rpgLaserPoint[2], -_rpgLaserPoint[1]);
  }
}

// ── Networked projectiles (MP) ───────────────────────────────────────────────
// Render the server's authoritative rocket/bolt for OTHER players (we predict our own locally).
const _netProj = new Map();   // server projectile id → { mesh, kind }
function setNetProjectiles(list, myId) {
  const seen = new Set();
  for (const np of (list || [])) {
    if (np.o === myId) continue;                       // our own → shown via the local prediction
    seen.add(np.id);
    let e = _netProj.get(np.id);
    if (!e) {
      e = { mesh: null, kind: np.k };
      _netProj.set(np.id, e);
      _ensureProjMesh(np.k === 'rocket' ? 'rocket' : 'bolt', tmpl => {
        if (tmpl && _netProj.get(np.id) === e && typeof scene !== 'undefined') { e.mesh = tmpl.clone(); scene.add(e.mesh); }
      });
    }
    if (e.mesh && np.p) {
      e.mesh.position.set(np.p[0], np.p[2], -np.p[1]);
      if (np.v) _orientMesh(e.mesh, np.v);
    }
  }
  for (const [id, e] of _netProj) if (!seen.has(id)) {   // server removed it (impact) → drop the mesh
    if (e.mesh && typeof scene !== 'undefined') scene.remove(e.mesh);
    _netProj.delete(id);
  }
}

// A crossbow bolt fired by a REMOTE player embedded in the world (server `boltstick` event) —
// drop a stuck bolt mesh so everyone sees it, despawned on the same timer as local ones.
function netStuckBolt(pos, vel) {
  if (!pos) return;
  _ensureProjMesh('bolt', tmpl => {
    if (!tmpl || typeof scene === 'undefined') return;
    const mesh = tmpl.clone();
    mesh.position.set(pos[0], pos[2], -pos[1]);
    if (vel) _orientMesh(mesh, vel);
    scene.add(mesh);
    _stuckBolts.push({ mesh, life: 0 });
  });
}

// Wipe all projectiles + the laser (round reset / disconnect).
function clearProjectiles() {
  for (const pr of _projectiles) if (pr.mesh && typeof scene !== 'undefined') scene.remove(pr.mesh);
  _projectiles.length = 0;
  for (const s of _stuckBolts) if (s.mesh && typeof scene !== 'undefined') scene.remove(s.mesh);
  _stuckBolts.length = 0;
  for (const [, e] of _netProj) if (e.mesh && typeof scene !== 'undefined') scene.remove(e.mesh);
  _netProj.clear();
  _rpgLaserPoint = null;
  if (_rpgLaserDot) _rpgLaserDot.visible = false;
}
