// enemy.js — T-model target dummies near the CT spawn for testing hits + death.
// Classic script, shares global scope. Reuses the player rig helpers
// (_buildRig/_skinRig from player.js, computeBoneWorlds from weapons.js).
//
// Damage model mirrors CS 1.6: per-weapon base damage with distance falloff
// (damage *= rangeMod^(dist/500)), hitgroup multipliers (head ×4, stomach ×1.25,
// legs ×0.75), kevlar armor absorbing torso/arm hits, plus bullet PENETRATION:
// one shot pierces dummies lined up behind each other, losing power per body.
// A lethal blow plays the death anim matching the zone (head→'head', stomach→
// 'gutshot', else death1/2/3); a non-lethal hit plays a brief flinch.

const ENEMY_MODEL   = 'leet';     // T slot 2 "Elite Crew" (player_leet.json, with --deaths). 'terror' = slot 1.
// Static practice dummies removed for the multiplayer move (Phase 5): real networked players
// take their place. The instance machinery below (rig build, per-bone OBB hitboxes, hitscan,
// damage, death anims) is KEPT and reused by net.js to render/score remote players.
const ENEMY_COUNT   = 0;          // 0 = no standing dummies (was 3)
const ENEMY_DIST    = 240;        // units in front of the CT spawn (nearest dummy)
const ENEMY_SPACING = 52;         // forward gap between dummies (for penetration)
const ENEMY_LATERAL = 16;         // sideways stagger so all are visible
const DEATH_HOLD    = 4;          // seconds lying dead before respawn
const ENEMY_HEALTH  = 100;        // CS default
const ENEMY_ARMOR   = 100;        // kevlar (no helmet → head/legs unprotected)
const PEN_MULT      = 0.6;        // damage retained after piercing one body

// Hitgroups + CS 1.6 damage multipliers (HLSDK/ReGameDLL): head 1 ×4, chest 2 ×1,
// stomach 3 ×1.25, arms 4/5 ×1, legs 6/7 ×0.75, generic 0 ×1.
const _HG_MULT  = { 0: 1, 1: 4, 2: 1, 3: 1.25, 4: 1, 5: 1, 6: 0.75, 7: 0.75 };
const _HG_LABEL = { 0: 'ТЕЛО', 1: 'ГОЛОВА', 2: 'ГРУДЬ', 3: 'ЖИВОТ', 4: 'РУКА', 5: 'РУКА', 6: 'НОГИ', 7: 'НОГИ' };

// Hitboxes are the ORIGINAL CS 1.6 per-bone oriented boxes (mstudiobbox_t), extracted
// straight from the MDL into player_<model>.json by tools/player_to_json.py. Each is
// {bone, group(hitgroup), bmin, bmax} in bone-local GoldSrc space — we transform the
// box by the live bone world matrix (so it tracks the animated pose) and ray-test it
// as an OBB. We use the standard body hitgroups 1–7; group ≥8 (a non-standard oversized
// "weapon" box on the hand in some models) is skipped — see docs/DIFFERENCES.md.

const enemies = [];     // all dummy instances
let enemyFocus = null;  // the most-recently-hit dummy (drives the HUD readout)

const _enemyRay   = new THREE.Raycaster();
const _enemyFrom  = new THREE.Vector3();
const _enemyDir   = new THREE.Vector3();
const _enemyTmp   = new THREE.Vector3();
const _enemyDownFrom = new THREE.Vector3();
const _DOWNV = new THREE.Vector3(0, -1, 0);

function _makeEnemyInstance() {
  return {
    root: null, meshes: null, originalPositions: null, boneIndices: null,
    bones: null, seqMap: null, flinch: null, bindWorld: null,   // shared model data
    state: 'idle', curSeq: 'idle1', frame: 0, deadTime: 0,
    health: ENEMY_HEALTH, armor: ENEMY_ARMOR, helmet: false,
    flinchSeq: null, flinchT: 0, flinchDur: 0.22, flinchFrame: 0,
    lastHit: null, gsPos: null, faceYaw: null,
    hitboxData: null, hboxes: null, debugMeshes: null,
  };
}

// Deferred: loaded at "Start" with the other game assets (tracked for the screen).
let _enemyLoaded = false;
function loadEnemy() {
  if (_enemyLoaded) return;
  _enemyLoaded = true;
  if (ENEMY_COUNT <= 0) return;          // no static dummies — networked players are spawned by net.js
  _trackFetchStart();
  fetch(`models/player_${ENEMY_MODEL}.json`).then(r => r.json()).then(data => {
    // Model data shared across instances; each instance gets its own skinned rig.
    const seqMap = {};
    data.sequences.forEach(s => { seqMap[s.name] = s; });
    const flinch = data.flinch || {};
    const bind = data.sequences.find(s => s.name === (data.bindSeq || 'idle1')) || data.sequences[0];
    const bindWorld = computeBoneWorlds(data.bones, bind.frames[0], null, 0);
    const idleN = seqMap['idle1']?.frames.length || 1;
    for (let i = 0; i < ENEMY_COUNT; i++) {
      const inst = _makeEnemyInstance();
      if (USE_GPU_SKIN) {
        const sk = _buildEnemySkinned(data);
        inst.root = new THREE.Group();               // position/facing anchor (not rendered)
        inst.meshes = sk.meshes; inst.skinBones = sk.bones; inst.skeleton = sk.skeleton;
      } else {
        const rig = _buildRig(data.meshes);
        scene.add(rig.root);
        inst.root = rig.root; inst.meshes = rig.meshes;
        inst.originalPositions = rig.originalPositions; inst.boneIndices = rig.boneIndices;
      }
      inst.bones = data.bones; inst.seqMap = seqMap; inst.flinch = flinch; inst.bindWorld = bindWorld;
      inst.hitboxData = data.hitboxes || [];
      inst.helmet = (i === 1);                        // middle dummy wears kevlar + helmet (the rest: kevlar only)
      inst.frame = Math.random() * idleN;            // desync idle breathing
      _placeEnemy(inst, i);
      enemies.push(inst);
    }
    console.log(`Enemy model loaded: ${data.name} ×${ENEMY_COUNT}`);
    _trackFetchEnd();
  }).catch(err => { _trackFetchEnd(); console.warn('enemy model not loaded:', err); });
}

// Place a dummy in a receding, slightly staggered row, facing the player, feet on the floor.
function _placeEnemy(inst, i) {
  if (!inst.root || !gsSpawn) return;
  const fx = -Math.sin(gsSpawnYaw), fy = Math.cos(gsSpawnYaw);   // GoldSrc forward
  const rx = fy, ry = -fx;                                        // GoldSrc right (perp)
  const dist = ENEMY_DIST + i * ENEMY_SPACING;
  const lat  = (i - (ENEMY_COUNT - 1) / 2) * ENEMY_LATERAL;
  const ex = gsSpawn[0] + fx * dist + rx * lat;
  const ey = gsSpawn[1] + fy * dist + ry * lat;
  let floorZ = gsSpawn[2] - 36;
  if (_shellRayTargets) {
    _enemyDownFrom.set(ex, gsSpawn[2] + 64, -ey);
    _enemyRay.set(_enemyDownFrom, _DOWNV); _enemyRay.far = 4096;
    const hits = _enemyRay.intersectObjects(_shellRayTargets, false);
    if (hits.length) {
      floorZ = hits[0].point.y;
      if (hits[0].face) {                       // tint to the baked floor light, like the player
        const col = hits[0].object.geometry.getAttribute('color');
        if (col) {
          const f = hits[0].face;
          const r = (col.getX(f.a) + col.getX(f.b) + col.getX(f.c)) / 3;
          const g = (col.getY(f.a) + col.getY(f.b) + col.getY(f.c)) / 3;
          const b = (col.getZ(f.a) + col.getZ(f.b) + col.getZ(f.c)) / 3;
          inst.meshes.forEach(m => m.material.color.setRGB(r, g, b));
        }
      }
    }
  }
  inst.root.position.set(ex, floorZ + 36, -ey);
  inst.root.rotation.y = (gsSpawnYaw + Math.PI) + Math.PI / 2;   // face back toward the player
  inst.gsPos  = [ex, ey, floorZ];
  inst.faceYaw = gsSpawnYaw + Math.PI;

  // Per-bone OBB hitboxes from the original MDL. Each box lives in its bone's local
  // space (bmin/bmax); we compose its world matrix from the live bone transform so it
  // follows the animated pose. Standard body hitgroups 1–7 only (see header note).
  inst.root.updateMatrixWorld(true);
  if (inst.skinBones) {   // GPU: place the skeleton at this spot so the bind hitboxes land right
    const bindF = (inst.seqMap[inst.curSeq] || inst.seqMap['idle1']).frames[0];
    _setEnemyBonesGPU(inst, bindF, null, 0);
    inst.meshes[0].updateMatrixWorld(true);
  }
  _buildInstanceHitboxes(inst);
  _updateHitboxes(inst, inst.bindWorld);   // initial boxes (idle bind pose)
  inst.health = ENEMY_HEALTH; inst.armor = ENEMY_ARMOR;
}

// Build the per-bone OBB hitbox list (inst.hboxes) from inst.hitboxData, plus the
// debug wireframes. Shared by the static dummies (_placeEnemy) and the networked
// remote players (net.js _buildRemote) so the hit model stays identical.
function _buildInstanceHitboxes(inst) {
  inst.hboxes = [];
  for (const h of (inst.hitboxData || [])) {
    if (h.group < 1 || h.group > 7) continue;     // skip non-standard oversized boxes
    const cx = (h.bmin[0] + h.bmax[0]) / 2, cy = (h.bmin[1] + h.bmax[1]) / 2, cz = (h.bmin[2] + h.bmax[2]) / 2;
    inst.hboxes.push({
      hg: h.group, bone: h.bone, bmin: h.bmin, bmax: h.bmax,
      size: [h.bmax[0] - h.bmin[0], h.bmax[1] - h.bmin[1], h.bmax[2] - h.bmin[2]],
      centerMat: new THREE.Matrix4().makeTranslation(cx, cy, cz),
      M: new THREE.Matrix4(),
    });
  }
  _buildHitboxDebug(inst);
}

// GoldSrc (x,y,z Z-up) → three (x, z, −y) axis swap as a matrix, and the bone→world
// composition. Each hitbox world matrix M = rootWorld · S · [Rbone | Tbone], so a
// box-local point maps straight to three-world space.
const _GS2THREE = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1,
);
const _boneMat = new THREE.Matrix4();

// Recompose every hitbox's world matrix from the current animated bone transforms,
// so the boxes track the live pose (idle breathing, death, flinch). Cheap: reuses the
// bone matrices already computed for skinning. Root is static after placement.
function _updateHitboxes(inst, bw) {
  if (!inst.hboxes) return;
  if (inst.skinBones) {
    // GPU path: the bone's world matrix already maps its GoldSrc-local frame to Three
    // world (placement + swap are baked into the skeleton), so the box uses it directly.
    for (const h of inst.hboxes) {
      const wm = inst.skinBones[h.bone] && inst.skinBones[h.bone].matrixWorld;
      if (wm) h.M.copy(wm);
    }
  } else {
    const rootM = inst.root.matrixWorld;
    for (const h of inst.hboxes) {
      const Rb = bw.R[h.bone], Tb = bw.T[h.bone];
      if (!Rb) continue;
      _boneMat.copy(Rb); _boneMat.setPosition(Tb.x, Tb.y, Tb.z);
      h.M.copy(rootM).multiply(_GS2THREE).multiply(_boneMat);
    }
  }
  if ((typeof showHitboxes !== 'undefined') && showHitboxes && inst.debugMeshes)
    for (let i = 0; i < inst.hboxes.length; i++) {
      const h = inst.hboxes[i];
      inst.debugMeshes[i].matrix.copy(h.M).multiply(h.centerMat);
    }
}

// Wireframe OBB per bone hitbox — toggled by the "Показать хитбоксы" setting
// (showHitboxes). Purely visual: excluded from hitscan. The box geometry is the
// bone-local size; per frame its matrix is set to M·translate(center).
const _HG_DBGCOL = { 0: 0xcccccc, 1: 0xff4040, 2: 0xffe04a, 3: 0xff9030, 4: 0x40ff80, 5: 0x40ff80, 6: 0x60a0ff, 7: 0x60a0ff };
function _buildHitboxDebug(inst) {
  if (inst.debugMeshes) inst.debugMeshes.forEach(m => { scene.remove(m); m.geometry.dispose(); });
  const on = (typeof showHitboxes !== 'undefined') && showHitboxes;
  inst.debugMeshes = inst.hboxes.map(h => {
    const geo = new THREE.BoxGeometry(h.size[0], h.size[1], h.size[2]);
    const mat = new THREE.MeshBasicMaterial({
      color: _HG_DBGCOL[h.hg] || 0xffffff, wireframe: true,
      transparent: true, opacity: 0.55, fog: false, toneMapped: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.userData.noHitscan = true;
    m.matrixAutoUpdate = false;
    m.matrix.copy(h.M).multiply(h.centerMat);
    m.visible = on;
    scene.add(m);
    return m;
  });
}

function setHitboxDebug(on) {
  for (const inst of enemies)
    if (inst.debugMeshes) for (const m of inst.debugMeshes) m.visible = on;
  if (typeof remotePlayers !== 'undefined')
    for (const inst of remotePlayers.values())
      if (inst.debugMeshes) for (const m of inst.debugMeshes) m.visible = on;
}

// Ray vs oriented box: transform the ray into the box's local space (M⁻¹), then a
// plain slab test against the axis-aligned [bmin,bmax]. The direction is transformed
// un-normalised so the returned t is the distance along the original (unit) world
// ray. Returns the entry distance, or Infinity on a miss.
const _obbO = new THREE.Vector3(), _obbP = new THREE.Vector3(), _obbMinv = new THREE.Matrix4();
function _rayOBB(O, D, h) {
  _obbMinv.copy(h.M).invert();
  _obbO.copy(O).applyMatrix4(_obbMinv);                       // ray origin → box-local
  _obbP.copy(O).add(D).applyMatrix4(_obbMinv);                // O+D → box-local
  const o = [_obbO.x, _obbO.y, _obbO.z];
  const d = [_obbP.x - _obbO.x, _obbP.y - _obbO.y, _obbP.z - _obbO.z];
  const bmin = h.bmin, bmax = h.bmax;
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < bmin[i] || o[i] > bmax[i]) return Infinity;  // parallel & outside the slab
    } else {
      let t1 = (bmin[i] - o[i]) / d[i], t2 = (bmax[i] - o[i]) / d[i];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  if (tmax < 0) return Infinity;                              // box fully behind the eye
  return tmin >= 0 ? tmin : tmax;                             // tmin<0 → eye inside the box
}

// Per-bone euler-frame lerp (pre-interpolate within a sequence before a quaternion blend).
function _lerpPose(a, b, w) {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i], o = new Array(6);
    for (let d = 0; d < 6; d++) o[d] = ai[d] + (bi[d] - ai[d]) * w;
    out[i] = o;
  }
  return out;
}

// ── Per-frame: advance every dummy ──────────────────────────────────────────
// ── GPU skinning (THREE.SkinnedMesh) ─────────────────────────────────────────
// The GPU does the vertex transform in the shader (bones as uniforms) — no per-frame
// CPU vertex loop and no vertex-buffer re-upload, so many models stay cheap (like the
// original engine). Per frame we only set each bone's local transform. Kept behind a
// flag with the CPU path as fallback while it's verified visually.
//   Setup that avoids the classic double-transform pitfall: the SkinnedMesh sits at the
//   scene origin (identity) and ALL placement — world position, facing yaw, and the
//   GoldSrc(Z-up)→Three(Y-up) swap — is baked into the ROOT bone each frame. Child bones
//   carry only their raw GoldSrc local pose, so bone.matrixWorld maps a GoldSrc-local
//   point straight to Three world (hitboxes just read it).
let USE_GPU_SKIN = true;   // ← set to false to fall back to CPU skinning
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _qSwap  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _skTmpV = new THREE.Vector3();
const _skQA = new THREE.Quaternion(), _skQB = new THREE.Quaternion(), _skQYaw = new THREE.Quaternion();

// Shared skinned geometry per model (positions/normals as stored = Three space, +
// per-vertex skinIndex/weight for 1-bone GoldSrc rigid skinning). Cached on the data.
function _skinnedGeos(data) {
  if (data._skinGeos) return data._skinGeos;
  data._skinGeos = data.meshes.map(m => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(m.positions), 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(m.uvs, 2));
    const n = m.positions.length / 3;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i * 4] = m.boneIndices[i] || 0; sw[i * 4] = 1; }   // 1 bone, weight 1
    geo.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    geo.setIndex(m.indices);
    geo.computeBoundingSphere();
    return { geo, texFile: m.texFile };
  });
  return data._skinGeos;
}

function _buildEnemySkinned(data) {
  const geos = _skinnedGeos(data);
  const bones = data.bones.map(() => new THREE.Bone());
  const bindSeq = data.sequences.find(s => s.name === (data.bindSeq || 'idle1')) || data.sequences[0];
  const bindFrame = bindSeq.frames[0];
  // Bind pose at ORIGIN (no world placement): root gets only the GoldSrc→Three swap so
  // the skeleton binds upright in Three space; children get their raw local pose.
  data.bones.forEach((bd, i) => {
    const f = bindFrame[i];
    if (bd.parent < 0) {
      bones[i].position.set(f[0], f[1], f[2]).applyQuaternion(_qSwap);
      boneEulerQuat(f[3], f[4], f[5], bones[i].quaternion); bones[i].quaternion.premultiply(_qSwap);
    } else {
      bones[i].position.set(f[0], f[1], f[2]);
      boneEulerQuat(f[3], f[4], f[5], bones[i].quaternion);
      bones[bd.parent].add(bones[i]);
    }
  });
  const meshes = geos.map(g => {
    const mat = new THREE.MeshLambertMaterial({ map: _plTexLoader.load(g.texFile), side: THREE.DoubleSide });
    const sm = new THREE.SkinnedMesh(g.geo, mat);
    sm.frustumCulled = false; sm.userData.noHitscan = true;
    scene.add(sm);                       // at origin; placement lives in the root bone
    return sm;
  });
  meshes[0].add(bones[0]);               // skeleton root under the first mesh
  for (let i = 1; i < bones.length; i++) if (data.bones[i].parent < 0) meshes[0].add(bones[i]);
  meshes[0].updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  meshes.forEach(sm => sm.bind(skeleton));
  return { bones, skeleton, meshes, bindFrame };
}

// Set every bone from a blended pose (frameA→frameB by t). The root bone additionally
// carries the swap + this instance's world position/facing so the mesh can stay at origin.
function _setEnemyBonesGPU(inst, fA, fB, t) {
  const bones = inst.skinBones, defs = inst.bones;
  const yaw = inst.root.rotation.y, wp = inst.root.position;
  _skQYaw.setFromAxisAngle(_Y_AXIS, yaw);
  for (let i = 0; i < bones.length; i++) {
    const a = fA[i], b = (fB && t > 0) ? fB[i] : null;
    let px, py, pz;
    if (b) {
      px = a[0] + (b[0] - a[0]) * t; py = a[1] + (b[1] - a[1]) * t; pz = a[2] + (b[2] - a[2]) * t;
      boneEulerQuat(a[3], a[4], a[5], _skQA); boneEulerQuat(b[3], b[4], b[5], _skQB); _skQA.slerp(_skQB, t);
    } else {
      px = a[0]; py = a[1]; pz = a[2]; boneEulerQuat(a[3], a[4], a[5], _skQA);
    }
    const bone = bones[i];
    if (defs[i].parent < 0) {
      _skTmpV.set(px, py, pz).applyQuaternion(_qSwap).applyAxisAngle(_Y_AXIS, yaw);
      bone.position.set(wp.x + _skTmpV.x, wp.y + _skTmpV.y, wp.z + _skTmpV.z);
      bone.quaternion.copy(_skQA).premultiply(_qSwap).premultiply(_skQYaw);
    } else {
      bone.position.set(px, py, pz); bone.quaternion.copy(_skQA);
    }
  }
}

// CPU skinning is the per-frame cost, so only skin models the camera can actually see:
// cull offscreen ones (frustum) and skin distant ones at half rate. A model that isn't
// updated just holds its last pose — invisible while offscreen, negligible while far.
const _enemyFrustum = new THREE.Frustum();
const _enemyFrustMat = new THREE.Matrix4();
const _enemyCullSphere = new THREE.Sphere(new THREE.Vector3(), 80);
const _FAR_SKIN2 = 1600 * 1600;   // beyond this (squared), skin every other frame
let _enemyTick = 0;
function updateEnemy(dt) {
  _enemyTick++;
  const cam = (typeof camera !== 'undefined') ? camera : null;
  if (!cam) { for (const inst of enemies) _updateEnemyInstance(inst, dt); return; }
  cam.updateMatrixWorld();
  _enemyFrustMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _enemyFrustum.setFromProjectionMatrix(_enemyFrustMat);
  for (let i = 0; i < enemies.length; i++) {
    const inst = enemies[i];
    if (!inst.root || !inst.meshes) continue;
    _enemyCullSphere.center.copy(inst.root.position); _enemyCullSphere.radius = 80;
    const visible = _enemyFrustum.intersectsSphere(_enemyCullSphere);
    for (const m of inst.meshes) m.visible = visible;   // cull the DRAW too (offscreen → not rendered/skinned)
    if (!visible) continue;                              // offscreen → don't skin either
    const dx = inst.root.position.x - cam.position.x,
          dy = inst.root.position.y - cam.position.y,
          dz = inst.root.position.z - cam.position.z;
    if (dx * dx + dy * dy + dz * dz > _FAR_SKIN2 && ((_enemyTick + i) & 1)) continue;   // far → half rate
    _updateEnemyInstance(inst, dt);
  }
}

function _updateEnemyInstance(inst, dt) {
  if (!inst.root) return;
  const seq = inst.seqMap[inst.curSeq];
  if (!seq?.frames.length) return;
  const fps = seq.fps > 0 ? seq.fps : 30;
  const N = seq.frames.length;
  let fA, fB, t;   // the animated pose is lerp(fA, fB, t) (fB null → just fA)

  if (inst.state === 'idle') {
    inst.frame = (inst.frame + dt * fps) % N;
    const i = Math.floor(inst.frame) % N;
    const frac = inst.frame - Math.floor(inst.frame);
    const next = (i + 1) % N;
    const fl = inst.flinchT > 0 && inst.flinch ? inst.flinch[inst.flinchSeq] : null;
    if (fl) {                      // blend idle ↔ flinch by the flinch weight
      inst.flinchT -= dt;
      const ffps = fl.fps > 0 ? fl.fps : 30, fN = fl.frames.length;
      inst.flinchFrame = Math.min(inst.flinchFrame + dt * ffps, fN - 1);
      const fi = Math.floor(inst.flinchFrame), ffrac = inst.flinchFrame - fi;
      const fnext = Math.min(fi + 1, fN - 1);
      fA = _lerpPose(seq.frames[i], seq.frames[next], frac);
      fB = _lerpPose(fl.frames[fi], fl.frames[fnext], ffrac);
      t  = Math.max(0, inst.flinchT / inst.flinchDur);
    } else {
      inst.flinchT = 0;
      fA = seq.frames[i]; fB = frac > 0.001 ? seq.frames[next] : null; t = frac;
    }
  } else {                         // dead: play once, hold last frame, then respawn
    inst.frame = Math.min(inst.frame + dt * fps, N - 1);
    inst.deadTime += dt;
    if (inst.deadTime > DEATH_HOLD) { _enemyRespawn(inst); return; }
    const i = Math.floor(inst.frame) % N;
    const frac = inst.frame - Math.floor(inst.frame);
    const next = Math.min(i + 1, N - 1);
    fA = seq.frames[i]; fB = (frac > 0.001 && next > i) ? seq.frames[next] : null; t = frac;
  }

  if (inst.skinBones) {            // GPU: just set the bones, the shader skins
    _setEnemyBonesGPU(inst, fA, fB, t);
    inst.meshes[0].updateMatrixWorld(true);   // make bone matrices current for hitboxes
    _updateHitboxes(inst, null);
  } else {                         // CPU: compute bone worlds + rewrite vertices
    if (!inst._boneOut) inst._boneOut = { R: [], T: [] };
    const cur = computeBoneWorlds(inst.bones, fA, fB, t, inst._boneOut);
    _skinRig(inst.meshes, inst.originalPositions, inst.boneIndices, inst.bones, cur, inst.bindWorld);
    _updateHitboxes(inst, cur);
  }
}

function _enemyRespawn(inst) {
  inst.state = 'idle'; inst.curSeq = 'idle1'; inst.frame = 0; inst.deadTime = 0;
  inst.health = ENEMY_HEALTH; inst.armor = ENEMY_ARMOR;
  inst.flinchT = 0; inst.lastHit = null;
}

// HE-grenade blast: linear falloff from the blast origin (GoldSrc), blocked by walls
// (LOS trace). Armor soaks part of blast damage. Called from grenades.js.
function enemyRadiusDamage(origin, baseDmg, radius) {
  if (typeof traceMove !== 'function') return;
  for (const inst of enemies) {
    if (inst.state === 'dead' || !inst.gsPos) continue;
    const cx = inst.gsPos[0], cy = inst.gsPos[1], cz = inst.gsPos[2] + 36;   // center mass
    const dx = cx - origin[0], dy = cy - origin[1], dz = cz - origin[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > radius) continue;
    const tr = traceMove([origin[0], origin[1], origin[2]], [cx, cy, cz]);
    if (tr.fraction < 0.7) continue;                       // wall mostly blocks the blast
    let dmg = baseDmg * (1 - dist / radius);               // linear falloff
    if (inst.armor > 0) {                                  // kevlar soaks ~half the blast
      const absorbed = Math.min(inst.armor, dmg * 0.5);
      inst.armor -= absorbed; dmg -= absorbed;
    }
    dmg = Math.max(0, Math.round(dmg));
    if (dmg <= 0) continue;
    inst.health -= dmg;
    inst.lastHit = { dmg, hg: 0, t: performance.now() };
    enemyFocus = inst;
    if (inst.health <= 0) { inst.health = 0; _enemyDie(inst, 0); }
    else                  { _enemyFlinch(inst, 0); }
  }
}

// Kevlar (no helmet): absorbs chest/stomach/arm hits only; head & legs go straight to HP.
function _armorAbsorb(inst, dmg, hg) {
  // Kevlar covers torso/arms; a helmet additionally covers the head (hg 1).
  const covered = (hg === 2 || hg === 3 || hg === 4 || hg === 5) || (hg === 1 && inst.helmet);
  if (inst.armor <= 0 || !covered) return dmg;
  const RATIO = 0.5, BONUS = 0.5;       // CS mp_armorratio / armor bonus
  let toHealth = dmg * RATIO;
  let toArmor  = (dmg - toHealth) * BONUS;
  if (toArmor > inst.armor) {
    toArmor = inst.armor / BONUS;
    toHealth = dmg - toArmor;
    inst.armor = 0;
  } else {
    inst.armor -= toArmor;
  }
  return Math.max(0, toHealth);
}

// Knife backstab (CS): the attacker's aim points the same way the target faces
// (dot of the two forward vectors > 0.8) — i.e. you're stabbing them in the back.
function _isBackstab(inst) {
  if (inst.faceYaw == null) return false;
  const pfx = -Math.sin(yaw), pfy = Math.cos(yaw);            // player aim forward
  const tfx = -Math.sin(inst.faceYaw), tfy = Math.cos(inst.faceYaw);  // target forward
  return (pfx * tfx + pfy * tfy) > 0.8;
}

function _enemyDamage(inst, opts, hg, dist, point, penMult) {
  let dmg = opts.damage ?? 0;
  if (opts.melee) {
    if (_isBackstab(inst)) dmg *= (opts.backstabMult ?? 3);   // ×3 stabbing the back
  } else {
    dmg *= Math.pow(opts.rangeMod ?? 0.98, dist / 500);       // distance falloff
    dmg *= penMult;                                           // power lost piercing earlier bodies
  }
  dmg *= (_HG_MULT[hg] ?? 1);     // hitgroup multiplier — CS applies it to the knife too (TraceAttack)
  // Kevlar absorbs the hit if it covers this zone (torso/arm) and there's armor left.
  const armorAbsorbed = inst.armor > 0 && (hg === 2 || hg === 3 || hg === 4 || hg === 5);
  dmg = _armorAbsorb(inst, dmg, hg);
  dmg = Math.max(0, Math.round(dmg));
  inst.health -= dmg;
  inst.lastHit = { dmg, hg, t: performance.now() };
  enemyFocus = inst;
  // Victim hit sound (bullets only — the knife plays its own flesh/wall hits).
  // No helmet on the dummy yet, so a head hit is a headshot (pass inst.helmet for later).
  if (!opts.melee && typeof playVictimHit === 'function') playVictimHit(hg, armorAbsorbed, inst.helmet, dist);
  if (typeof _spawnBlood === 'function') _spawnBlood(point, _enemyDir, dmg, hg);
  if (inst.health <= 0) { inst.health = 0; _enemyDie(inst, hg); }
  else                  { _enemyFlinch(inst, hg); }
}

function _enemyFlinch(inst, hg) {
  if (!inst.flinch) return;
  const seqName = (hg === 1 && inst.flinch['head_flinch']) ? 'head_flinch' : 'gut_flinch';
  if (!inst.flinch[seqName]) return;
  inst.flinchSeq = seqName; inst.flinchFrame = 0; inst.flinchT = inst.flinchDur;
}

function _enemyDie(inst, hg) {
  if (inst.state === 'dead') return;
  let name;
  if (hg === 1 && inst.seqMap['head'])         name = 'head';
  else if (hg === 3 && inst.seqMap['gutshot']) name = 'gutshot';
  else {
    const deaths = ['death1', 'death2', 'death3'].filter(n => inst.seqMap[n]);
    name = deaths.length ? deaths[Math.floor(Math.random() * deaths.length)] : 'idle1';
  }
  inst.curSeq = name; inst.state = 'dead'; inst.frame = 0; inst.deadTime = 0;
  inst.flinchT = 0;
}

// Raycast the current aim against every dummy and apply damage. Bullets pierce
// dummies in order of distance, losing PEN_MULT of power per body; the knife hits
// only the nearest. Returns true if any dummy was hit (so the caller can add blood).
// opts: { damage, rangeMod } for bullets, or { melee:true, damage, backstabMult }.
function enemyTryShoot(maxDist, opts) {
  if (!gsPos) return false;
  opts = opts || {};
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  // Same scattered trajectory as the wall decal (opts.dyaw/dpitch = this shot's spread cone),
  // so bullet spread actually deflects hits — a sprayed burst misses, a first tap lands.
  const P = pitch + punchPitch + recoilPitch + (opts.dpitch || 0), Y = yaw + recoilYaw + (opts.dyaw || 0);
  const cp = Math.cos(P), sp = Math.sin(P);
  _enemyFrom.set(gsPos[0], gsPos[2] + eyeH, -gsPos[1]);
  _enemyDir.set(-cp * Math.sin(Y), sp, -cp * Math.cos(Y)).normalize();
  _enemyRay.set(_enemyFrom, _enemyDir); _enemyRay.far = maxDist;

  // This shot's ray in GoldSrc space, derived from the THREE ray we aim with
  // (three → gs: (x,y,z)→(x,−z,y)) so the server tests the very same trajectory.
  const oGs = [gsPos[0], gsPos[1], gsPos[2] + eyeH];
  const dGs = [_enemyDir.x, -_enemyDir.z, _enemyDir.y];

  // Multiplayer bullets: the server does the authoritative, lag-compensated hitreg; the
  // local pass below is only our blood/sound/hitmarker PREDICTION. We predict against
  // remotes with the SAME stance box-stack the server uses (combat-core), so a predicted
  // hit matches the authoritative one (no phantom blood / silent misses).
  if (!opts.melee && typeof netSendShot === 'function') netSendShot(oGs, dGs, opts.wid, opts.sil);

  // First solid wall along the same aim — nothing past it can be hit.
  const wall = (typeof hitCheck === 'function') ? hitCheck(maxDist) : null;
  const wallDist = wall ? wall.fraction * maxDist : maxDist;

  // Nearest bone hitbox (OBB) per live practice dummy (local-only; not networked).
  const hits = [];
  for (const inst of enemies) {
    if (!inst.root || inst.state === 'dead' || !inst.hboxes) continue;
    let best = Infinity, hg = -1;
    for (const h of inst.hboxes) {
      const t = _rayOBB(_enemyFrom, _enemyDir, h);
      if (t < best) { best = t; hg = h.hg; }
    }
    if (hg >= 0 && best <= maxDist && best <= wallDist + 1) {
      const pt = _enemyFrom.clone().addScaledVector(_enemyDir, best);
      hits.push({ inst, kind: 'enemy', hg, dist: best, point: pt });
    }
  }
  // Networked remote players: predict with the server's box-stack so it agrees with the
  // authoritative result (combat-core, GoldSrc space, distance is frame-invariant).
  if (typeof remotePlayers !== 'undefined' && typeof combatRayHitPlayer === 'function') {
    for (const inst of remotePlayers.values()) {
      if (!inst.ready || !inst.root || inst.dead || !inst.pos) continue;   // can't hit a corpse
      const r = combatRayHitPlayer(oGs, dGs, inst.pos, !!inst.dk);
      if (r && r.dist <= maxDist && r.dist <= wallDist + 1) {
        const pt = _enemyFrom.clone().addScaledVector(_enemyDir, r.dist);
        hits.push({ inst, kind: 'remote', hg: r.hg, dist: r.dist, point: pt });
      }
    }
  }
  if (!hits.length) return false;
  hits.sort((a, b) => a.dist - b.dist);

  const apply = (h, penMult) => (h.kind === 'remote')
    ? _remoteDamage(h.inst, opts, h.hg, h.dist, h.point, penMult)
    : _enemyDamage(h.inst, opts, h.hg, h.dist, h.point, penMult);

  if (opts.melee) {                                     // knife: nearest only
    apply(hits[0], 1);
    return true;
  }
  let penMult = 1;                                      // bullet: pierce in order
  for (const h of hits) {
    apply(h, penMult);
    penMult *= PEN_MULT;
  }
  return true;
}

// Damage on a networked remote player. HP/armor live on the VICTIM's client, so we
// only compute the pre-armor damage (weapon × falloff × penetration × hitgroup) and
// route it to the server (which forwards it to the victim, who applies kevlar). Local
// feedback — blood + the victim-hit sound — fires here so the shooter sees the hit.
function _remoteDamage(inst, opts, hg, dist, point, penMult) {
  let dmg = opts.damage ?? 0;
  if (opts.melee) {
    if (inst.yaw != null) {                            // backstab: aim aligned with target's facing
      const pfx = -Math.sin(yaw), pfy = Math.cos(yaw);
      const tfx = -Math.sin(inst.yaw), tfy = Math.cos(inst.yaw);
      if (pfx * tfx + pfy * tfy > 0.8) dmg *= (opts.backstabMult ?? 3);
    }
  } else {
    dmg *= Math.pow(opts.rangeMod ?? 0.98, dist / 500); // distance falloff
    dmg *= penMult;                                     // power lost piercing earlier bodies
  }
  dmg *= (_HG_MULT[hg] ?? 1);
  dmg = Math.max(0, Math.round(dmg));
  if (!opts.melee && typeof playVictimHit === 'function') playVictimHit(hg, false, false, dist);
  if (typeof _spawnBlood === 'function') _spawnBlood(point, _enemyDir, dmg, hg);
  // Damage delivery: BULLETS are server-authoritative (the shot ray was already sent to
  // the server in enemyTryShoot — it rewinds + computes damage). The KNIFE stays
  // shooter-reported here (close range, server has no melee model yet). The blood/sound
  // above are local prediction either way.
  if (opts.melee && dmg > 0 && typeof netSendHit === 'function') netSendHit(inst.id, hg, dmg);
}
