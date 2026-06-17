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
      const rig = _buildRig(data.meshes);
      scene.add(rig.root);
      const inst = _makeEnemyInstance();
      inst.root = rig.root; inst.meshes = rig.meshes;
      inst.originalPositions = rig.originalPositions; inst.boneIndices = rig.boneIndices;
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
  inst.hboxes = [];
  for (const h of inst.hitboxData) {
    if (h.group < 1 || h.group > 7) continue;     // skip non-standard oversized boxes
    const cx = (h.bmin[0] + h.bmax[0]) / 2, cy = (h.bmin[1] + h.bmax[1]) / 2, cz = (h.bmin[2] + h.bmax[2]) / 2;
    inst.hboxes.push({
      hg: h.group, bone: h.bone, bmin: h.bmin, bmax: h.bmax,
      size: [h.bmax[0] - h.bmin[0], h.bmax[1] - h.bmin[1], h.bmax[2] - h.bmin[2]],
      centerMat: new THREE.Matrix4().makeTranslation(cx, cy, cz),
      M: new THREE.Matrix4(),
    });
  }
  _updateHitboxes(inst, inst.bindWorld);   // initial boxes (idle bind pose)
  _buildHitboxDebug(inst);
  inst.health = ENEMY_HEALTH; inst.armor = ENEMY_ARMOR;
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
  const rootM = inst.root.matrixWorld;
  for (const h of inst.hboxes) {
    const Rb = bw.R[h.bone], Tb = bw.T[h.bone];
    if (!Rb) continue;
    _boneMat.copy(Rb); _boneMat.setPosition(Tb.x, Tb.y, Tb.z);
    h.M.copy(rootM).multiply(_GS2THREE).multiply(_boneMat);
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
  _updateHitboxes(inst, cur);      // hitboxes follow the live pose
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

  // First solid wall along the same aim — nothing past it can be hit.
  const wall = (typeof hitCheck === 'function') ? hitCheck(maxDist) : null;
  const wallDist = wall ? wall.fraction * maxDist : maxDist;

  // Nearest bone hitbox (OBB) per live dummy.
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
