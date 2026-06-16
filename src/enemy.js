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
const ENEMY_COUNT   = 3;          // dummies in a receding row
const ENEMY_DIST    = 240;        // units in front of the CT spawn (nearest dummy)
const ENEMY_SPACING = 52;         // forward gap between dummies (for penetration)
const ENEMY_LATERAL = 16;         // sideways stagger so all are visible
const DEATH_HOLD    = 4;          // seconds lying dead before respawn
const ENEMY_HEALTH  = 100;        // CS default
const ENEMY_ARMOR   = 100;        // kevlar (no helmet → head/legs unprotected)
const PEN_MULT      = 0.6;        // damage retained after piercing one body

// Hitgroups + CS 1.6 damage multipliers (head 1, chest 2, stomach 3, arm 4, legs 6).
const _HG_MULT  = { 1: 4, 2: 1, 3: 1.25, 4: 1, 6: 0.75 };
const _HG_LABEL = { 1: 'ГОЛОВА', 2: 'ГРУДЬ', 3: 'ЖИВОТ', 4: 'РУКА', 6: 'НОГИ' };

// Per-bone capsule hitboxes (like CS): a segment between two bones + radius, mapped
// to a hitgroup. Bones are matched by NAME (indices differ between models). The 'head'
// flag extends the capsule beyond the head bone to cover the skull.
const _CAP_DEFS = [
  { hg: 3, a: 'Bip01 Pelvis',    b: 'Bip01 Spine1',  r: 7.5 },          // stomach
  { hg: 2, a: 'Bip01 Spine1',    b: 'Bip01 Neck',    r: 9.0 },          // chest
  { hg: 1, a: 'Bip01 Head',      b: 'Bip01 Neck',    r: 5.0, head: true }, // head
  { hg: 4, a: 'Bip01 L UpperArm', b: 'Bip01 L Forearm', r: 4.0 },
  { hg: 4, a: 'Bip01 L Forearm',  b: 'Bip01 L Hand',    r: 3.5 },
  { hg: 4, a: 'Bip01 R UpperArm', b: 'Bip01 R Forearm', r: 4.0 },
  { hg: 4, a: 'Bip01 R Forearm',  b: 'Bip01 R Hand',    r: 3.5 },
  { hg: 6, a: 'Bip01 L Thigh',   b: 'Bip01 L Calf',  r: 5.5 },
  { hg: 6, a: 'Bip01 L Calf',    b: 'Bip01 L Foot',  r: 4.5 },
  { hg: 6, a: 'Bip01 R Thigh',   b: 'Bip01 R Calf',  r: 5.5 },
  { hg: 6, a: 'Bip01 R Calf',    b: 'Bip01 R Foot',  r: 4.5 },
];

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
    health: ENEMY_HEALTH, armor: ENEMY_ARMOR,
    flinchSeq: null, flinchT: 0, flinchDur: 0.22, flinchFrame: 0,
    lastHit: null, gsPos: null, faceYaw: null,
    caps: null, boneIdx: null, debugMeshes: null,
  };
}

// Deferred: loaded at "Start" with the other game assets (tracked for the screen).
let _enemyLoaded = false;
function loadEnemy() {
  if (_enemyLoaded) return;
  _enemyLoaded = true;
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
      const rig = _buildRig(data.meshes);
      scene.add(rig.root);
      const inst = _makeEnemyInstance();
      inst.root = rig.root; inst.meshes = rig.meshes;
      inst.originalPositions = rig.originalPositions; inst.boneIndices = rig.boneIndices;
      inst.bones = data.bones; inst.seqMap = seqMap; inst.flinch = flinch; inst.bindWorld = bindWorld;
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

  // Per-bone CAPSULE hitboxes, built from the bind-pose bone world positions — so
  // they follow the model's actual pose (forward lean, arms out) instead of a guessed
  // column. computeBoneWorlds gives bone translations in GoldSrc space; convert to
  // three-local (x, z, −y) then to world via the (rotated) root.
  if (!inst.boneIdx) { inst.boneIdx = {}; inst.bones.forEach((b, i) => { inst.boneIdx[b.name] = i; }); }
  inst.root.updateMatrixWorld(true);
  inst.caps = [];
  for (const def of _CAP_DEFS) {
    const ia = inst.boneIdx[def.a], ib = inst.boneIdx[def.b];
    if (ia == null || ib == null) continue;
    inst.caps.push({ hg: def.hg, r: def.r, ia, ib, head: !!def.head, a: new THREE.Vector3(), b: new THREE.Vector3() });
  }
  _updateCaps(inst, inst.bindWorld);   // initial endpoints (idle bind pose)
  _buildHitboxDebug(inst);
  inst.health = ENEMY_HEALTH; inst.armor = ENEMY_ARMOR;
}

// Recompute capsule endpoints from a set of bone world transforms (GoldSrc space).
// Called every frame with the current animated pose, so the hitboxes track the
// model (idle breathing, death, etc.). Cheap: just reads bones already computed for
// skinning. Root never moves after placement, so its matrixWorld stays valid.
const _capDir = new THREE.Vector3();
function _updateCaps(inst, bw) {
  if (!inst.caps) return;
  for (const c of inst.caps) {
    const ta = bw.T[c.ia], tb = bw.T[c.ib];
    c.a.set(ta.x, ta.z, -ta.y); inst.root.localToWorld(c.a);
    c.b.set(tb.x, tb.z, -tb.y); inst.root.localToWorld(c.b);
    if (c.head) {                                // extend beyond the head bone to cover the skull
      _capDir.copy(c.a).sub(c.b).normalize();
      c.b.copy(c.a).addScaledVector(_capDir, 8);
      c.a.addScaledVector(_capDir, -2);
    }
  }
  if ((typeof showHitboxes !== 'undefined') && showHitboxes && inst.debugMeshes)
    for (let i = 0; i < inst.caps.length; i++) _orientDebug(inst.debugMeshes[i], inst.caps[i]);
}

// Wireframe capsule (drawn as an oriented cylinder) per bone hitbox — toggled by
// the "Показать хитбоксы" setting (showHitboxes). Purely visual: excluded from hitscan.
const _HG_DBGCOL = { 1: 0xff4040, 2: 0xffe04a, 3: 0xff9030, 4: 0x40ff80, 6: 0x60a0ff };
const _DBG_UP  = new THREE.Vector3(0, 1, 0);
const _DBG_DIR = new THREE.Vector3();
function _orientDebug(m, c) {                    // place a unit-height cylinder along capsule a→b
  _DBG_DIR.copy(c.b).sub(c.a);
  const len = _DBG_DIR.length() || 0.1;
  m.position.copy(c.a).addScaledVector(_DBG_DIR, 0.5);
  m.quaternion.setFromUnitVectors(_DBG_UP, _DBG_DIR.normalize());
  m.scale.set(1, len, 1);
}
function _buildHitboxDebug(inst) {
  if (inst.debugMeshes) inst.debugMeshes.forEach(m => { scene.remove(m); m.geometry.dispose(); });
  const on = (typeof showHitboxes !== 'undefined') && showHitboxes;
  inst.debugMeshes = inst.caps.map(c => {
    const geo = new THREE.CylinderGeometry(c.r, c.r, 1, 12, 1, true);   // height 1 → scaled per frame
    const mat = new THREE.MeshBasicMaterial({
      color: _HG_DBGCOL[c.hg] || 0xffffff, wireframe: true,
      transparent: true, opacity: 0.55, fog: false, toneMapped: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.userData.noHitscan = true;
    m.visible = on;
    scene.add(m);
    return m;
  });
  for (let i = 0; i < inst.caps.length; i++) _orientDebug(inst.debugMeshes[i], inst.caps[i]);
}

function setHitboxDebug(on) {
  for (const inst of enemies)
    if (inst.debugMeshes) for (const m of inst.debugMeshes) m.visible = on;
}

// Distance along the ray (D normalized) at which it comes within r of segment A–B,
// or Infinity. Closest-approach between the ray and the segment (clamped).
function _rayCapsule(O, D, A, B, r) {
  const vx = B.x - A.x, vy = B.y - A.y, vz = B.z - A.z;       // segment dir
  const wx = O.x - A.x, wy = O.y - A.y, wz = O.z - A.z;
  const b = D.x * vx + D.y * vy + D.z * vz;                   // a = D·D = 1
  const c = vx * vx + vy * vy + vz * vz;
  const d = D.x * wx + D.y * wy + D.z * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const den = c - b * b;                                      // a*c - b² with a=1
  let t = den > 1e-9 ? (e - b * d) / den : 0;                 // param along segment (a*e-b*d)/den
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let s = b * t - d;                                          // param along ray (a=1)
  if (s < 0) { s = 0; t = c > 1e-9 ? e / c : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; }
  const px = O.x + D.x * s, py = O.y + D.y * s, pz = O.z + D.z * s;
  const qx = A.x + vx * t, qy = A.y + vy * t, qz = A.z + vz * t;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return (dx * dx + dy * dy + dz * dz <= r * r) ? s : Infinity;
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
function updateEnemy(dt) {
  for (const inst of enemies) _updateEnemyInstance(inst, dt);
}

function _updateEnemyInstance(inst, dt) {
  if (!inst.root) return;
  const seq = inst.seqMap[inst.curSeq];
  if (!seq?.frames.length) return;
  const fps = seq.fps > 0 ? seq.fps : 30;
  const N = seq.frames.length;
  let cur;

  if (inst.state === 'idle') {
    inst.frame = (inst.frame + dt * fps) % N;
    const i = Math.floor(inst.frame) % N;
    const frac = inst.frame - Math.floor(inst.frame);
    const next = (i + 1) % N;
    const fl = inst.flinchT > 0 && inst.flinch ? inst.flinch[inst.flinchSeq] : null;
    if (fl) {
      inst.flinchT -= dt;
      const ffps = fl.fps > 0 ? fl.fps : 30, fN = fl.frames.length;
      inst.flinchFrame = Math.min(inst.flinchFrame + dt * ffps, fN - 1);
      const fi = Math.floor(inst.flinchFrame), ffrac = inst.flinchFrame - fi;
      const fnext = Math.min(fi + 1, fN - 1);
      const idleFrame = _lerpPose(seq.frames[i], seq.frames[next], frac);
      const flFrame   = _lerpPose(fl.frames[fi], fl.frames[fnext], ffrac);
      const w = Math.max(0, inst.flinchT / inst.flinchDur);
      cur = computeBoneWorlds(inst.bones, idleFrame, flFrame, w);
    } else {
      inst.flinchT = 0;
      const poseB = frac > 0.001 ? seq.frames[next] : null;
      cur = computeBoneWorlds(inst.bones, seq.frames[i], poseB, frac);
    }
  } else {                       // dead: play once, hold last frame, then respawn
    inst.frame = Math.min(inst.frame + dt * fps, N - 1);
    inst.deadTime += dt;
    if (inst.deadTime > DEATH_HOLD) { _enemyRespawn(inst); return; }
    const i = Math.floor(inst.frame) % N;
    const frac = inst.frame - Math.floor(inst.frame);
    const next = Math.min(i + 1, N - 1);
    const poseB = (frac > 0.001 && next > i) ? seq.frames[next] : null;
    cur = computeBoneWorlds(inst.bones, seq.frames[i], poseB, frac);
  }
  _skinRig(inst.meshes, inst.originalPositions, inst.boneIndices, inst.bones, cur, inst.bindWorld);
  _updateCaps(inst, cur);          // hitboxes follow the live pose
}

function _enemyRespawn(inst) {
  inst.state = 'idle'; inst.curSeq = 'idle1'; inst.frame = 0; inst.deadTime = 0;
  inst.health = ENEMY_HEALTH; inst.armor = ENEMY_ARMOR;
  inst.flinchT = 0; inst.lastHit = null;
}

// Kevlar (no helmet): absorbs torso/stomach/arm hits only; head & legs go straight to HP.
function _armorAbsorb(inst, dmg, hg) {
  if (inst.armor <= 0 || (hg !== 2 && hg !== 3 && hg !== 4)) return dmg;
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
  dmg = _armorAbsorb(inst, dmg, hg);
  dmg = Math.max(0, Math.round(dmg));
  inst.health -= dmg;
  inst.lastHit = { dmg, hg, t: performance.now() };
  enemyFocus = inst;
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
  const P = pitch + punchPitch + recoilPitch, Y = yaw + recoilYaw;
  const cp = Math.cos(P), sp = Math.sin(P);
  _enemyFrom.set(gsPos[0], gsPos[2] + eyeH, -gsPos[1]);
  _enemyDir.set(-cp * Math.sin(Y), sp, -cp * Math.cos(Y)).normalize();
  _enemyRay.set(_enemyFrom, _enemyDir); _enemyRay.far = maxDist;

  // First solid wall along the same aim — nothing past it can be hit.
  const wall = (typeof hitCheck === 'function') ? hitCheck(maxDist) : null;
  const wallDist = wall ? wall.fraction * maxDist : maxDist;

  // Nearest bone capsule per live dummy.
  const hits = [];
  for (const inst of enemies) {
    if (!inst.root || inst.state === 'dead' || !inst.caps) continue;
    let best = Infinity, hg = -1;
    for (const c of inst.caps) {
      const t = _rayCapsule(_enemyFrom, _enemyDir, c.a, c.b, c.r);
      if (t < best) { best = t; hg = c.hg; }
    }
    if (hg >= 0 && best <= maxDist && best <= wallDist + 1) {
      const pt = _enemyFrom.clone().addScaledVector(_enemyDir, best);
      hits.push({ inst, hg, dist: best, point: pt });
    }
  }
  if (!hits.length) return false;
  hits.sort((a, b) => a.dist - b.dist);

  if (opts.melee) {                                     // knife: nearest only
    const h = hits[0];
    _enemyDamage(h.inst, opts, h.hg, h.dist, h.point, 1);
    return true;
  }
  let penMult = 1;                                      // bullet: pierce in order
  for (const h of hits) {
    _enemyDamage(h.inst, opts, h.hg, h.dist, h.point, penMult);
    penMult *= PEN_MULT;
  }
  return true;
}
