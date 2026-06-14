// weapons.js — weapon configs, switching, skeletal animation, firing/recoil, melee.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── Weapon configs ────────────────────────────────────────────────────────
const D = Math.PI / 180;
const WPNS = [
  {
    id: 'm4', label: 'M4A1',
    jsonFile: 'models/v_m4a1.json', jsonFileSil: 'models/v_m4a1_sil.json',
    idleSeq: 'idle_unsil', idleSeqSil: 'idle',
    fireSeq: 'shoot1_unsil', fireSeqSil: 'shoot1',
    fireSeqsUnsil: ['shoot1_unsil', 'shoot2_unsil', 'shoot3_unsil'],
    fireSeqsSil:   ['shoot1', 'shoot2', 'shoot3'],
    reloadSeq: 'reload_unsil', reloadSeqSil: 'reload',
    drawSeq: 'draw_unsil', drawSeqSil: 'draw',
    silencer: false,
    autofire: true,
    fireInterval: 0.09,
    spread: 0.012,
    // CS 1.6-style procedural recoil (KickBack): vertical grows each shot (the
    // T's stem), lateral starts after a few shots and grows, applied in a
    // direction that RANDOMLY flips — so the horizontal bar is different every
    // burst (sometimes long one way, sometimes switches). Degrees per shot.
    recoilProc: {
      pitch:     0.85,  // vertical kick per shot (degrees)
      stemShots: 4,     // shots kept vertical before the bar starts
      latBase:   0.35,  // lateral kick when the bar begins
      latGrow:   0.08,  // lateral added per shot into the bar
      latMax:    1.0,   // per-shot lateral cap
      flipChance: 6,    // direction flips with probability 1/(flipChance+1) per shot
    },
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun',
    muzzleBone: 41, muzzleOrg: [0, -14.25, 0], muzzleOrgSil: [0, -18.5, 0],
    ejectionBone: 41, ejectionOrg: [0, -1.25, 0], shellType: 'rifle',
    flashSX: 0.5, flashSY: 0.5,
    ammo: 30, maxAmmo: 30,
    reserve: 90, reloadTime: 3.1,
    root: null,
  },
  {
    id: 'usp', label: 'USP',
    jsonFile: 'models/v_usp.json', jsonFileSil: 'models/v_usp_sil.json',
    idleSeq: 'idle_unsil', idleSeqSil: 'idle',
    fireSeq: 'shoot1_unsil', fireSeqSil: 'shoot1',
    fireSeqsUnsil:    ['shoot1_unsil', 'shoot2_unsil', 'shoot3_unsil'],
    fireSeqsSil:      ['shoot1', 'shoot2', 'shoot3'],
    fireSeqLastUnsil: 'shootlast_unsil',
    fireSeqLastSil:   'shootlast',
    reloadSeq: 'reload_unsil', reloadSeqSil: 'reload',
    recoilKick: 0.04,    // vertical-only screen kick (unchanged)
    // Bullet scatter widens with fast spam (decal only — screen stays vertical),
    // shrinks back to a tight tap once you pause.
    spread: 0.008,       // tight when tapping
    spreadGrow: 0.005,   // widens per consecutive shot
    spreadMax: 0.05,     // medium-distance scatter cap
    drawSeq: 'draw_unsil', drawSeqSil: 'draw',
    silencer: false,
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun',
    muzzleBone: 20, muzzleOrg: [2.6, -8.1, 1.5], muzzleOrgSil: [2.6, -13.3, 2.0],
    ejectionBone: 42, ejectionOrg: [0, -1.5, 0], shellType: 'pistol',
    flashSX: 0.5, flashSY: 0.5,
    ammo: 12, maxAmmo: 12,
    reserve: 100, reloadTime: 2.7,
    root: null,
  },
  {
    id: 'knife', label: 'KNIFE',
    jsonFile: 'models/v_knife.json',
    idleSeq: 'idle',
    drawSeq: 'draw',
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12,
    type: 'melee',
    root: null,
  },
];

let curWpnIdx  = 2;
let nextWpnIdx = -1;

const WS = { IDLE: 0, DRAW: 1, SLASH: 2, STAB: 3, FIRE: 4, RELOAD: 5, SILENCER: 6 };
let ws = WS.DRAW, wsT = 0, wsIdleT = 0, wsHit = false;
let meleeCooldown = 0;          // time (s) until the next knife attack is allowed
let bobCycle = 0, bobAmt = 0;  // weapon bob state

function curW() { return WPNS[curWpnIdx]; }

// ── Skeletal animation system (per-weapon state) ─────────────────────────
// Each weapon stores its own animation data in wpn.anim
// GoldSrc MDL bone math: euler angles → quaternion → matrix
function lerpAngle(a, b, t) {
  let d = b - a;
  if (d >  Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function boneEulerQuat(rx, ry, rz, out) {
  const sr = Math.sin(rx * 0.5), cr = Math.cos(rx * 0.5);
  const sp = Math.sin(ry * 0.5), cp = Math.cos(ry * 0.5);
  const sy = Math.sin(rz * 0.5), cy = Math.cos(rz * 0.5);
  return out.set(
    sr*cp*cy - cr*sp*sy,
    cr*sp*cy + sr*cp*sy,
    cr*cp*sy - sr*sp*cy,
    cr*cp*cy + sr*sp*sy
  );
}

function boneEulerMat(rx, ry, rz) {
  return new THREE.Matrix4().makeRotationFromQuaternion(
    boneEulerQuat(rx, ry, rz, new THREE.Quaternion())
  );
}

// ── Load weapon meshes + animation ────────────────────────────────────────
const _texLoader = new THREE.TextureLoader();

function _buildGroup(data, scale) {
  const root = new THREE.Group();
  const originalPositions = [], boneIndices = [];
  data.meshes.forEach(m => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(m.positions), 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(m.uvs,     2));
    geo.setIndex(m.indices);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo,
      new THREE.MeshLambertMaterial({ map: _texLoader.load(m.texFile), side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    root.add(mesh);
    originalPositions.push(new Float32Array(m.positions));
    if (m.boneIndices) boneIndices.push(m.boneIndices);
  });
  root.scale.setScalar(scale);
  return { root, originalPositions, boneIndices };
}

function _activateGroup(wpn, g) {
  wpn.root = g.root;
  wpn.originalPositions = g.originalPositions;
  wpn.boneIndices = g.boneIndices;
}

WPNS.forEach(wpn => {
  fetch(wpn.jsonFile).then(r => r.json()).then(data => {
    wpn._groupUnsil = _buildGroup(data, wpn.scale);
    _activateGroup(wpn, wpn._groupUnsil);
    wpn.root.visible = (WPNS.indexOf(wpn) === curWpnIdx);
    vmScene.add(wpn.root);

    // Load animation file if available
    const animFile = wpn.jsonFile.replace('.json', '_anim.json');
    fetch(animFile).then(r => r.ok ? r.json() : Promise.reject())
      .then(animData => {
        wpn.anim = { bones: animData.bones, seqs: animData.sequences, curFrame: 0 };
        console.log(`Anim loaded: ${wpn.id} (${animData.bones.length} bones)`);
      }).catch(() => {});

    // Load silenced variant if available
    if (wpn.jsonFileSil) {
      fetch(wpn.jsonFileSil).then(r => r.json()).then(silData => {
        wpn._groupSil = _buildGroup(silData, wpn.scale);
        wpn._groupSil.root.visible = false;
        vmScene.add(wpn._groupSil.root);
      }).catch(() => {});
    }
  }).catch(() => console.warn(`${wpn.jsonFile} not found`));
});

function toggleSilencer() {
  const wpn = curW();
  if (!wpn._groupSil || ws !== WS.IDLE) return;
  wpn._silAdding = !wpn.silencer;
  if (wpn.anim) { wpn.anim._silAnimDone = false; wpn.anim.curFrame = 0; }
  ws = WS.SILENCER; wsT = 0;
}

function _finishSilencer(wpn) {
  const hasSil = wpn._silAdding;
  wpn.root.visible = false;
  _activateGroup(wpn, hasSil ? wpn._groupSil : wpn._groupUnsil);
  if (!wpn._idleSeqOrig) { wpn._idleSeqOrig = wpn.idleSeq; wpn._fireSeqOrig = wpn.fireSeq; wpn._reloadSeqOrig = wpn.reloadSeq; wpn._drawSeqOrig = wpn.drawSeq; }
  wpn.idleSeq   = hasSil ? wpn.idleSeqSil   : wpn._idleSeqOrig;
  wpn.fireSeq   = hasSil ? wpn.fireSeqSil   : wpn._fireSeqOrig;
  wpn.reloadSeq = hasSil ? wpn.reloadSeqSil : wpn._reloadSeqOrig;
  wpn.drawSeq   = hasSil ? wpn.drawSeqSil   : wpn._drawSeqOrig;
  wpn.root.visible = true;
  wpn.silencer = hasSil;
  if (wpn.anim) { wpn.anim.idleWorld = null; wpn.anim._prevAttackWs = undefined; }
}

function switchWeapon(idx) {
  if (idx === curWpnIdx || idx < 0 || idx >= WPNS.length) return;
  // Разрешить переключение во время перезарядки или глушителя, но отметить прерывание
  if (ws === WS.RELOAD) {
    WPNS[curWpnIdx]._reloadInterrupted = true;
  }
  if (ws === WS.SILENCER) {
    WPNS[curWpnIdx]._silencerInterrupted = true;
  }
  nextWpnIdx = idx;
  if (ws === WS.IDLE || ws === WS.DRAW || ws === WS.RELOAD || ws === WS.SILENCER) _beginDraw(nextWpnIdx);
}

function _beginDraw(idx) {
  if (WPNS[curWpnIdx].root) WPNS[curWpnIdx].root.visible = false;
  curWpnIdx  = idx;
  nextWpnIdx = -1;
  ws = WS.DRAW; wsT = 0;
  meleeCooldown = 0;
  const wpn = WPNS[curWpnIdx];
  wpn._reloadInterrupted = false;  // Очистить флаг прерывания при переключении на новое оружие
  wpn._silencerInterrupted = false;  // Очистить флаг глушителя при переключении
  if (wpn.anim) { wpn.anim._drawAnimDone = false; wpn.anim.curFrame = 0; }
  if (wpn.root) wpn.root.visible = true;
}

function hitCheck(maxDist) {
  if (!gsPos || !gPlanes) return null;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const cp   = Math.cos(pitch), spv = Math.sin(pitch);
  const from = [gsPos[0], gsPos[1], gsPos[2] + eyeH];
  const fx   = -Math.sin(yaw)*cp, fy = Math.cos(yaw)*cp, fz = -spv;
  const to   = [from[0]+fx*maxDist, from[1]+fy*maxDist, from[2]+fz*maxDist];
  return traceMove(from, to);
}

// Returns trace if melee connects within dist, null if miss.
function _meleeHits(dist) {
  if (!gsPos || !gPlanes) return null;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const cp   = Math.cos(pitch), spv = Math.sin(pitch);
  const from = [gsPos[0], gsPos[1], gsPos[2] + eyeH];
  const fx   = -Math.sin(yaw)*cp, fy = Math.cos(yaw)*cp, fz = -spv;
  const to   = [from[0]+fx*dist, from[1]+fy*dist, from[2]+fz*dist];
  const tr   = traceMove(from, to);
  return tr.fraction < 1.0 ? tr : null;
}

// Start a knife attack with original CS 1.6 timing and hit/miss animation set.
//   LMB slash : hit → slash1/slash2 (0.25s),  miss → midslash1/midslash2 (0.4s)
//   RMB stab  : hit → stab (1.1s),            miss → stab_miss (1.0s)
function _startMeleeAttack(wpn, isStab) {
  const meleeResult = _meleeHits(48);
  const hit = meleeResult !== null;
  // Cut orientation (right-hand weapon): LMB = one diagonal upper-left→lower-right,
  // RMB = near-horizontal. Mirrored for a left-hand weapon. Small jitter only.
  const handSign = rightHand ? 1 : -1;
  let seqName, cd, cutRoll;
  if (isStab) {
    seqName = hit ? 'stab' : 'stab_miss';
    cd = hit ? 1.1 : 1.0;
    ws = WS.STAB;
    cutRoll = handSign * -0.12 + (Math.random() - 0.5) * 0.1;   // RMB → near-horizontal
  } else {
    // LMB always plays the full swing (midslash1/midslash2 alternating); the
    // slash1/slash2 sequences are 2-frame impact stubs, not real swings, so a
    // hit must not shorten the visible animation. Hit only affects the cooldown.
    const i = wpn.anim ? (wpn.anim._slashIdx = ((wpn.anim._slashIdx ?? -1) + 1) % 2) : 0;
    seqName = i ? 'midslash2' : 'midslash1';
    cd = hit ? 0.35 : 0.4;
    ws = WS.SLASH;
    cutRoll = handSign * -0.35 + (Math.random() - 0.5) * 0.12;  // LMB → shallow diagonal upper-left→lower-right
  }
  if (hit) _spawnDecal('knife', 64, 0, cutRoll);
  wsT = 0; wsHit = false;
  meleeCooldown = cd;
  if (wpn.anim) {
    wpn.anim._attackSeq = seqName;
    wpn.anim._prevAttackWs = undefined;   // force frame reset in applySkeletalAnimation
    wpn.anim._attackAnimDone = false;
  }
}

function updateWeapon(dt) {
  const wpn = curW();
  if (!wpn.root) return;
  wsT += dt; wsIdleT += dt;
  if (meleeCooldown > 0) meleeCooldown -= dt;
  const p = wpn.root.position, r = wpn.root.rotation;
  const eo = t => 1 - (1-t)*(1-t);

  // Weapon bob (GoldSrc style: 0.8s cycle at max speed)
  const _hspd = (vel && onGround) ? Math.hypot(vel[0], vel[1]) : 0;
  const _tgtBob = onGround ? Math.min(_hspd / SV.maxspeed, 1) : 0;
  bobAmt += (_tgtBob - bobAmt) * Math.min(dt * 8, 1);
  if (_hspd > 5) bobCycle += dt * (_hspd / SV.maxspeed) * (Math.PI * 2 / 1.0);
  const _bob = Math.sin(bobCycle) * bobAmt;
  const bobYaw = -_bob * 0.035;                        // вращение вокруг ствола
  const bobX   = -_bob * 0.035 * 2.4;                 // компенсация — ствол к центру
  const bobZ   =  _bob * (_bob >= 0 ? 0.11 : 0.04);   // назад много, вперёд мало

  // Crosshair dynamics (CS-style): expands fast on shots/movement, contracts slowly.
  const _spd2d = vel ? Math.hypot(vel[0], vel[1]) : 0;
  let _moveGap = 0;
  if (!onGround)        _moveGap = 26;                       // airborne — wide open
  else {
    _moveGap = Math.max(0, _spd2d - 40) / 250 * 16;          // running opens it
    if (phyDucked) _moveGap *= 0.4;                          // crouch tightens
  }
  xhairGap *= Math.exp(-dt * 3.0);                           // slow contraction
  if (_moveGap > xhairGap) xhairGap = _moveGap;              // movement holds it open
  if (xhairGap > 60) xhairGap = 60;

  if (nextWpnIdx >= 0 && ws === WS.IDLE) { _beginDraw(nextWpnIdx); return; }

  switch (ws) {
    case WS.DRAW: {
      if (wsT <= dt * 1.5 && wpn.anim) restoreWeaponVertices(wpn);
      p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
      r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
      if (wpn.anim?._drawAnimDone || wsT >= 2.0) {
        ws = WS.IDLE; wsT = 0;
        // Если новое оружие имеет 0 патронов и есть резерв - начать перезарядку
        if (wpn.type === 'gun' && wpn.ammo === 0 && wpn.reserve > 0) {
          ws = WS.RELOAD; wsT = 0;
        } else if (lmbHeld && wpn.type === 'gun' && wpn.ammo > 0) {
          // Если LMB зажата во время draw и есть патроны - начать стрельбу
          wpn.ammo--; ws = WS.FIRE; wsT = 0; wsHit = false;
        }
      }
      break;
    }
    case WS.IDLE: {
      p.set(wpn.pos.x + bobX, wpn.pos.y + Math.sin(wsIdleT*1.6)*0.005, wpn.pos.z + bobZ);
      r.set(wpn.rot.x + Math.cos(wsIdleT*0.9)*0.007, wpn.rot.y + bobYaw, wpn.rot.z);
      break;
    }
    case WS.SLASH: {
      if (wpn.anim) {
        // Knife has a full skeletal swing+return animation that itself starts
        // and ends in the idle pose — let it drive everything (original look),
        // and only return to IDLE once it has finished its smooth recovery.
        p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
        r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
        if (wsT >= 0.12 && !wsHit) { wsHit = true; hitCheck(32); }
        if (wpn.anim._attackAnimDone || wsT >= 1.4) { ws = WS.IDLE; wsT = 0; wsHit = false; }
        break;
      }
      const PRE = 0.14, POST = 0.34;
      if (wsT < PRE) {
        const t = eo(wsT / PRE);
        p.set(wpn.pos.x + t*0.22, wpn.pos.y - t*0.10, wpn.pos.z);
        r.set(wpn.rot.x - t*0.32, wpn.rot.y + t*0.28, wpn.rot.z + t*0.40);
      } else {
        const t = Math.min((wsT - PRE) / POST, 1);
        p.set(wpn.pos.x + (1-t)*0.22 - t*0.20, wpn.pos.y - (1-t)*0.10, wpn.pos.z);
        r.set(wpn.rot.x - (1-t)*0.32, wpn.rot.y + (1-t)*0.28 - t*0.55, wpn.rot.z + (1-t)*0.40 - t*0.16);
        if (t >= 0.25 && !wsHit) { wsHit = true; hitCheck(32); }
        if (t >= 1) { ws = WS.IDLE; wsT = 0; wsHit = false; }
      }
      break;
    }
    case WS.STAB: {
      if (wpn.anim) {
        p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
        r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
        if (wsT >= 0.22 && !wsHit) { wsHit = true; hitCheck(32); }
        if (wpn.anim._attackAnimDone || wsT >= 1.6) { ws = WS.IDLE; wsT = 0; wsHit = false; }
        break;
      }
      const PRE = 0.10, POST = 0.44;
      if (wsT < PRE) {
        const t = wsT / PRE;
        p.set(wpn.pos.x, wpn.pos.y - t*0.07, wpn.pos.z + t*0.11);
        r.set(wpn.rot.x + t*0.22, wpn.rot.y, wpn.rot.z);
      } else {
        const t = Math.min((wsT - PRE) / POST, 1);
        const fwd = t < 0.35 ? eo(t/0.35) : 1 - eo((t-0.35)/0.65);
        p.set(wpn.pos.x, wpn.pos.y - (1-t)*0.07, wpn.pos.z + (1-t)*0.11 - fwd*0.26);
        r.set(wpn.rot.x + (1-t)*0.22, wpn.rot.y, wpn.rot.z);
        if (fwd >= 0.80 && !wsHit) { wsHit = true; hitCheck(32); }
        if (t >= 1) { ws = WS.IDLE; wsT = 0; wsHit = false; }
      }
      break;
    }
    case WS.FIRE: {
      const DUR = wpn.fireInterval || 0.12;
      const t   = Math.min(wsT / DUR, 1);
      const kick = t < 0.3 ? t/0.3 : 1 - (t-0.3)/0.7;
      p.set(wpn.pos.x + bobX, wpn.pos.y + kick*0.03, wpn.pos.z + kick*0.04 + bobZ);
      r.set(wpn.rot.x - kick*0.08, wpn.rot.y + bobYaw, wpn.rot.z);
      if (!wsHit) {
        wsHit = true;
        // New burst (recoil has recovered) → restart the spray pattern.
        // Works for semi-auto spam too: rapid taps keep advancing the index.
        if (lastShotAge > 0.3) {
          wpn._shotCount  = 0;
          wpn._recoilDir  = Math.random() < 0.5 ? 1 : -1;  // bar may start either side
        }
        const sc = wpn._shotCount || 0;
        // Bullet scatter cone (decal only — does NOT move the screen). Widens with
        // rapid fire (accuracy degradation), shrinks back once the burst resets.
        let shotSpread = wpn.spread || 0;
        if (wpn.spreadGrow) shotSpread = Math.min(shotSpread + sc * wpn.spreadGrow, wpn.spreadMax ?? shotSpread);
        // Movement inaccuracy (CS 1.6): jumping is worst, running adds spread with
        // speed, ducking tightens, standing still is most accurate.
        const spd2d = vel ? Math.hypot(vel[0], vel[1]) : 0;
        if (!onGround) {
          shotSpread += 0.05;                       // in air — large
        } else {
          let m = (Math.max(0, spd2d - 40) / 250) * 0.035;  // scales with speed past a deadzone
          if (phyDucked) m *= 0.4;                  // crouch-moving tightens
          shotSpread += m;
        }
        xhairGap += wpn.xhairKick ?? 5;             // each shot kicks the crosshair open
        _spawnDecal('bullet', 4096, shotSpread);
        lastShotAge = 0;           // keep recoil in slow-decay (accumulate) mode through the burst
        wpn._pendingFire = true;   // defer flash+eject until _muzzleLocal is current
        wpn._shotCount = sc + 1;
        if (wpn.recoilProc) {
          // CS 1.6 KickBack: vertical climbs; lateral grows after the stem and
          // is applied in _recoilDir, which randomly flips → bar varies per burst.
          const rp = wpn.recoilProc;
          recoilPitch = Math.min(0.35, recoilPitch + rp.pitch * D);
          if (sc >= rp.stemShots) {
            const n   = sc - rp.stemShots;
            const mag = Math.min(rp.latBase + n * rp.latGrow, rp.latMax) * D;
            recoilYaw = Math.max(-0.25, Math.min(0.25, recoilYaw + mag * (wpn._recoilDir || 1)));
            if (Math.floor(Math.random() * (rp.flipChance + 1)) === 0) wpn._recoilDir = -(wpn._recoilDir || 1);
          }
        } else if (wpn.recoilTable) {
          const [ky, kp] = wpn.recoilTable[Math.min(sc, wpn.recoilTable.length - 1)];
          recoilPitch = Math.min(0.35, recoilPitch + kp);
          recoilYaw   = Math.max(-0.25, Math.min(0.25, recoilYaw + ky));
        } else {
          recoilPitch = Math.min(0.35, recoilPitch + (wpn.recoilKick || 0));
        }
      }
      if (t >= 1) {
        if (lmbHeld && wpn.autofire && wpn.ammo > 0) {
          wpn.ammo--; wsT = 0; wsHit = false;
        } else {
          wsHit = false;
          // Don't reset _shotCount here — the spray index is reset on the next
          // shot only if enough time passed (see lastShotAge check above), so
          // fast semi-auto taps continue advancing the pattern.
          if (wpn.ammo === 0 && wpn.reserve > 0) { ws = WS.RELOAD; wsT = 0; }
          else { ws = WS.IDLE; wsT = 0; }
        }
      }
      break;
    }
    case WS.RELOAD: {
      p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
      r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
      if (wsT >= wpn.reloadTime) {
        // Не завершать перезарядку если она была прервана переключением оружия
        if (!wpn._reloadInterrupted) {
          const take = Math.min(wpn.maxAmmo - wpn.ammo, wpn.reserve);
          wpn.ammo += take; wpn.reserve -= take;
        }
        wpn._reloadInterrupted = false;  // Очистить флаг для следующей перезарядки
        // Если LMB зажата во время перезарядки и есть патроны - начать стрельбу
        if (lmbHeld && wpn.ammo > 0) {
          wpn.ammo--; ws = WS.FIRE; wsT = 0; wsHit = false;
        } else {
          ws = WS.IDLE; wsT = 0;
        }
      }
      break;
    }
    case WS.SILENCER: {
      p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
      r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
      if (wpn.anim?._silAnimDone || wsT >= 4.0) {
        // Не применять изменение глушителя если анимация была прервана переключением оружия
        if (!wpn._silencerInterrupted) {
          _finishSilencer(wpn);
        }
        wpn._silencerInterrupted = false;  // Очистить флаг для следующего переключения
        // Если LMB зажата после смены глушителя и есть патроны - начать стрельбу
        if (lmbHeld && wpn.ammo > 0) {
          wpn.ammo--; ws = WS.FIRE; wsT = 0; wsHit = false;
        } else {
          ws = WS.IDLE; wsT = 0;
        }
      }
      break;
    }
  }

  // Knife auto-repeat: while a mouse button is held, swing at the original
  // CS fire rate (gated by meleeCooldown), interrupting the previous swing.
  if (wpn.type === 'melee' && meleeCooldown <= 0 &&
      (ws === WS.IDLE || ws === WS.SLASH || ws === WS.STAB)) {
    if      (lmbHeld) _startMeleeAttack(wpn, false);
    else if (rmbHeld) _startMeleeAttack(wpn, true);
  }

  // Skeletal animation
  const _gunAnimActive = wpn.type === 'gun' && wpn.anim?._gunAnimPlaying;
  if (wpn.anim && (ws === WS.IDLE || ws === WS.SLASH || ws === WS.STAB || ws === WS.FIRE || ws === WS.RELOAD || ws === WS.DRAW || ws === WS.SILENCER || _gunAnimActive)) {
    applySkeletalAnimation(wpn, dt);
  }

  // Fire effects deferred until after animation so _muzzleLocal/_ejectionLocal are current
  if (wpn._pendingFire) {
    wpn._pendingFire = false;
    _showFlash(wpn);
    _ejectShell(wpn);
  }
}

// ── Restore weapon vertices to original idle pose ─────────────────────────
function restoreWeaponVertices(wpn) {
  if (!wpn.originalPositions) return;
  if (wpn.anim) wpn.anim._prevAttackWs = undefined; // reset so next attack starts at frame 0
  wpn.root.children.forEach((mesh, meshIdx) => {
    const origPos = wpn.originalPositions[meshIdx];
    if (!origPos) return;
    const posAttr = mesh.geometry.getAttribute('position');
    const posArr = posAttr.array;
    for (let i = 0; i < origPos.length; i++) {
      posArr[i] = origPos[i];
    }
    posAttr.needsUpdate = true;
  });
}

// ── Skeletal animation (full matrix skinning) ────────────────────────────
// Vertices are baked in world-space at idle frame 0.
// Skinning: v_new = M_cur × M_idle⁻¹ × v_orig  (in GoldSrc space, then axis-swap).

// Effective frame count for non-looping sequences: drops trailing duplicate
// frames so animations don't hold a dead pose before transitioning out.
function _seqActiveLen(seq) {
  if (seq._activeLen !== undefined) return seq._activeLen;
  const F = seq.frames;
  let n = F.length;
  const frameEq = (a, b) =>
    a.length === b.length &&
    a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) < 1e-4));
  while (n > 1 && frameEq(F[n - 1], F[n - 2])) n--;
  seq._activeLen = n;
  return n;
}

function computeBoneWorlds(bones, poseA, poseB, t) {
  const R = [], T = [];
  const n = poseA.length;
  for (let i = 0; i < n; i++) {
    const a = poseA[i];
    let tx, ty, tz;
    let q;
    if (poseB && t > 0) {
      const b = poseB[i];
      tx = a[0] + (b[0] - a[0]) * t;
      ty = a[1] + (b[1] - a[1]) * t;
      tz = a[2] + (b[2] - a[2]) * t;
      // Slerp quaternions (correctly handles ±π euler representation flips,
      // unlike independent per-axis angle lerp which causes "stuck record" glitches)
      boneEulerQuat(a[3], a[4], a[5], _qBoneA);
      boneEulerQuat(b[3], b[4], b[5], _qBoneB);
      q = _qBoneR.copy(_qBoneA).slerp(_qBoneB, t);
    } else {
      tx = a[0]; ty = a[1]; tz = a[2];
      q = boneEulerQuat(a[3], a[4], a[5], _qBoneA);
    }
    const mat   = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const trans = new THREE.Vector3(tx, ty, tz);
    const par = bones[i].parent;
    if (par >= 0 && R[par]) {
      mat.premultiply(R[par]);
      trans.applyMatrix4(R[par]).add(T[par]);
    }
    R.push(mat);
    T.push(trans);
  }
  return { R, T };
}

const _skinVtmp = new THREE.Vector3();
const _qBoneA = new THREE.Quaternion();
const _qBoneB = new THREE.Quaternion();
const _qBoneR = new THREE.Quaternion();

function applySkeletalAnimation(wpn, dt) {
  if (!wpn.anim?.bones || !wpn.anim?.seqs || !wpn.originalPositions) return;
  if (!wpn.boneIndices?.length) return;

  // Determine sequence and handle frame reset per weapon type
  let seqName;
  if (ws === WS.IDLE) {
    seqName = wpn.idleSeq || 'idle';
    if (wpn.anim._prevAnimWs !== WS.IDLE) {
      wpn.anim.curFrame = 0;
      wpn.anim._prevAttackWs = undefined;
    }
  } else if (wpn.type === 'gun') {
    if (ws === WS.SILENCER) {
      seqName = wpn._silAdding ? 'add_silencer' : 'detach_silencer';
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else if (ws === WS.DRAW) {
      seqName = wpn.drawSeq || (wpn.silencer ? 'draw' : 'draw_unsil');
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else if (ws === WS.RELOAD) {
      seqName = wpn.reloadSeq || (wpn.silencer ? 'reload' : 'reload_unsil');
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else {
      if (ws === WS.FIRE && wsT < dt * 2) {
        const seqs = wpn.silencer
          ? (wpn.fireSeqsSil   || [wpn.fireSeqSil || 'shoot1'])
          : (wpn.fireSeqsUnsil || [wpn.fireSeq    || 'shoot1_unsil']);
        const lastSeq = wpn.silencer ? wpn.fireSeqLastSil : wpn.fireSeqLastUnsil;
        if (wpn.ammo === 0 && lastSeq) {
          wpn.anim._lastFireSeq = lastSeq;
        } else {
          wpn.anim._shootIdx = ((wpn.anim._shootIdx ?? -1) + 1) % seqs.length;
          wpn.anim._lastFireSeq = seqs[wpn.anim._shootIdx];
        }
        wpn.anim.curFrame = 0;
        wpn.anim._gunAnimPlaying = true;
      }
      seqName = wpn.anim._lastFireSeq || wpn.fireSeq || 'shoot1_unsil';
    }
  } else {
    if (ws === WS.DRAW) {
      seqName = wpn.drawSeq || 'draw';
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else if (ws !== WS.IDLE) {
      // Hit/miss sequence chosen at attack start by _startMeleeAttack.
      seqName = wpn.anim._attackSeq || (ws === WS.STAB ? 'stab' : 'midslash1');
      if (wpn.anim._prevAttackWs !== ws || wpn.anim._attackSeqPlaying !== seqName) {
        wpn.anim._prevAttackWs = ws;
        wpn.anim._attackSeqPlaying = seqName;
        wpn.anim.curFrame = 0;
        wpn.anim._attackAnimDone = false;
      }
    }
  }

  const seq = wpn.anim.seqs.find(s => s.name === seqName);
  if (!seq?.frames.length) return;

  wpn.anim._prevAnimWs = ws;
  const fps = seq.fps > 0 ? seq.fps : 30;
  // For non-looping sequences, ignore trailing duplicate frames so the weapon
  // doesn't freeze on a dead "held" pose for a fraction of a second at the end.
  const endLen = (ws === WS.IDLE) ? seq.frames.length : _seqActiveLen(seq);
  wpn.anim.curFrame += dt * fps;
  if (wpn.anim.curFrame >= endLen) {
    if (ws === WS.IDLE) { wpn.anim.curFrame %= seq.frames.length; }  // loop
    else wpn.anim.curFrame = endLen - 1;
    if (ws === WS.SILENCER) {
      wpn.anim._silAnimDone = true;
    } else if (ws === WS.DRAW) {
      wpn.anim._drawAnimDone = true;
    } else if (ws === WS.SLASH || ws === WS.STAB) {
      wpn.anim._attackAnimDone = true;
    } else if (wpn.type === 'gun') {
      if (ws !== WS.RELOAD) {
        wpn.anim._gunAnimPlaying = false;
        return;  // signal done; restoreWeaponVertices runs next frame
      }
      // RELOAD: hold at last frame until state machine transitions
    }
  }

  const numFrames = seq.frames.length;
  const frameIdx  = Math.floor(wpn.anim.curFrame) % numFrames;
  const frac      = wpn.anim.curFrame - Math.floor(wpn.anim.curFrame);
  const poseA     = seq.frames[frameIdx];
  if (!poseA) return;
  const loops  = ws === WS.IDLE;
  const nextIdx = loops
    ? (frameIdx + 1) % numFrames
    : Math.min(frameIdx + 1, numFrames - 1);
  // Don't interpolate across loop boundary (frame[N-1]→frame[0]) — bad blend if they differ
  const poseB = (frac > 0.0001 && nextIdx > frameIdx) ? seq.frames[nextIdx] : null;

  // Build idle bind-pose world transforms once and cache them
  if (!wpn.anim.idleWorld) {
    const idleSeqName = wpn.idleSeq || 'idle';
    const idleSeq = wpn.anim.seqs.find(s => s.name === idleSeqName);
    wpn.anim.idleWorld = (idleSeq?.frames.length)
      ? computeBoneWorlds(wpn.anim.bones, idleSeq.frames[0], null, 0)
      : null;
  }
  if (!wpn.anim.idleWorld) return;

  const idle = wpn.anim.idleWorld;
  const cur  = computeBoneWorlds(wpn.anim.bones, poseA, poseB, frac);

  // Build per-bone skinning matrices in GoldSrc space.
  // Skinning: v_new_gs = R_cur × R_idle⁻¹ × (v_gs − t_idle) + t_cur
  //         = M_skin × v_gs + (t_cur − M_skin × t_idle)
  const skinM = [], skinT = [];
  for (let b = 0; b < wpn.anim.bones.length; b++) {
    const M = cur.R[b].clone().multiply(idle.R[b].clone().transpose());
    const t = idle.T[b].clone().applyMatrix4(M);
    t.subVectors(cur.T[b], t);
    skinM.push(M);
    skinT.push(t);
  }

  // Apply full rotation + translation skinning to every vertex
  wpn.root.children.forEach((mesh, meshIdx) => {
    const origPos   = wpn.originalPositions[meshIdx];
    const boneIdxArr = wpn.boneIndices[meshIdx];
    if (!origPos || !boneIdxArr) return;

    const posAttr = mesh.geometry.getAttribute('position');
    const posArr  = posAttr.array;

    for (let i = 0; i < origPos.length; i += 3) {
      const b = boneIdxArr[i / 3];
      if (b === undefined || !skinM[b]) {
        posArr[i] = origPos[i]; posArr[i+1] = origPos[i+1]; posArr[i+2] = origPos[i+2];
        continue;
      }
      // Three.js → GoldSrc: (x, y, z)_three = (x, z, −y)_gs  →  gs = (x, −z, y)
      _skinVtmp.set(origPos[i], -origPos[i+2], origPos[i+1]);
      _skinVtmp.applyMatrix4(skinM[b]).add(skinT[b]);
      // GoldSrc → Three.js: (x, z, −y)
      posArr[i]   =  _skinVtmp.x;
      posArr[i+1] =  _skinVtmp.z;
      posArr[i+2] = -_skinVtmp.y;
    }
    posAttr.needsUpdate = true;
  });

  // Cache muzzle and ejection port positions in vmScene-local space
  if (wpn.muzzleBone !== undefined && cur.T[wpn.muzzleBone]) {
    const org = (wpn.silencer && wpn.muzzleOrgSil) ? wpn.muzzleOrgSil : wpn.muzzleOrg;
    _muzzleGsTmp.set(org[0], org[1], org[2]).applyMatrix4(cur.R[wpn.muzzleBone]);
    _muzzleGsTmp.add(cur.T[wpn.muzzleBone]);
    if (!wpn._muzzleLocal) wpn._muzzleLocal = new THREE.Vector3();
    wpn._muzzleLocal.set(_muzzleGsTmp.x, _muzzleGsTmp.z, -_muzzleGsTmp.y);
  }
  if (wpn.ejectionBone !== undefined && cur.T[wpn.ejectionBone]) {
    const org = wpn.ejectionOrg;
    _muzzleGsTmp.set(org[0], org[1], org[2]).applyMatrix4(cur.R[wpn.ejectionBone]);
    _muzzleGsTmp.add(cur.T[wpn.ejectionBone]);
    if (!wpn._ejectionLocal) wpn._ejectionLocal = new THREE.Vector3();
    wpn._ejectionLocal.set(_muzzleGsTmp.x, _muzzleGsTmp.z, -_muzzleGsTmp.y);
  }
}

