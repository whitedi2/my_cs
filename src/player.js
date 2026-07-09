// player.js — third-person player model (CT model "gign", chooseteam 2→4).
// Classic script — shares one global scope with the other src/*.js. No imports.
//
// Loads models/player_<PLAYER_MODEL>.json (mesh + bones + movement sequences
// exported by tools/player_to_json.py) into the WORLD scene and skins it every
// frame using the same matrix-skinning math as the view models (computeBoneWorlds
// + boneEulerQuat live in weapons.js). Only visible when third-person is enabled.

// Which player model to show (matches a models/player_<name>.json bundle).
let playerModelName = 'gign';   // chosen by the team/class menu before the model loads

// ── Third-person toggle (read by input.js / render loop) ────────────────────
let thirdPerson = false;
const THIRD_DIST = 130;   // camera pull-back distance (units) behind the eye
const THIRD_UP   = 8;     // small vertical raise of the chase camera

// Third-person chase-camera angle (azimuth/pitch), set on toggle and moved only
// by arrow keys — independent of mouse-look so the mouse turns just the model.
let orbitYaw = 0, orbitPitch = 0;
const ORBIT_RATE = 2.4;   // rad/s while an arrow key is held

// Advance the orbit from held arrow keys; called from the render loop.
function updateOrbit(dt) {
  if (!thirdPerson) return;
  if (keys['ArrowLeft'])  orbitYaw   += ORBIT_RATE * dt;
  if (keys['ArrowRight']) orbitYaw   -= ORBIT_RATE * dt;
  if (keys['ArrowUp'])    orbitPitch += ORBIT_RATE * dt;
  if (keys['ArrowDown'])  orbitPitch -= ORBIT_RATE * dt;
  orbitPitch = Math.max(-1.2, Math.min(1.2, orbitPitch));
}

// Model lighting. The map's baked light lives in its vertex colors; each frame we
// sample the floor light under the player (see _updateModelLight) and put it on the
// material color, so the model darkens in shadow like in the original. The ambient
// is near-full (the sampled color sets the level); a weak directional adds form.
scene.add(new THREE.AmbientLight(0xffffff, 0.95));
const _plSun = new THREE.DirectionalLight(0xffffff, 0.28);
_plSun.position.set(0.6, 1, 0.4);
scene.add(_plSun);

// ── Player rig state ────────────────────────────────────────────────────────
const player = {
  root: null,
  bones: null,
  originalPositions: null,
  boneIndices: null,
  bindWorld: null,
  phase: 0,
  lightCol: new THREE.Color(1, 1, 1),   // smoothed floor light tint
  handWorld: new THREE.Vector3(),       // right-hand world pos (for shell ejection)
  hasHandWorld: false,
  muzzleWorld: new THREE.Vector3(),     // gun muzzle world pos (for third-person flash)
  hasMuzzleWorld: false,
};

const _plTexLoader = new THREE.TextureLoader(_assetMgr);   // tracked for the loading screen

// Build a skinnable rig group from a model's mesh list.
function _buildRig(meshList) {
  const root = new THREE.Group();
  const meshes = [], originalPositions = [], boneIndices = [];
  meshList.forEach(m => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(m.positions), 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(m.uvs,     2));
    geo.setIndex(m.indices);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo,
      new THREE.MeshLambertMaterial({ map: _plTexLoader.load(m.texFile), side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    mesh.userData.noHitscan = true;   // never a bullet/knife decal target (it's the player)
    root.add(mesh);
    meshes.push(mesh);
    originalPositions.push(new Float32Array(m.positions));
    boneIndices.push(m.boneIndices);
  });
  return { root, meshes, originalPositions, boneIndices };
}

// Fill a rig object with the per-model ANIMATION data shared by the local player and
// every remote player: bind pose, locomotion sequences, the upper/lower bone split,
// the leg-twist map, the bone-name index and the aim sets. (Mesh buffers are produced
// by _buildRig separately.) Both loadPlayerModel and net.js _buildRemote call this so
// remotes animate through the exact same pipeline as the local third-person model.
function _initModelRig(rig, data) {
  rig.bones = data.bones;
  const bindSeq = data.sequences.find(s => s.name === (data.bindSeq || 'idle1')) || data.sequences[0];
  rig.bindWorld = computeBoneWorlds(data.bones, bindSeq.frames[0], null, 0);
  rig.idlePose  = bindSeq.frames[0];    // neutral local pose for the upper body
  rig.aimSets   = data.aimSets || {};   // upper-body aim/shoot/reload per weapon class
  rig.seqMap    = {};
  data.sequences.forEach(s => { rig.seqMap[s.name] = s; });
  if (rig.phase == null) rig.phase = 0;

  // Upper/lower split. "Lower" (gait-driven) = ONLY the leg chains (descendants of a
  // thigh). Everything else — pelvis, spine, arms, head — is "upper" (aim-driven).
  const lThigh = data.bones.findIndex(b => b.name === 'Bip01 L Thigh');
  const rThigh = data.bones.findIndex(b => b.name === 'Bip01 R Thigh');
  rig.upper = data.bones.map((_, i) => {
    for (let j = i; j >= 0; j = data.bones[j].parent) if (j === lThigh || j === rThigh) return false;
    return true;
  });

  rig.nameToIdx = {};
  data.bones.forEach((b, i) => { rig.nameToIdx[b.name] = i; });
  rig.twistMap = _legTwistMap(data.bones);   // gait-yaw: legs twist, torso holds the aim
  rig.handBone = rig.nameToIdx['Bip01 R Hand'];   // shell-ejection point

  // Combat reactions (non-lethal flinch / death) — present only when the model was
  // exported with --deaths (leet/terror/urban have them; gign currently does not, so
  // its `flinch` is {} and these stay no-ops). Used for networked players' hit reactions.
  rig.flinch    = data.flinch || {};
  rig.flinchDur = 0.22;     // hold time of a flinch blend (s)
  if (rig.flinchT == null) rig.flinchT = 0;

  if (!rig.gunRigs)     rig.gunRigs = {};                       // weapon id → world-model rig
  if (!rig.lightCol)    rig.lightCol = new THREE.Color(1, 1, 1);
  if (!rig.handWorld)   rig.handWorld = new THREE.Vector3();
  if (!rig.muzzleWorld) rig.muzzleWorld = new THREE.Vector3();
}

// Deferred: called once at "Start" so the ~2 MB player bundle isn't fetched on page load.
let _playerLoaded = false;
function loadPlayerModel() {
  if (_playerLoaded) return;
  _playerLoaded = true;
  _trackFetchStart();
  fetch(`models/player_${playerModelName}.json`).then(r => r.json()).then(data => {
  const rig = _buildRig(data.meshes);
  rig.root.visible = false;
  scene.add(rig.root);

  player.root = rig.root;
  player.meshes = rig.meshes;
  player.originalPositions = rig.originalPositions;
  player.boneIndices = rig.boneIndices;
  _initModelRig(player, data);   // bones, seqs, aim sets, upper/lower split, twist map, bind pose

  console.log(`Player model loaded: ${data.name} (${data.bones.length} bones, ${data.sequences.length} seqs)`);
  _loadGunRigs();          // starts the gun fetches (tracked) before ending this one
  _trackFetchEnd();
  }).catch(err => { _trackFetchEnd(); console.warn('player model not loaded:', err); });
}

// ── World weapon models attached to the player's hand ───────────────────────
// p_<weapon>.json carries the gun mesh + its own copy of the player skeleton.
// We drive that skeleton with the player's current pose (matched by bone name)
// so the gun follows the hand; bones the gun adds (flash/muzzle) keep their bind
// pose. Rigs are parented to player.root, so they inherit its world placement.
const _GUN_FILES = {
  m4: 'models/p_m4a1.json', usp: 'models/p_usp.json', knife: 'models/p_knife.json',
  ak47: 'models/p_ak47.json', galil: 'models/p_galil.json', famas: 'models/p_famas.json',
  aug: 'models/p_aug.json', sg552: 'models/p_sg552.json',
  glock18: 'models/p_glock18.json', deagle: 'models/p_deagle.json',
  p228: 'models/p_p228.json', fiveseven: 'models/p_fiveseven.json',
  mp5: 'models/p_mp5.json', tmp: 'models/p_tmp.json', mac10: 'models/p_mac10.json',
  ump45: 'models/p_ump45.json', p90: 'models/p_p90.json', m249: 'models/p_m249.json',
  awp: 'models/p_awp.json',
  hegrenade: 'models/p_hegrenade.json', flashbang: 'models/p_flashbang.json',
  smokegrenade: 'models/p_smokegrenade.json',
  // HL weapons (non-canon, gated by mp_hl_weapons) — third-person world models.
  rpg: 'models/p_rpg.json', crossbow: 'models/p_crossbow.json',
};

// Parsed p_*.json cache, shared across every third-person rig (local player + remotes).
const _pModelCache = {};

// Weapon id → type ('gun' | 'melee' | 'grenade') from the WPNS config (weapons.js).
// Remote players only carry a weapon id; the upper-body layer needs the type to choose
// additive recoil (guns) vs. an absolute swing (melee).
function _weaponTypeOf(id) {
  if (typeof WPNS === 'undefined' || !id) return 'gun';
  const w = WPNS.find(x => x.id === id);
  return w ? w.type : 'gun';
}

// Build the world weapon `id` for a rig and parent it under rig.root. Shared by the
// local preload (_loadGunRigs) and the lazy per-remote loader (_ensureGunRig).
function _buildGunRig(rig, id, data) {
  if (!rig.root || !rig.gunRigs) return;
  if (rig.gunRigs[id] && rig.gunRigs[id].root) return;   // already built (preload/lazy race)
  const r = _buildRig(data.meshes);
  r.root.visible = false;
  rig.root.add(r.root);   // ride along with the model's transform
  rig.gunRigs[id] = {
    id, root: r.root, meshes: r.meshes,
    originalPositions: r.originalPositions, boneIndices: r.boneIndices,
    bones: data.bones, bindFrame: data.bindFrame,
    bindWorld: computeBoneWorlds(data.bones, data.bindFrame, null, 0),
  };
}

// Lazily ensure rig.gunRigs[id] is built (fetch + cache the p_*.json once). Returns the
// built gun rig, or null while pending / for a weapon with no world model. Remotes call
// this on demand; the local player has them all preloaded so it returns immediately.
function _ensureGunRig(rig, id) {
  if (!id || !rig.gunRigs) return null;
  const cur = rig.gunRigs[id];
  if (cur !== undefined) return cur;                   // built (obj) or pending (null)
  const file = _GUN_FILES[id];
  if (!file) { rig.gunRigs[id] = null; return null; }  // weapon with no world model
  rig.gunRigs[id] = null;                              // pending sentinel (don't refetch)
  if (_pModelCache[id]) { _buildGunRig(rig, id, _pModelCache[id]); return rig.gunRigs[id]; }
  fetch(file).then(r => r.json())
    .then(data => { _pModelCache[id] = data; _buildGunRig(rig, id, data); })
    .catch(err => console.warn('[tp] gun rig not loaded:', file, err));
  return null;
}

// Local player: preload every world model up-front (tracked by the loading screen) so
// weapon switches don't hitch. Remotes load lazily through _ensureGunRig.
function _loadGunRigs() {
  for (const [id, file] of Object.entries(_GUN_FILES)) {
    _trackFetchStart();
    fetch(file).then(r => r.json()).then(data => {
      _pModelCache[id] = data;
      _buildGunRig(player, id, data);
      _trackFetchEnd();
    }).catch(err => { _trackFetchEnd(); console.warn(`gun rig ${file} not loaded:`, err); });
  }
}

// Stand / crouch locomotion sequence names for the current speed & ground state.
function _gaitNames(st) {
  const spd = Math.hypot(st.vel[0], st.vel[1]);
  const stand  = !st.onGround ? 'jump'        : (spd > 140 ? 'run' : spd > 12 ? 'walk' : 'idle1');
  const crouch = !st.onGround ? 'crouch_idle' : (spd > 12 ? 'crouchrun' : 'crouch_idle');
  return { stand, crouch };
}

// Quaternion scratch + per-bone local-pose buffers (allocated once per bone count).
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
let _scN = 0, _qS, _tS, _qC, _tC, _qF, _tF;
function _ensureScratch(n) {
  if (_scN === n) return;
  _scN = n;
  const mk = () => Array.from({ length: n }, () => new THREE.Quaternion());
  const mt = () => Array.from({ length: n }, () => [0, 0, 0]);
  _qS = mk(); _qC = mk(); _qF = mk();
  _tS = mt(); _tC = mt(); _tF = mt();
}

// Sample a looping sequence at a normalized cycle phase into per-bone quaternions
// (slerp between adjacent frames — euler lerp glitches when a bone's euler flips
// representation, e.g. crouch_idle's right thigh) + lerped translations.
function _sampleSeqQ(seq, phase, qArr, tArr) {
  const N = seq.frames.length;
  const f = phase * N;
  const i = Math.floor(f) % N, fr = f - Math.floor(f);
  const A = seq.frames[i], B = seq.frames[(i + 1) % N];
  for (let b = 0; b < A.length; b++) {
    const a = A[b], c = B[b];
    boneEulerQuat(a[3], a[4], a[5], _qa);
    boneEulerQuat(c[3], c[4], c[5], _qb);
    qArr[b].copy(_qa).slerp(_qb, fr);
    const t = tArr[b];
    t[0] = a[0] + (c[0] - a[0]) * fr;
    t[1] = a[1] + (c[1] - a[1]) * fr;
    t[2] = a[2] + (c[2] - a[2]) * fr;
  }
}

// Forward kinematics from per-bone local quaternions + translations → world R/T.
// twistRad (gait yaw) is added around the vertical (GoldSrc Z) at the bones in
// twistMap, each scaled by its multiplier. We rotate the pelvis by +twistRad and
// the spine by −twistRad: the legs (children of the pelvis) end up twisted by
// twistRad, while the upper body (spine subtree, and the gun on it) is rotated and
// then exactly counter-rotated → it stays at the root's yaw. The root yaw IS the
// aim, so the torso can never drift off the aim no matter what the legs do.
const _twistMat = new THREE.Matrix4();
// `out` (optional): a reusable {R:[Matrix4], T:[Vector3]} scratch. Passing one avoids a
// Matrix4+Vector3 allocation per bone every frame (a big GC source with many models).
function _fkQ(bones, q, t, twistRad, twistMap, out) {
  const n = bones.length;
  const R = out ? out.R : new Array(n);
  const T = out ? out.T : new Array(n);
  for (let i = 0; i < n; i++) {
    let mat = R[i], tr = T[i];
    if (!mat) { mat = new THREE.Matrix4(); R[i] = mat; }
    if (!tr)  { tr  = new THREE.Vector3(); T[i] = tr; }
    mat.makeRotationFromQuaternion(q[i]);
    tr.set(t[i][0], t[i][1], t[i][2]);
    const par = bones[i].parent;
    if (par >= 0 && R[par]) { mat.premultiply(R[par]); tr.applyMatrix4(R[par]).add(T[par]); }
    if (twistRad && twistMap) { const m = twistMap.get(i); if (m) mat.premultiply(_twistMat.makeRotationZ(twistRad * m)); }
  }
  if (R.length > n) { R.length = n; T.length = n; }
  return out || { R, T };
}

// ── Gait yaw (GoldSrc StudioProcessGait) ────────────────────────────────────
// The legs track a separate "gait yaw" that lags the aim yaw; the difference is
// the torso twist (clamped). Standing: gait eases toward the aim, so the legs
// realign after you turn. Moving: gait faces the movement direction.
const TWIST_LIMIT = 1.0;    // max torso twist vs legs (rad, ~57°)
let TWIST_SIGN = 1;         // flip if the torso twists opposite the aim

// +1 on the pelvis, −1 on the spine: legs twist by the gait yaw, torso stays on
// the aim (the spine cancels the pelvis rotation for the upper body). See _fkQ.
function _legTwistMap(bones) {
  const m = new Map();
  const pelvis = bones.findIndex(b => b.name === 'Bip01 Pelvis');
  const spine  = bones.findIndex(b => b.name === 'Bip01 Spine');
  if (pelvis >= 0) m.set(pelvis, 1);
  if (spine  >= 0) m.set(spine, -1);
  return m;
}
function _angleDiff(a, b) {            // shortest a − b in (−π, π]
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function _easeAngle(cur, target, t) { return cur + _angleDiff(target, cur) * t; }

// Advance the gait yaw; sets player.gaitReverse (back-pedal). The torso twist is
// recomputed by the caller from player.gaitYaw.
const _BACKPEDAL = 2.094;   // ~120°: beyond this, walk backward instead of turning the legs
function _updateGaitYaw(rig, st, dt) {
  if (rig.gaitYaw == null) rig.gaitYaw = st.yaw;
  const spd = Math.hypot(st.vel[0], st.vel[1]);
  let reverse = false;
  if (st.onGround && spd > 12) {
    let moveYaw = Math.atan2(-st.vel[0], st.vel[1]);   // legs face the movement direction
    // Back-pedal (GoldSrc): if moving away from the aim by >120°, face the legs
    // toward the aim and play the gait cycle in reverse, instead of turning the
    // legs around (which would look like walking sideways/backwards-facing).
    if (Math.abs(_angleDiff(moveYaw, st.yaw)) > _BACKPEDAL) { moveYaw += Math.PI; reverse = true; }
    rig.gaitYaw = _easeAngle(rig.gaitYaw, moveYaw, 1 - Math.exp(-12 * dt));
  } else {
    rig.gaitYaw = _easeAngle(rig.gaitYaw, st.yaw, 1 - Math.exp(-5 * dt));  // legs catch up to aim
  }
  // Clamp the legs to within TWIST_LIMIT of the aim (the torso twist limit).
  const twist = _angleDiff(st.yaw, rig.gaitYaw);
  if (twist >  TWIST_LIMIT) rig.gaitYaw = st.yaw - TWIST_LIMIT;
  if (twist < -TWIST_LIMIT) rig.gaitYaw = st.yaw + TWIST_LIMIT;
  rig.gaitReverse = reverse;
}

// Native speed each locomotion cycle was authored for — used to scale playback
// to the actual ground speed so the feet stop sliding.
const _seqBaseSpeed = { walk: CONFIG.walkspeed, run: CONFIG.maxspeed, crouchrun: CONFIG.crouchspeed };

// ── Upper-body aim/shoot/reload layer ───────────────────────────────────────
const _AIM_SET = {
  m4: 'carbine', ak47: 'carbine', galil: 'carbine', famas: 'carbine', aug: 'carbine', sg552: 'carbine',
  usp: 'onehanded', knife: 'knife',
};
// In the model the −90 blend = aim up, +90 = aim down; our pitch is +up, so negate.
let AIM_PITCH_SIGN = -1;   // flip to +1 if the torso pitches the wrong way vs look

// Blend two local poses into one (linear translation, per-axis angle lerp).
function _blendPose(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    out[i] = [
      p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t,
      lerpAngle(p[3], q[3], t), lerpAngle(p[4], q[4], t), lerpAngle(p[5], q[5], t),
    ];
  }
  return out;
}

// Aim hold pose, interpolated across the 9 pitch blends by the look pitch.
function _aimPose(aim, st) {
  const [s, e] = aim.range;
  let pd = AIM_PITCH_SIGN * st.pitch * 180 / Math.PI;
  pd = Math.max(Math.min(s, e), Math.min(Math.max(s, e), pd));
  const n = aim.blends.length;
  const idx = Math.max(0, Math.min((pd - s) / (e - s) * (n - 1), n - 1));
  const i = Math.floor(idx);
  return _blendPose(aim.blends[i], aim.blends[Math.min(i + 1, n - 1)], idx - i);
}

// Sample a frame list at elapsed time t (seconds) → interpolated pose.
function _framesAt(frames, fps, t) {
  const f = t * fps;
  const last = frames.length - 1;
  if (f >= last) return frames[last];
  const i = Math.floor(f);
  return _blendPose(frames[i], frames[i + 1], f - i);
}

// Level (middle) frame list of a clip — works for single-blend and pitch-blended.
function _clipFrames(clip) { return clip.frames || clip.blends[clip.blends.length >> 1]; }

// Single-blend gesture (gun shoot/reload, level pitch).
function _clipPose(clip, t) { return _framesAt(_clipFrames(clip), clip.fps, t); }

// Pitched gesture (melee): the swing is stored at 3 pitch blends; pick/interp by
// the look pitch, then sample at time t — so the knife cuts where you look. Gun
// recoil stays additive over the aimed pose, so it doesn't need this.
function _clipPosePitched(clip, t, st) {
  if (!clip.blends) return _clipPose(clip, t);
  const [s, e] = clip.range;
  let pd = AIM_PITCH_SIGN * st.pitch * 180 / Math.PI;
  pd = Math.max(Math.min(s, e), Math.min(Math.max(s, e), pd));
  const n = clip.blends.length;
  const idx = Math.max(0, Math.min((pd - s) / (e - s) * (n - 1), n - 1));
  const i = Math.floor(idx);
  const a = _framesAt(clip.blends[i], clip.fps, t);
  const b = _framesAt(clip.blends[Math.min(i + 1, n - 1)], clip.fps, t);
  return _blendPose(a, b, idx - i);
}

// Layer a gesture (shoot/reload) ADDITIVELY onto a base pose: base + (clip(t) −
// clip[0]). The clip is authored at level aim, so adding its motion relative to
// its first frame preserves the pitch already baked into `base`. Without this the
// shoot/reload (level-only) would snap the torso to horizontal.
function _addGesture(base, clip, t) {
  const cur = _clipPose(clip, t), ref = _clipFrames(clip)[0];
  const out = new Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const s = base[i], c = cur[i], r = ref[i];
    out[i] = [s[0]+(c[0]-r[0]), s[1]+(c[1]-r[1]), s[2]+(c[2]-r[2]),
              s[3]+(c[3]-r[3]), s[4]+(c[4]-r[4]), s[5]+(c[5]-r[5])];
  }
  return out;
}

// Resolve the upper-body local pose for the current weapon + weapon state.
function _resolveUpperPose(rig, st, dt) {
  const wpnId = st.weaponId, wpnType = st.weaponType;
  const set = wpnId ? rig.aimSets[_AIM_SET[wpnId]] : null;
  let pose;
  if (!set) {
    pose = rig.idlePose;
  } else {
    const ducked = st.phyDucked || st.duckAmount > 0.5;
    const aim = (ducked && set.crouchAim) ? set.crouchAim : set.aim;
    const base = aim ? _aimPose(aim, st) : rig.idlePose;   // pitch-aimed hold pose

    // Resolve the active gesture (if any) layered over the aimed base.
    let gesture = null;
    const firing = (wpnType === 'gun' && st.ws === WS.FIRE) || st.ws === WS.SLASH || st.ws === WS.STAB;
    if (firing) {
      const clip = (ducked && set.crouchShoot) ? set.crouchShoot : set.shoot;
      // Guns: small recoil → additive over the aim. Melee: play the REAL swing
      // absolutely, pitch-blended (additive would flail a big swing).
      if (clip) gesture = (wpnType === 'gun') ? _addGesture(base, clip, st.wsT) : _clipPosePitched(clip, st.wsT, st);
    } else if (st.ws === WS.RELOAD) {
      const clip = (ducked && set.crouchReload) ? set.crouchReload : set.reload;
      if (clip) gesture = _addGesture(base, clip, st.wsT);
    }

    // Ease aim↔gesture so the torso doesn't snap its angle at attack start/end (the
    // aim-hold and the swing are different poses; the engine cross-fades too). Blend
    // out from the last gesture pose for a moment after the gesture ends.
    if (gesture) rig._lastGesture = gesture;
    const target = gesture ? 1 : 0;
    rig._upperMix = (rig._upperMix == null) ? target
      : rig._upperMix + (target - rig._upperMix) * (1 - Math.exp(-18 * (dt || 0.016)));
    pose = (rig._upperMix < 0.002 || !rig._lastGesture) ? base
         : _blendPose(base, rig._lastGesture, rig._upperMix);
  }
  return _applyFlinch(rig, pose, dt);
}

// Blend a non-lethal hit flinch (head/gut, from the model's combat anims) over the
// upper-body pose, fading out across flinchDur. No-op unless the rig is mid-flinch and
// the model carries the data (set by _onRemoteReact for networked players). GoldSrc
// plays the flinch as an upper-body layer over the gait, which is exactly this.
function _applyFlinch(rig, pose, dt) {
  const fl = (rig.flinchT > 0 && rig.flinch) ? rig.flinch[rig.flinchSeq] : null;
  if (!fl || !fl.frames || !fl.frames.length) { if (rig.flinchT > 0) rig.flinchT = 0; return pose; }
  const step = dt || 0.016;
  rig.flinchT -= step;
  const ffps = fl.fps > 0 ? fl.fps : 30, fN = fl.frames.length;
  rig.flinchFrame = Math.min((rig.flinchFrame || 0) + step * ffps, fN - 1);
  const fi = Math.floor(rig.flinchFrame), ffrac = rig.flinchFrame - fi;
  const flPose = _blendPose(fl.frames[fi], fl.frames[Math.min(fi + 1, fN - 1)], ffrac);
  const w = Math.max(0, Math.min(1, rig.flinchT / (rig.flinchDur || 0.22)));
  return _blendPose(pose, flPose, w);
}

const _plSkinTmp = new THREE.Vector3();
const _plHandTmp = new THREE.Vector3();

// ── Per-frame update for the LOCAL third-person model ───────────────────────
// Thin wrapper: pack the player globals into a state object and drive the shared
// animation core (also used for remote players in net.js).
function updatePlayerModel(dt) {
  if (!player.root) return;
  // Pure spectator has no body of their own — never render the local model.
  if (spectating) { player.root.visible = false; return; }
  player.root.visible = thirdPerson;
  if (!thirdPerson || !gsPos) return;
  // Dead → play our own death animation (held on the rig) and freeze the corpse, so the
  // pulled-back death cam shows it from third person (CS 1.6). No gait/aim/gun.
  if (typeof playerDead !== 'undefined' && playerDead) { _animateLocalDead(dt); return; }
  const w = (typeof curW === 'function') ? curW() : null;
  animateThirdPerson(player, {
    pos: gsPos, vel, yaw, pitch,
    onGround, duckAmount, phyDucked,
    weaponId: w ? w.id : null, weaponType: w ? w.type : null,
    ws: (typeof ws !== 'undefined') ? ws : 0,
    wsT: (typeof wsT !== 'undefined') ? wsT : 0,
  }, dt);
}

// ── Shared third-person animation core (local player + remote players) ──────
// rig : a model rig (mesh buffers from _buildRig + anim data from _initModelRig).
// st  : per-frame state — { pos[gs], vel[gs], yaw, pitch, onGround, duckAmount,
//       phyDucked, weaponId, weaponType, ws, wsT }. For the local player this comes
//       from the module globals; for a remote it comes from the interpolated snapshot.
// Drives gait + the upper-body aim/shoot/reload layer, skins the body, places it on
// the floor, attaches the held weapon and tints it by the map light. If the rig has
// per-bone OBB hitboxes (remotes), they're refreshed to the live pose for hit reg.
function animateThirdPerson(rig, st, dt) {
  if (!rig.root || !rig.bones) return;

  // Gait yaw: the root (torso) always faces the AIM, so the upper body never drifts
  // off-aim from movement. Only the LEGS get twisted toward the gait yaw (lags the
  // aim when turning, follows the movement direction). GoldSrc StudioProcessGait.
  _updateGaitYaw(rig, st, dt);                                   // updates rig.gaitYaw (legs)
  const legTwist = _angleDiff(rig.gaitYaw, st.yaw) * TWIST_SIGN; // legs relative to aim
  rig.root.rotation.y = st.yaw + Math.PI / 2;

  // ── Gait (legs): cross-fade stand↔crouch by duckAmount ───────────────────
  // The crouch is a smooth transition (ducktime), so blend the stand and crouch
  // locomotion poses instead of snapping at a threshold — otherwise the legs
  // popped between poses and the body appeared to float up/down out of the floor.
  const { stand, crouch } = _gaitNames(st);
  const standSeq  = rig.seqMap[stand]  || rig.seqMap.idle1;
  const crouchSeq = rig.seqMap[crouch] || standSeq;
  if (!standSeq?.frames.length) return;
  const d = Math.min(1, Math.max(0, st.duckAmount));

  // Advance one shared cycle phase at the dominant tier's speed-scaled rate.
  const domName = d > 0.5 ? crouch : stand;
  const domSeq  = d > 0.5 ? crouchSeq : standSeq;
  let fps = domSeq.fps > 0 ? domSeq.fps : 30;
  const base = _seqBaseSpeed[domName];
  if (base) fps *= Math.max(0.35, Math.min(2.2, Math.hypot(st.vel[0], st.vel[1]) / base));
  const dir = rig.gaitReverse ? -1 : 1;   // back-pedal plays the cycle in reverse
  const ph = rig.phase + dir * dt * fps / domSeq.frames.length;
  rig.phase = ph - Math.floor(ph);         // wrap to [0,1) (handles negative)

  // Build the final per-bone local pose in quaternions (everything slerped, no
  // euler-lerp glitches): legs = stand & crouch sampled at the shared phase and
  // blended by duckAmount; upper body = the weapon's aim/shoot/reload layer.
  const n = rig.bones.length;
  _ensureScratch(n);
  _sampleSeqQ(standSeq, rig.phase, _qS, _tS);
  if (d > 0) _sampleSeqQ(crouchSeq, rig.phase, _qC, _tC);
  const up = _resolveUpperPose(rig, st, dt);
  for (let b = 0; b < n; b++) {
    if (rig.upper[b]) {
      boneEulerQuat(up[b][3], up[b][4], up[b][5], _qF[b]);
      _tF[b][0] = up[b][0]; _tF[b][1] = up[b][1]; _tF[b][2] = up[b][2];
    } else if (d <= 0) {
      _qF[b].copy(_qS[b]); _tF[b][0] = _tS[b][0]; _tF[b][1] = _tS[b][1]; _tF[b][2] = _tS[b][2];
    } else if (d >= 1) {
      _qF[b].copy(_qC[b]); _tF[b][0] = _tC[b][0]; _tF[b][1] = _tC[b][1]; _tF[b][2] = _tC[b][2];
    } else {
      _qF[b].copy(_qS[b]).slerp(_qC[b], d);
      _tF[b][0] = _tS[b][0] + (_tC[b][0] - _tS[b][0]) * d;
      _tF[b][1] = _tS[b][1] + (_tC[b][1] - _tS[b][1]) * d;
      _tF[b][2] = _tS[b][2] + (_tC[b][2] - _tS[b][2]) * d;
    }
  }
  if (!rig._fkOut) rig._fkOut = { R: [], T: [] };
  const cur = _fkQ(rig.bones, _qF, _tF, legTwist, rig.twistMap, rig._fkOut);

  _skinRig(rig.meshes, rig.originalPositions, rig.boneIndices, rig.bones, cur, rig.bindWorld);

  // Vertical placement (analytic — no per-frame foot tracking, so no jitter/lag).
  // On the ground the real floor = the hull bottom: pos.z − 36 standing, − 18 with
  // the duck hull. The crouch pose pulls the feet ~18u toward the origin, so drop the
  // origin by 18·duckAmount to keep the soles on the floor across the whole
  // stand↔crouch blend. In the air the pose already matches the active hull
  // (jump↔stand, crouch↔duck), so the origin sits at pos.
  const floorZ = st.pos[2] - (st.phyDucked ? 18 : 36);
  const originY = st.onGround ? floorZ + 36 - 18 * d : st.pos[2];
  rig.root.position.set(st.pos[0], originY, -st.pos[1]);
  rig.root.updateMatrixWorld(true);   // hand/muzzle/hitbox world reads below need the fresh transform

  // Cache the right-hand world position for third-person shell ejection.
  if (rig.handBone !== undefined && cur.T[rig.handBone]) {
    const h = cur.T[rig.handBone];
    _plHandTmp.set(h.x, h.z, -h.y);         // GoldSrc model space → Three local
    rig.handWorld.copy(rig.root.localToWorld(_plHandTmp));
    rig.hasHandWorld = true;
  }

  _updateWeaponAttachment(rig, st, _qF, _tF);   // gun rides the torso → already on the aim, no twist
  _updateModelLight(rig, st, dt);               // tint by the map's baked light (darken in shadow)

  // Per-bone OBB hitboxes (remotes only) track the live pose so hit reg lines up.
  if (rig.hboxes && typeof _updateHitboxes === 'function') _updateHitboxes(rig, cur);
}

// Eject a shell from the third-person model's gun (world space), as in the
// original where you see other players' brass. Right-ish + up + slightly back.
function _ejectShellThirdPerson(wpn) {
  if (!player.hasHandWorld) return;
  const type = wpn.shellType ?? 'rifle';
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const right = new THREE.Vector3(cy, 0, -sy);   // player's right (world)
  const up    = new THREE.Vector3(0, 1, 0);
  const fwd   = new THREE.Vector3(-sy, 0, -cy);  // player's forward (world)
  const rv = () => (Math.random() - 0.5) * 2;
  const pos = player.handWorld.clone().addScaledVector(up, 3);
  const vel = new THREE.Vector3()
    .addScaledVector(right, 75 + rv() * 35)
    .addScaledVector(up,    85 + rv() * 25)
    .addScaledVector(fwd,  -10 + rv() * 25);
  _spawnShell(type, pos, vel);
}

// Skin a rig's vertices: v_new = R_cur · R_bind⁻¹ · (v − t_bind) + t_cur (GoldSrc
// space), with the Three↔GoldSrc axis swap. Shared by the player and the gun.
// Reusable skinning-matrix scratch (grown as needed). _skinRig runs one model fully
// before the next, so a single global pool is safe and avoids ~3 allocations per bone
// per model per frame (the old code cloned matrices — a major GC source with many models).
const _skinMpool = [], _skinTpool = [];
function _skinRig(meshes, origPositions, boneIndices, bones, cur, bind) {
  const nb = bones.length;
  // The bind pose's inverse rotation (transpose) never changes — cache it once per rig
  // instead of recomputing every frame.
  if (!bind._Rinv || bind._Rinv.length !== nb) {
    bind._Rinv = [];
    for (let b = 0; b < nb; b++) bind._Rinv[b] = bind.R[b].clone().transpose();
  }
  for (let b = _skinMpool.length; b < nb; b++) { _skinMpool.push(new THREE.Matrix4()); _skinTpool.push(new THREE.Vector3()); }
  for (let b = 0; b < nb; b++) {
    const M = _skinMpool[b].copy(cur.R[b]).multiply(bind._Rinv[b]);   // cur.R · bind.Rᵀ
    _skinTpool[b].copy(bind.T[b]).applyMatrix4(M);
    _skinTpool[b].subVectors(cur.T[b], _skinTpool[b]);
  }
  meshes.forEach((mesh, idx) => {
    const origPos = origPositions[idx], boneIdxArr = boneIndices[idx];
    if (!origPos || !boneIdxArr) return;
    const posAttr = mesh.geometry.getAttribute('position');
    const posArr = posAttr.array;
    for (let i = 0; i < origPos.length; i += 3) {
      const b = boneIdxArr[i / 3];
      if (b === undefined || b >= nb) {
        posArr[i] = origPos[i]; posArr[i+1] = origPos[i+1]; posArr[i+2] = origPos[i+2];
        continue;
      }
      _plSkinTmp.set(origPos[i], -origPos[i+2], origPos[i+1]);   // Three → GoldSrc
      _plSkinTmp.applyMatrix4(_skinMpool[b]).add(_skinTpool[b]);
      posArr[i]   =  _plSkinTmp.x;                                // GoldSrc → Three
      posArr[i+1] =  _plSkinTmp.z;
      posArr[i+2] = -_plSkinTmp.y;
    }
    posAttr.needsUpdate = true;
  });
}

// Drive the current weapon's skeleton with the player's pose (matched by bone
// name) and skin the gun mesh, so it tracks the hand. Bones the gun adds that the
// player lacks (muzzle/flash helpers) keep their own bind pose.
let _gScN = 0, _gq, _gt;
function _updateWeaponAttachment(rig, st, plQ, plT) {
  const id = st.weaponId;
  for (const k in rig.gunRigs) { const g = rig.gunRigs[k]; if (g) g.root.visible = (k === id); }
  const gun = _ensureGunRig(rig, id);   // lazy-load (remotes) / preloaded (local)
  if (!gun) return;                     // unknown weapon or still loading
  gun.root.visible = true;

  const N = gun.bones.length;
  if (_gScN !== N) {
    _gScN = N;
    _gq = Array.from({ length: N }, () => new THREE.Quaternion());
    _gt = Array.from({ length: N }, () => [0, 0, 0]);
  }
  // Shared bones take the model's current local pose (by name); bones the gun
  // adds (muzzle/flash) keep their own bind pose.
  for (let i = 0; i < N; i++) {
    const pj = rig.nameToIdx[gun.bones[i].name];
    if (pj !== undefined) {
      _gq[i].copy(plQ[pj]);
      _gt[i][0] = plT[pj][0]; _gt[i][1] = plT[pj][1]; _gt[i][2] = plT[pj][2];
    } else {
      const bf = gun.bindFrame[i];
      boneEulerQuat(bf[3], bf[4], bf[5], _gq[i]);
      _gt[i][0] = bf[0]; _gt[i][1] = bf[1]; _gt[i][2] = bf[2];
    }
  }
  if (!gun._fkOut) gun._fkOut = { R: [], T: [] };
  const cur = _fkQ(gun.bones, _gq, _gt, 0, null, gun._fkOut);
  _skinRig(gun.meshes, gun.originalPositions, gun.boneIndices, gun.bones, cur, gun.bindWorld);

  // Cache the muzzle ('flash' bone) world position for the third-person flash.
  if (gun.muzzleBone === undefined)
    gun.muzzleBone = gun.bones.findIndex(b => /flash|muzzle/i.test(b.name));
  if (gun.muzzleBone >= 0 && cur.T[gun.muzzleBone]) {
    const m = cur.T[gun.muzzleBone];
    _plHandTmp.set(m.x, m.z, -m.y);
    rig.muzzleWorld.copy(rig.root.localToWorld(_plHandTmp));
    rig.hasMuzzleWorld = true;
  }
}

// Fire the third-person muzzle flash at the cached gun muzzle.
function _muzzleFlashThirdPerson(wpn) {
  if (player.hasMuzzleWorld) _showFlashWorld(player.muzzleWorld, wpn);
}

// ── Model lighting from the map (GoldSrc R_LightPoint) ──────────────────────
// Trace down to the floor and read the baked lightmap (the map's vertex colors),
// then tint the player + active gun materials with it so the model darkens in
// shadow and brightens in light, as in the original. Smoothed to avoid flicker.
const _DOWN = new THREE.Vector3(0, -1, 0);
const _lightOrigin = new THREE.Vector3();
const _lightRay = new THREE.Raycaster();
function _updateModelLight(rig, st, dt) {
  if (!st.pos || !_shellRayTargets) return;
  // Re-sample the baked floor light only a few times a second (it changes slowly and is
  // smoothed anyway) — raycasting the whole map per model every frame is the expensive
  // bit with many players. Cache the last sample and just keep easing toward it.
  rig._lightT = (rig._lightT || 0) - dt;
  if (rig._lightT <= 0 || rig._lightSample === undefined) {
    rig._lightT = 0.15 + Math.random() * 0.1;   // ~6–8 Hz, desynced across models
    _lightOrigin.set(st.pos[0], st.pos[2] + 16, -st.pos[1]);
    _lightRay.set(_lightOrigin, _DOWN);
    _lightRay.far = 4096;
    const hits = _lightRay.intersectObjects(_shellRayTargets, false);
    let r = 1, g = 1, b = 1;
    const hit = hits.length ? hits[0] : null;
    if (hit && hit.face) {
      const col = hit.object.geometry.getAttribute('color');
      if (col) {
        const f = hit.face;
        r = (col.getX(f.a) + col.getX(f.b) + col.getX(f.c)) / 3;
        g = (col.getY(f.a) + col.getY(f.b) + col.getY(f.c)) / 3;
        b = (col.getZ(f.a) + col.getZ(f.b) + col.getZ(f.c)) / 3;
      }
    }
    rig._lightSample = [r, g, b];
  }
  const [sr, sg, sb] = rig._lightSample;
  const k = 1 - Math.exp(-8 * dt);
  rig.lightCol.r += (sr - rig.lightCol.r) * k;
  rig.lightCol.g += (sg - rig.lightCol.g) * k;
  rig.lightCol.b += (sb - rig.lightCol.b) * k;
  for (const m of rig.meshes) m.material.color.copy(rig.lightCol);
  const gun = rig.gunRigs[st.weaponId];
  if (gun) for (const m of gun.meshes) m.material.color.copy(rig.lightCol);
}

// ── Chase camera: pull the FPS camera back behind the eye ───────────────────
// Called after the FPS yaw/pitch are applied. Uses a backward trace so the
// camera doesn't clip through walls.
function updateChaseCamera() {
  if (!thirdPerson || !gsPos) { camera.position.set(0, 0, 0); return; }
  // First-person spectate: sit exactly at the eye (no pull-back).
  if (typeof _specEye !== 'undefined' && _specEye) { camera.position.set(0, 0, 0); return; }
  // Focus the chase on the spectated player while dead (_camFocus), else on ourselves.
  const focus = (typeof _camFocus !== 'undefined' && _camFocus) ? _camFocus : gsPos;
  let dist = THIRD_DIST;
  // Trace from the eye straight back along the camera's (fixed, arrow-orbited)
  // angle — independent of mouse-look, matching yawObj/pitchObj in the render loop.
  const az = orbitYaw, el = orbitPitch;
  const eyeH = (focus === gsPos) ? (SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand)) : SV.eyestand;
  const cp = Math.cos(el), sp = Math.sin(el);
  const from = [focus[0], focus[1], focus[2] + eyeH];
  const bx = Math.sin(az) * cp, by = -Math.cos(az) * cp, bz = sp;   // backward dir
  const to = [from[0] + bx * dist, from[1] + by * dist, from[2] + bz * dist];
  if (gPlanes) {
    const tr = traceMove(from, to);
    if (tr.fraction < 1) dist = Math.max(20, dist * tr.fraction - 8);
  }
  camera.position.set(0, THIRD_UP, dist);   // local +z = behind (camera looks −z)
}

function toggleThirdPerson(on) {
  thirdPerson = (on === undefined) ? !thirdPerson : on;
  if (thirdPerson && typeof resetScope === 'function') resetScope();   // no scope in 3rd person

  // Park the camera behind the player's current facing; it then stays fixed while
  // the mouse turns the player. Arrow keys re-orbit it.
  orbitYaw = (typeof yaw === 'number' && isFinite(yaw)) ? yaw : 0;
  orbitPitch = 0;
  const cb = document.getElementById('opt-third-person');
  if (cb) cb.checked = thirdPerson;
}

// ── Death cam + spectator (CS 1.6) ──────────────────────────────────────────
// On death the view pulls back into third person to show our own death animation
// (_animateLocalDead), then follows living players until we respawn at the next round.
// Reuses the third-person camera (orbit + updateChaseCamera) with the focus point
// redirected to the spectated player via _camFocus. Driven from input.js while playerDead.
let _specMode = null;            // null | 'deathanim' | 'spectate'
let _specStart = 0;              // performance.now() when the death cam began
let _specTarget = null;          // remote id we're following
let _camFocus = null;            // [x,y,z] gs focus for the chase cam (null → own gsPos)
let _thirdPersonPref = false;    // user's own 3rd-person toggle, restored on respawn
let _specCam = 0;                // spectator camera mode: 0 free-3rd, 1 locked-3rd, 2 first-person
let _specEye = false;            // first-person spectate → updateChaseCamera parks at the eye
let spectating = false;          // pure spectator (chose "Наблюдатель" in the menu — no body)
const SPEC_DEATH_HOLD = 3200;    // ms to watch our own death animation before spectating (CS-ish)

// Enter pure spectator mode (menu "Наблюдатель"): no body, go straight to following players.
function _beginSpectate() {
  spectating = true;
  _thirdPersonPref = thirdPerson;
  thirdPerson = true;
  if (typeof resetScope === 'function') resetScope();
  _specMode = 'spectate'; _specCam = 0; _specTarget = null; _camFocus = null; _specEye = false;
  if (player) player.deathSeq = null;
  specCycle(0);
}

// Leave spectator mode (picked a team) — restore view + the avatars we hid.
function _endSpectate() {
  if (!spectating) return;
  spectating = false;
  _specMode = null; _specTarget = null; _camFocus = null; _specEye = false; _specCam = 0;
  _setSpectatorHud('');
  if (typeof _specVmExit === 'function') _specVmExit();
  if (typeof remotePlayers !== 'undefined') for (const o of remotePlayers.values()) if (o.root) o.root.visible = true;
  thirdPerson = _thirdPersonPref;
  smoothCamY = null;
}

// Cycle the spectator camera mode (Space while spectating): free 3rd → locked 3rd → 1st person.
function cycleSpecCam() {
  if (_specMode !== 'spectate') return;
  _specCam = (_specCam + 1) % 3;
}

// Enter the death cam: force 3rd person, pick our corpse's death sequence by hitgroup, and
// freeze the corpse facing. Called from game.js _enterDeath on the alive→dead edge.
function _beginDeathCam(hg, straightSpectate) {
  _thirdPersonPref = thirdPerson;
  thirdPerson = true;
  if (typeof resetScope === 'function') resetScope();          // no scope while dead/spectating
  orbitYaw   = (typeof yaw === 'number' && isFinite(yaw)) ? yaw : 0;
  orbitPitch = -0.15;
  _specStart = (typeof performance !== 'undefined') ? performance.now() : 0;
  _specTarget = null; _camFocus = null;
  if (straightSpectate) {
    // Sidelined by a mid-round join / team change — no corpse of ours to watch, so go straight
    // to spectating the living players (the "waiting for next round" observer view).
    _specMode = 'spectate'; _specCam = 0;
    if (player) player.deathSeq = null;
    specCycle(0);
  } else {
    _specMode = 'deathanim';
    if (player) {
      player._deathYaw = (typeof yaw === 'number') ? yaw : 0;   // corpse facing, frozen
      player.deathSeq  = (typeof _pickDeathSeq === 'function') ? _pickDeathSeq(player, hg | 0) : null;
      player.frame = 0;
    }
  }
}

// Leave the death cam (respawn): restore the player's own view preference.
function _endDeathCam() {
  _specMode = null; _specTarget = null; _camFocus = null; _specEye = false; _specCam = 0;
  _setSpectatorHud('');
  if (typeof _specVmExit === 'function') _specVmExit();          // restore our own viewmodel/weapon
  // Restore any avatars we hid for the first-person spectate cam.
  if (typeof remotePlayers !== 'undefined')
    for (const o of remotePlayers.values()) if (o.root) o.root.visible = true;
  thirdPerson = _thirdPersonPref;
  const cb = (typeof document !== 'undefined') && document.getElementById('opt-third-person');
  if (cb) cb.checked = thirdPerson;
  if (player) { player.deathSeq = null; player.frame = 0; }
}

// Cycle the spectated player (dir +1/-1) among living, rendered remotes.
function specCycle(dir) {
  if (typeof remotePlayers === 'undefined') { _specTarget = null; return; }
  const ids = [];
  for (const inst of remotePlayers.values()) if (inst && inst.ready && !inst.dead) ids.push(inst.id);
  if (!ids.length) { _specTarget = null; return; }
  let i = ids.indexOf(_specTarget);
  i = (i < 0) ? 0 : (i + (dir || 1) + ids.length) % ids.length;
  _specTarget = ids[i];
}

// Per-frame death/spectator camera. While the death anim plays we chase our own corpse; once it
// finishes (after SPEC_DEATH_HOLD) we spectate a living player in one of three camera modes
// (Space cycles): 0 free 3rd-person (mouse orbits), 1 locked behind the player, 2 first-person
// through their eyes (their weapon-in-hand + animation render forward of the eye). Called from
// the main loop while playerDead.
function updateDeathCam(dt) {
  if (!gsPos) return;
  const now = (typeof performance !== 'undefined') ? performance.now() : 0;
  if (_specMode === 'deathanim') {
    const seq = player && player.deathSeq && player.seqMap[player.deathSeq];
    const animDone = seq ? (player.frame >= seq.frames.length - 1) : true;
    if ((now - _specStart > SPEC_DEATH_HOLD) && animDone) { _specMode = 'spectate'; specCycle(0); }
  }

  // Resolve the spectated player (skip to the next if ours died/left).
  let inst = null;
  if (_specMode === 'spectate') {
    inst = (_specTarget != null && typeof remotePlayers !== 'undefined') ? remotePlayers.get(_specTarget) : null;
    if (!inst || inst.dead || !inst.ready) { specCycle(1); inst = (_specTarget != null) ? remotePlayers.get(_specTarget) : null; }
  }

  _specEye = false;
  let focus = gsPos, eyeH = SV.eyestand;
  if (_specMode === 'spectate' && inst && inst.pos) {
    focus = inst.pos;
    eyeH = SV.eyestand + (inst.da || 0) * (SV.eyeduck - SV.eyestand);
    if (_specCam === 2) {            // first-person: look exactly where they look, camera at eye
      _specEye = true;
      orbitYaw = inst.yaw; orbitPitch = (typeof inst.pitch === 'number') ? inst.pitch : 0;
    } else if (_specCam === 1) {     // locked behind: camera fixed at their back, slightly above
      orbitYaw = inst.yaw; orbitPitch = -0.18;
    } else {                         // free: mouse orbits around them
      if (typeof yaw === 'number')   orbitYaw   = yaw;
      if (typeof pitch === 'number') orbitPitch = Math.max(-1.2, Math.min(1.2, pitch));
    }
  } else {
    // Death anim (or no one to follow): free orbit around our own corpse.
    if (typeof yaw === 'number')   orbitYaw   = yaw;
    if (typeof pitch === 'number') orbitPitch = Math.max(-1.2, Math.min(1.2, pitch));
  }
  _camFocus = (focus === gsPos) ? null : [focus[0], focus[1], focus[2]];

  const fy = _camFocus || gsPos;
  const targetY = fy[2] + eyeH;
  if (smoothCamY === null) smoothCamY = targetY;
  // First-person follows tightly (no smoothing lag); 3rd-person eases.
  smoothCamY += (targetY - smoothCamY) * (_specEye ? 1 : Math.min(1, dt * 8));
  yawObj.position.set(fy[0], smoothCamY, -fy[1]);

  // First-person: hide the spectated player's whole third-person avatar and instead render a
  // REAL viewmodel of their weapon (vmScene), driven by their ws/wsT — exactly like the local
  // player's gun. Other modes show everyone normally.
  if (_specEye && inst) {
    if (typeof _specVmEnter === 'function') _specVmEnter();
    if (typeof _specVmUpdate === 'function') _specVmUpdate(inst.weapon, inst.ws, inst.wsT, inst.vel, inst.og, dt);
  } else if (typeof _specVmExit === 'function') {
    _specVmExit();
  }
  if (typeof remotePlayers !== 'undefined')
    for (const o of remotePlayers.values()) if (o.root) o.root.visible = !(_specEye && o === inst);

  _updateSpectatorHud(inst);
}

// Spectator HUD: who we're watching + the controls, mirrored to a small banner.
function _updateSpectatorHud(inst) {
  if (_specMode !== 'spectate') { _setSpectatorHud(''); return; }
  const my = (typeof netMyId === 'function') ? netMyId() : null;
  const who = inst ? (inst.id === my ? 'Вы' : `${(inst.team || '').toUpperCase()}#${inst.id}`)
                   : (inst === null ? '—' : '');
  const mode = ['Свободная камера', 'Камера сзади', 'От 1-го лица'][_specCam] || '';
  _setSpectatorHud(`👁 Наблюдение: <b>${who || '—'}</b> · ${mode}<br><span class="spec-keys">ЛКМ/ПКМ — игрок · Пробел — камера</span>`);
}
function _setSpectatorHud(html) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('spectator');
  if (!el) return;
  if (!html) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
  el.innerHTML = html; el.style.display = 'block';
}

// Render our corpse: play the death sequence once (hold the last frame), frozen in place.
// Mirrors net.js _updateRemoteDead but for the local player rig.
function _animateLocalDead(dt) {
  const rig = player;
  if (!rig.bones || !rig.seqMap) return;
  const seq = (rig.deathSeq && rig.seqMap[rig.deathSeq]) || rig.seqMap.idle1;
  if (!seq || !seq.frames.length) return;
  const fps = seq.fps > 0 ? seq.fps : 30, N = seq.frames.length;
  rig.frame = Math.min((rig.frame || 0) + dt * fps, N - 1);
  const i = Math.floor(rig.frame), frac = rig.frame - i, next = Math.min(i + 1, N - 1);
  const cur = computeBoneWorlds(rig.bones, seq.frames[i], (frac > 0.001 && next > i) ? seq.frames[next] : null, frac);
  rig.root.rotation.y = (rig._deathYaw || 0) + Math.PI / 2;
  rig.root.position.set(gsPos[0], gsPos[2], -gsPos[1]);
  rig.root.updateMatrixWorld(true);
  _skinRig(rig.meshes, rig.originalPositions, rig.boneIndices, rig.bones, cur, rig.bindWorld);
  for (const k in rig.gunRigs) { const g = rig.gunRigs[k]; if (g && g.root) g.root.visible = false; }   // drop the gun
}
