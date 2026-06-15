// player.js — third-person player model (CT model "gign", chooseteam 2→4).
// Classic script — shares one global scope with the other src/*.js. No imports.
//
// Loads models/player_<PLAYER_MODEL>.json (mesh + bones + movement sequences
// exported by tools/player_to_json.py) into the WORLD scene and skins it every
// frame using the same matrix-skinning math as the view models (computeBoneWorlds
// + boneEulerQuat live in weapons.js). Only visible when third-person is enabled.

// Which player model to show (matches a models/player_<name>.json bundle).
const PLAYER_MODEL = 'gign';

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

// Deferred: called once at "Start" so the ~2 MB player bundle isn't fetched on page load.
let _playerLoaded = false;
function loadPlayerModel() {
  if (_playerLoaded) return;
  _playerLoaded = true;
  _trackFetchStart();
  fetch(`models/player_${PLAYER_MODEL}.json`).then(r => r.json()).then(data => {
  const rig = _buildRig(data.meshes);
  rig.root.visible = false;
  scene.add(rig.root);

  player.root = rig.root;
  player.meshes = rig.meshes;
  player.bones = data.bones;
  player.originalPositions = rig.originalPositions;
  player.boneIndices = rig.boneIndices;
  const bindSeq = data.sequences.find(s => s.name === (data.bindSeq || 'idle1')) || data.sequences[0];
  player.bindWorld = computeBoneWorlds(data.bones, bindSeq.frames[0], null, 0);
  player.idlePose = bindSeq.frames[0];   // neutral local pose for the upper body
  player.aimSets = data.aimSets || {};   // upper-body aim/shoot/reload per weapon class
  player.seqMap = {};                    // name → gait sequence
  data.sequences.forEach(s => { player.seqMap[s.name] = s; });
  player.phase = 0;                      // normalized locomotion cycle phase [0,1)

  // Upper/lower split. "Lower" (gait-driven) = ONLY the leg chains (anything that
  // descends from a thigh). Everything else — pelvis, spine, arms, head — is
  // "upper" (aim-driven). Keeping the PELVIS upper is key: the walk/run sequences
  // rotate the pelvis (hip turn), and since the spine is its child that rotation
  // would leak into the torso (a fixed sideways shift whenever moving). With the
  // pelvis on the aim, the torso stays put and only the legs animate.
  const lThigh = data.bones.findIndex(b => b.name === 'Bip01 L Thigh');
  const rThigh = data.bones.findIndex(b => b.name === 'Bip01 R Thigh');
  player.upper = data.bones.map((_, i) => {
    for (let j = i; j >= 0; j = data.bones[j].parent) if (j === lThigh || j === rThigh) return false;
    return true;
  });

  // Bone-name → index map (for cross-skinning the world weapon onto this skeleton).
  player.nameToIdx = {};
  data.bones.forEach((b, i) => { player.nameToIdx[b.name] = i; });
  player.twistMap = _legTwistMap(data.bones);   // gait-yaw: legs twist, torso holds the aim
  player.handBone = player.nameToIdx['Bip01 R Hand'];   // shell-ejection point

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
const _gunRigs = {};                                  // weapon id → rig
const _GUN_FILES = { m4: 'models/p_m4a1.json', usp: 'models/p_usp.json', knife: 'models/p_knife.json' };

function _loadGunRigs() {
  for (const [id, file] of Object.entries(_GUN_FILES)) {
    _trackFetchStart();
    fetch(file).then(r => r.json()).then(data => {
      const rig = _buildRig(data.meshes);
      rig.root.visible = false;
      player.root.add(rig.root);   // ride along with the player model's transform
      _gunRigs[id] = {
        id, root: rig.root, meshes: rig.meshes,
        originalPositions: rig.originalPositions, boneIndices: rig.boneIndices,
        bones: data.bones, bindFrame: data.bindFrame,
        bindWorld: computeBoneWorlds(data.bones, data.bindFrame, null, 0),
      };
      _trackFetchEnd();
    }).catch(err => { _trackFetchEnd(); console.warn(`gun rig ${file} not loaded:`, err); });
  }
}

// Stand / crouch locomotion sequence names for the current speed & ground state.
function _gaitNames() {
  const spd = Math.hypot(vel[0], vel[1]);
  const stand  = !onGround ? 'jump'        : (spd > 140 ? 'run' : spd > 12 ? 'walk' : 'idle1');
  const crouch = !onGround ? 'crouch_idle' : (spd > 12 ? 'crouchrun' : 'crouch_idle');
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
function _fkQ(bones, q, t, twistRad, twistMap) {
  const R = [], T = [];
  for (let i = 0; i < bones.length; i++) {
    const mat = new THREE.Matrix4().makeRotationFromQuaternion(q[i]);
    const tr = new THREE.Vector3(t[i][0], t[i][1], t[i][2]);
    const par = bones[i].parent;
    if (par >= 0 && R[par]) { mat.premultiply(R[par]); tr.applyMatrix4(R[par]).add(T[par]); }
    if (twistRad && twistMap) { const m = twistMap.get(i); if (m) mat.premultiply(_twistMat.makeRotationZ(twistRad * m)); }
    R.push(mat); T.push(tr);
  }
  return { R, T };
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
function _updateGaitYaw(dt) {
  if (player.gaitYaw == null) player.gaitYaw = yaw;
  const spd = Math.hypot(vel[0], vel[1]);
  let reverse = false;
  if (onGround && spd > 12) {
    let moveYaw = Math.atan2(-vel[0], vel[1]);   // legs face the movement direction
    // Back-pedal (GoldSrc): if moving away from the aim by >120°, face the legs
    // toward the aim and play the gait cycle in reverse, instead of turning the
    // legs around (which would look like walking sideways/backwards-facing).
    if (Math.abs(_angleDiff(moveYaw, yaw)) > _BACKPEDAL) { moveYaw += Math.PI; reverse = true; }
    player.gaitYaw = _easeAngle(player.gaitYaw, moveYaw, 1 - Math.exp(-12 * dt));
  } else {
    player.gaitYaw = _easeAngle(player.gaitYaw, yaw, 1 - Math.exp(-5 * dt));  // legs catch up to aim
  }
  // Clamp the legs to within TWIST_LIMIT of the aim (the torso twist limit).
  const twist = _angleDiff(yaw, player.gaitYaw);
  if (twist >  TWIST_LIMIT) player.gaitYaw = yaw - TWIST_LIMIT;
  if (twist < -TWIST_LIMIT) player.gaitYaw = yaw + TWIST_LIMIT;
  player.gaitReverse = reverse;
}

// Native speed each locomotion cycle was authored for — used to scale playback
// to the actual ground speed so the feet stop sliding.
const _seqBaseSpeed = { walk: CONFIG.walkspeed, run: CONFIG.maxspeed, crouchrun: CONFIG.crouchspeed };

// ── Upper-body aim/shoot/reload layer ───────────────────────────────────────
const _AIM_SET = { m4: 'carbine', usp: 'onehanded', knife: 'knife' };
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
function _aimPose(aim) {
  const [s, e] = aim.range;
  let pd = AIM_PITCH_SIGN * pitch * 180 / Math.PI;
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
function _clipPosePitched(clip, t) {
  if (!clip.blends) return _clipPose(clip, t);
  const [s, e] = clip.range;
  let pd = AIM_PITCH_SIGN * pitch * 180 / Math.PI;
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
function _resolveUpperPose(dt) {
  const wpn = (typeof curW === 'function') ? curW() : null;
  const set = wpn ? player.aimSets[_AIM_SET[wpn.id]] : null;
  if (!set) return player.idlePose;
  const ducked = phyDucked || duckAmount > 0.5;
  const aim = (ducked && set.crouchAim) ? set.crouchAim : set.aim;
  const base = aim ? _aimPose(aim) : player.idlePose;   // pitch-aimed hold pose

  // Resolve the active gesture (if any) layered over the aimed base.
  let gesture = null;
  const firing = (wpn.type === 'gun' && ws === WS.FIRE) || ws === WS.SLASH || ws === WS.STAB;
  if (firing) {
    const clip = (ducked && set.crouchShoot) ? set.crouchShoot : set.shoot;
    // Guns: small recoil → additive over the aim. Melee: play the REAL swing
    // absolutely, pitch-blended (additive would flail a big swing).
    if (clip) gesture = (wpn.type === 'gun') ? _addGesture(base, clip, wsT) : _clipPosePitched(clip, wsT);
  } else if (ws === WS.RELOAD) {
    const clip = (ducked && set.crouchReload) ? set.crouchReload : set.reload;
    if (clip) gesture = _addGesture(base, clip, wsT);
  }

  // Ease aim↔gesture so the torso doesn't snap its angle at attack start/end (the
  // aim-hold and the swing are different poses; the engine cross-fades too). Blend
  // out from the last gesture pose for a moment after the gesture ends.
  if (gesture) player._lastGesture = gesture;
  const target = gesture ? 1 : 0;
  player._upperMix = (player._upperMix == null) ? target
    : player._upperMix + (target - player._upperMix) * (1 - Math.exp(-18 * (dt || 0.016)));
  if (player._upperMix < 0.002 || !player._lastGesture) return base;
  return _blendPose(base, player._lastGesture, player._upperMix);
}

const _plSkinTmp = new THREE.Vector3();
const _plHandTmp = new THREE.Vector3();

// ── Per-frame update (called from the render loop) ──────────────────────────
function updatePlayerModel(dt) {
  if (!player.root) return;
  player.root.visible = thirdPerson;
  if (!thirdPerson || !gsPos) return;

  // Gait yaw: the root (torso) always faces the AIM, so the upper body never drifts
  // off-aim from movement. Only the LEGS get twisted toward the gait yaw (lags the
  // aim when turning, follows the movement direction). GoldSrc StudioProcessGait.
  _updateGaitYaw(dt);                                            // updates player.gaitYaw (legs)
  const legTwist = _angleDiff(player.gaitYaw, yaw) * TWIST_SIGN; // legs relative to aim
  player.root.rotation.y = yaw + Math.PI / 2;

  // ── Gait (legs): cross-fade stand↔crouch by duckAmount ───────────────────
  // The crouch is a smooth transition (ducktime), so blend the stand and crouch
  // locomotion poses instead of snapping at a threshold — otherwise the legs
  // popped between poses and the body appeared to float up/down out of the floor.
  const { stand, crouch } = _gaitNames();
  const standSeq  = player.seqMap[stand]  || player.seqMap.idle1;
  const crouchSeq = player.seqMap[crouch] || standSeq;
  if (!standSeq?.frames.length) return;
  const d = Math.min(1, Math.max(0, duckAmount));

  // Advance one shared cycle phase at the dominant tier's speed-scaled rate.
  const domName = d > 0.5 ? crouch : stand;
  const domSeq  = d > 0.5 ? crouchSeq : standSeq;
  let fps = domSeq.fps > 0 ? domSeq.fps : 30;
  const base = _seqBaseSpeed[domName];
  if (base) fps *= Math.max(0.35, Math.min(2.2, Math.hypot(vel[0], vel[1]) / base));
  const dir = player.gaitReverse ? -1 : 1;   // back-pedal plays the cycle in reverse
  const ph = player.phase + dir * dt * fps / domSeq.frames.length;
  player.phase = ph - Math.floor(ph);         // wrap to [0,1) (handles negative)

  // Build the final per-bone local pose in quaternions (everything slerped, no
  // euler-lerp glitches): legs = stand & crouch sampled at the shared phase and
  // blended by duckAmount; upper body = the weapon's aim/shoot/reload layer.
  const n = player.bones.length;
  _ensureScratch(n);
  _sampleSeqQ(standSeq, player.phase, _qS, _tS);
  if (d > 0) _sampleSeqQ(crouchSeq, player.phase, _qC, _tC);
  const up = _resolveUpperPose(dt);
  for (let b = 0; b < n; b++) {
    if (player.upper[b]) {
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
  const cur = _fkQ(player.bones, _qF, _tF, legTwist, player.twistMap);

  _skinRig(player.meshes, player.originalPositions, player.boneIndices, player.bones, cur, player.bindWorld);

  // Vertical placement (analytic — no per-frame foot tracking, so no jitter/lag).
  // On the ground the real floor = the hull bottom: gsPos.z − 36 standing, − 18
  // with the duck hull. The crouch pose pulls the feet ~18u toward the origin, so
  // drop the origin by 18·duckAmount to keep the soles on the floor across the
  // whole stand↔crouch blend. In the air the pose already matches the active hull
  // (jump↔stand, crouch↔duck), so the origin sits at gsPos.
  const floorZ = gsPos[2] - (phyDucked ? 18 : 36);
  const originY = onGround ? floorZ + 36 - 18 * d : gsPos[2];
  player.root.position.set(gsPos[0], originY, -gsPos[1]);

  // Cache the right-hand world position for third-person shell ejection.
  if (player.handBone !== undefined && cur.T[player.handBone]) {
    player.root.updateMatrixWorld();
    const h = cur.T[player.handBone];
    _plHandTmp.set(h.x, h.z, -h.y);         // GoldSrc model space → Three local
    player.handWorld.copy(player.root.localToWorld(_plHandTmp));
    player.hasHandWorld = true;
  }

  _updateWeaponAttachment(_qF, _tF);   // gun rides the torso → already on the aim, no twist
  _updateModelLight(dt);               // tint by the map's baked light (darken in shadow)
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
function _skinRig(meshes, origPositions, boneIndices, bones, cur, bind) {
  const skinM = [], skinT = [];
  for (let b = 0; b < bones.length; b++) {
    const M = cur.R[b].clone().multiply(bind.R[b].clone().transpose());
    const t = bind.T[b].clone().applyMatrix4(M);
    t.subVectors(cur.T[b], t);
    skinM.push(M); skinT.push(t);
  }
  meshes.forEach((mesh, idx) => {
    const origPos = origPositions[idx], boneIdxArr = boneIndices[idx];
    if (!origPos || !boneIdxArr) return;
    const posAttr = mesh.geometry.getAttribute('position');
    const posArr = posAttr.array;
    for (let i = 0; i < origPos.length; i += 3) {
      const b = boneIdxArr[i / 3];
      if (b === undefined || !skinM[b]) {
        posArr[i] = origPos[i]; posArr[i+1] = origPos[i+1]; posArr[i+2] = origPos[i+2];
        continue;
      }
      _plSkinTmp.set(origPos[i], -origPos[i+2], origPos[i+1]);   // Three → GoldSrc
      _plSkinTmp.applyMatrix4(skinM[b]).add(skinT[b]);
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
function _updateWeaponAttachment(plQ, plT) {
  const id = (typeof curW === 'function' && curW()) ? curW().id : null;
  for (const k in _gunRigs) _gunRigs[k].root.visible = (k === id);
  const rig = _gunRigs[id];
  if (!rig) return;

  const N = rig.bones.length;
  if (_gScN !== N) {
    _gScN = N;
    _gq = Array.from({ length: N }, () => new THREE.Quaternion());
    _gt = Array.from({ length: N }, () => [0, 0, 0]);
  }
  // Shared bones take the player's current local pose (by name); bones the gun
  // adds (muzzle/flash) keep their own bind pose.
  for (let i = 0; i < N; i++) {
    const pj = player.nameToIdx[rig.bones[i].name];
    if (pj !== undefined) {
      _gq[i].copy(plQ[pj]);
      _gt[i][0] = plT[pj][0]; _gt[i][1] = plT[pj][1]; _gt[i][2] = plT[pj][2];
    } else {
      const bf = rig.bindFrame[i];
      boneEulerQuat(bf[3], bf[4], bf[5], _gq[i]);
      _gt[i][0] = bf[0]; _gt[i][1] = bf[1]; _gt[i][2] = bf[2];
    }
  }
  const cur = _fkQ(rig.bones, _gq, _gt);
  _skinRig(rig.meshes, rig.originalPositions, rig.boneIndices, rig.bones, cur, rig.bindWorld);

  // Cache the muzzle ('flash' bone) world position for the third-person flash.
  if (rig.muzzleBone === undefined)
    rig.muzzleBone = rig.bones.findIndex(b => /flash|muzzle/i.test(b.name));
  if (rig.muzzleBone >= 0 && cur.T[rig.muzzleBone]) {
    const m = cur.T[rig.muzzleBone];
    _plHandTmp.set(m.x, m.z, -m.y);
    player.root.updateMatrixWorld();
    player.muzzleWorld.copy(player.root.localToWorld(_plHandTmp));
    player.hasMuzzleWorld = true;
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
function _updateModelLight(dt) {
  if (!gsPos || !_shellRayTargets) return;
  _lightOrigin.set(gsPos[0], gsPos[2] + 16, -gsPos[1]);
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
  const k = 1 - Math.exp(-8 * dt);
  player.lightCol.r += (r - player.lightCol.r) * k;
  player.lightCol.g += (g - player.lightCol.g) * k;
  player.lightCol.b += (b - player.lightCol.b) * k;
  for (const m of player.meshes) m.material.color.copy(player.lightCol);
  const id = (typeof curW === 'function' && curW()) ? curW().id : null;
  const rig = _gunRigs[id];
  if (rig) for (const m of rig.meshes) m.material.color.copy(player.lightCol);
}

// ── Chase camera: pull the FPS camera back behind the eye ───────────────────
// Called after the FPS yaw/pitch are applied. Uses a backward trace so the
// camera doesn't clip through walls.
function updateChaseCamera() {
  if (!thirdPerson || !gsPos) { camera.position.set(0, 0, 0); return; }
  let dist = THIRD_DIST;
  // Trace from the eye straight back along the camera's (fixed, arrow-orbited)
  // angle — independent of mouse-look, matching yawObj/pitchObj in the render loop.
  const az = orbitYaw, el = orbitPitch;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const cp = Math.cos(el), sp = Math.sin(el);
  const from = [gsPos[0], gsPos[1], gsPos[2] + eyeH];
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
  // Park the camera behind the player's current facing; it then stays fixed while
  // the mouse turns the player. Arrow keys re-orbit it.
  orbitYaw = (typeof yaw === 'number' && isFinite(yaw)) ? yaw : 0;
  orbitPitch = 0;
  const cb = document.getElementById('opt-third-person');
  if (cb) cb.checked = thirdPerson;
}
