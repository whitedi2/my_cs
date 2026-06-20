// pickups.js — drop & pick up weapons in the world, with the original CS sounds.
// Classic script — shares one global scope. Reuses _GUN_FILES/_buildRig (player.js),
// ownedWeapons (game.js), WPNS/switchWeapon (weapons.js), scene/yawObj (scene.js),
// _shellRayTargets (effects.js), playSound (audio.js).

const PICKUP_SOUND  = 'items/gunpickup2.wav';   // drop is silent; only pickup plays a sound
const PICKUP_RADIUS = 56;            // GoldSrc units — walk this close to grab a dropped gun
const _pickups      = [];            // dropped weapons currently lying in the world
const _pDataCache   = {};            // weapon id → p_<weapon>.json data (cached) | 'loading'
const _pickRay      = new THREE.Raycaster();
const _pickRayDir   = new THREE.Vector3(0, -1, 0);
const _pickRayOrg   = new THREE.Vector3();

function _slotOf(wid)    { const w = WPNS.find(x => x.id === wid); return w ? w.slot : null; }
function _ownsSlot(slot) { return [...ownedWeapons].some(id => _slotOf(id) === slot); }

// Static world model from p_<weapon>.json. Its raw vertices are already in three
// (Y-up) space — the same as the player model (which renders with no X tip). The
// p_ origin sits at the player's pelvis/hand, so the gun mesh is offset well above
// it — placing that origin on the floor would leave the gun floating. So we re-centre
// the mesh on the group origin and record its half-height to rest it on the ground.
function _buildDropModel(data) {
  const root = _buildRig(data.meshes).root;
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.children.forEach(m => m.position.sub(c));        // gun centred on the group origin
  root.userData.halfH = (box.max.y - box.min.y) / 2 || 4;
  return root;
}

function _withPData(wid, cb) {
  const cached = _pDataCache[wid];
  if (cached === 'loading') return;
  if (cached) { cb(cached); return; }
  const file = (typeof _GUN_FILES !== 'undefined') && _GUN_FILES[wid];
  if (!file) return;
  _pDataCache[wid] = 'loading';
  fetch(file).then(r => r.json()).then(data => { _pDataCache[wid] = data; cb(data); })
    .catch(err => { _pDataCache[wid] = null; console.warn('pickup model load failed', wid, err); });
}

// Spawn a dropped weapon at the player, tossed along the view direction (so the
// landing distance depends on where you look, as in the original); it falls to the
// floor. Forward vector uses the same convention as the aim ray (yaw + pitch).
function _spawnPickup(wid, ammo, reserve) {
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const dx = -Math.sin(yaw) * cp, dy = -sp, dz = -Math.cos(yaw) * cp;   // three-space look forward
  const SPEED = 300;
  const hx = -Math.sin(yaw), hz = -Math.cos(yaw);          // horizontal forward (hand offset)
  const item = {
    wid, slot: _slotOf(wid), ammo, reserve,
    settled: false, halfH: 4,
    noPickT: 1.0,                                          // ~1 s before it can be re-picked
    root: null, spin: (Math.random() - 0.5) * 10,
    // leave the hands, not the eyes: drop ~16u below the eye and ~18u in front
    pos: new THREE.Vector3(gsPos[0] + hx * 18, gsPos[2] + eyeH - 16, -gsPos[1] + hz * 18),
    vel: new THREE.Vector3(dx * SPEED, dy * SPEED + 60, dz * SPEED),
  };
  _pickups.push(item);
  _withPData(wid, data => {
    if (!_pickups.includes(item)) return;
    item.root = _buildDropModel(data);
    item.halfH = item.root.userData.halfH || 4;
    item.root.position.copy(item.pos);
    scene.add(item.root);
  });
}

// Drop the current weapon (G). The knife can't be dropped (as in CS). Switches to a
// remaining gun, else the knife.
function dropWeapon() {
  if (typeof ownedWeapons === 'undefined' || !gsPos) return;
  const wpn = curW();
  if (!wpn || wpn.type === 'melee' || !ownedWeapons.has(wpn.id)) return;
  // Multiplayer: the server owns the drop (it places the gun + switches us). Only guns drop over
  // the net; switch locally now for instant feedback (gstate.me.weapons confirms).
  if (typeof _netDriven !== 'undefined' && _netDriven) {
    if (wpn.type !== 'gun' || typeof netSendDrop !== 'function') return;
    netSendDrop(wpn.id);
    ownedWeapons.delete(wpn.id);
    let n = WPNS.findIndex(w => w.id !== wpn.id && w.slot !== 'melee' && ownedWeapons.has(w.id));
    if (n < 0) n = WPNS.findIndex(w => w.id === 'knife');
    if (n >= 0) switchWeapon(n);
    return;
  }
  _spawnPickup(wpn.id, wpn.ammo, wpn.reserve);
  ownedWeapons.delete(wpn.id);
  // Drop is silent (as the user wants) — only picking a weapon up makes a sound.
  let next = WPNS.findIndex(w => w.id !== wpn.id && w.slot !== 'melee' && ownedWeapons.has(w.id));
  if (next < 0) next = WPNS.findIndex(w => w.id === 'knife');
  if (next >= 0) switchWeapon(next);
}

function _pickUp(item, idx) {
  ownedWeapons.add(item.wid);
  const w = WPNS.find(x => x.id === item.wid);
  if (w) { w.ammo = item.ammo; w.reserve = item.reserve; }
  if (item.root) scene.remove(item.root);
  _pickups.splice(idx, 1);
  if (typeof playSound === 'function') playSound(PICKUP_SOUND, { volume: 0.8 });
  const i = WPNS.findIndex(x => x.id === item.wid);
  if (i >= 0) switchWeapon(i);                              // CS deploys a weapon you pick up
}

// Per-frame: fall to the floor + auto-pickup when the player walks over one whose
// slot is free. Call from the main loop.
function updatePickups(dt) {
  if (!_pickups.length) return;
  const floorApprox = (typeof yawObj !== 'undefined') ? yawObj.position.y - SV.eyestand : 0;
  for (let k = _pickups.length - 1; k >= 0; k--) {
    const it = _pickups[k];
    if (it.noPickT > 0) it.noPickT -= dt;

    if (!it.settled) {
      it.vel.y -= 800 * dt;                                // gravity
      it.pos.addScaledVector(it.vel, dt);
      // Trace the floor under the CURRENT position each frame (the gun is tossed,
      // so the floor it lands on may differ from where it started).
      let groundY = floorApprox;
      if (_shellRayTargets) {
        _pickRayOrg.copy(it.pos); _pickRayOrg.y += 64;
        _pickRay.set(_pickRayOrg, _pickRayDir); _pickRay.far = 4000;
        const hit = _pickRay.intersectObjects(_shellRayTargets, false);
        if (hit.length) groundY = hit[0].point.y;
      }
      const gy = groundY + it.halfH;                       // rest the gun's bottom on the floor
      if (it.pos.y <= gy && it.vel.y <= 0) { it.pos.y = gy; it.settled = true; it.vel.set(0, 0, 0); }
      if (it.root) {
        it.root.position.copy(it.pos);
        if (!it.settled) it.root.rotation.y += it.spin * dt;
      }
    }

    if (it.noPickT <= 0 && gsPos && !_ownsSlot(it.slot)) {
      const dx = gsPos[0] - it.pos.x, dz = -gsPos[1] - it.pos.z;
      if (Math.hypot(dx, dz) < PICKUP_RADIUS) _pickUp(it, k);
    }
  }
}

// ── Networked weapon drops (MP) ──────────────────────────────────────────────
// The SERVER owns death-drops + walk-over pickup; the client just RENDERS the loose guns from
// gstate (`drops`). The actual pickup is server-side — it grants the weapon, which lands back via
// gstate.me.weapons (applyServerSelf deploys it). No local auto-pickup here (that's solo only).
const _netDrops = new Map();   // server drop id → { root, wid }
function setNetWeaponDrops(list) {
  const seen = new Set();
  for (const d of (list || [])) {
    seen.add(d.id);
    if (_netDrops.has(d.id)) continue;                  // static once dropped — build the mesh once
    const e = { root: null, wid: d.wid };
    _netDrops.set(d.id, e);
    _withPData(d.wid, data => {
      if (_netDrops.get(d.id) !== e || typeof scene === 'undefined') return;
      e.root = _buildDropModel(data);
      const halfH = e.root.userData.halfH || 4;
      e.root.position.set(d.pos[0], d.pos[2] + halfH, -d.pos[1]);   // GoldSrc→three, rested on the floor
      scene.add(e.root);
    });
  }
  for (const [id, e] of _netDrops) if (!seen.has(id)) {  // picked up / round reset → remove
    if (e.root && typeof scene !== 'undefined') scene.remove(e.root);
    _netDrops.delete(id);
  }
}
