// net.js — multiplayer client (Phase 5, step B): authoritative server +
// client-side prediction / reconciliation for the local player, interpolation
// for remote players.
// Classic script, shared global scope. Loads after player.js (reuses _buildRig /
// _skinRig), weapons.js (computeBoneWorlds) and physics.js/sim-core.js (simHull,
// simMakeState, simPlayerMove); driven each frame from input.js's loop.
//
// Wire: we send only USERCMDS (input + view yaw + a seq number) to server.js, which
// owns the simulation and broadcasts authoritative snapshots ~20×/s. Each snapshot
// carries `ack` = the last seq the server processed from us, so we reset to the
// authoritative state and replay still-unacked cmds (reconciliation) — local input
// stays responsive (prediction) while staying server-correct. Remote players are
// interpolated toward their last received pose.
// If no server is running the connection fails silently and the game stays solo.

const NET_URL  = `ws://${location.hostname || 'localhost'}:8081`;

let _ws = null, _myId = null;
let _cmdSeq = 0;                          // monotonic usercmd sequence we stamp
let _ackSeq = 0;                          // last seq the server confirmed processing
const _pending = [];                      // [{seq, cmd, dt, wpnMax}] — unacked predicted cmds
let _authState = null;                    // latest authoritative LOCAL state from a snapshot
let _authDirty = false;                   // a new snapshot arrived → reconcile next frame
const remotePlayers = new Map();          // id → instance (rig + anim state + interp targets)
const _netModelCache = {};                // model name → loaded JSON (shared across instances)

function _connected() { return _ws && _ws.readyState === 1 && _myId != null; }

function netConnect() {
  if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return;   // already (re)connecting
  try { _ws = new WebSocket(NET_URL); } catch (e) { return; }
  _ws.onopen    = () => { console.log('[mp] connected to', NET_URL); netHello(); };
  _ws.onclose   = () => {
    _myId = null; _ackSeq = 0; _pending.length = 0;
    _authState = null; _authDirty = false; _clearRemotes();
  };
  _ws.onerror   = () => {};             // silent: no server running → stay single-player
  _ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } _onNetMsg(m); };
}

// Tell the server our identity + spawn pose (join, team change, respawn). A teleport
// invalidates predicted history, so drop it — we snap cleanly to the server pose.
function netHello() {
  if (!_ws || _ws.readyState !== 1) return;
  _pending.length = 0;
  _ws.send(JSON.stringify({
    t:  'hello',
    m:  (typeof playerModelName !== 'undefined' && playerModelName) ? playerModelName : 'gign',
    tm: (typeof playerTeam !== 'undefined') ? playerTeam : 'ct',
    w:  (typeof curW === 'function' && curW()) ? curW().id : 'usp',
    p:  (typeof gsPos !== 'undefined' && gsPos) ? [gsPos[0], gsPos[1], gsPos[2]] : undefined,
    y:  (typeof yaw !== 'undefined') ? yaw : 0,
  }));
}

function _onNetMsg(m) {
  switch (m.t) {
    case 'welcome': _myId = m.id; break;
    case 'leave':   _removeRemote(m.id); break;
    case 'snap':    _onSnapshot(m); break;
    case 'hit':     _onIncomingHit(m); break;
  }
}

// Another player's client reported hitting us. HP/armor are owned by the victim
// (this client), so apply the damage here: the shooter already rolled the weapon
// damage × falloff × hitgroup; we apply our own kevlar coverage by hitgroup.
function _onIncomingHit(m) {
  if (typeof playerTakeDamage !== 'function') return;
  const hg = m.hg | 0, dmg = m.dmg | 0;
  const helmet = (typeof playerHelmet !== 'undefined') && playerHelmet;
  const covered = (hg === 2 || hg === 3 || hg === 4 || hg === 5) || (hg === 1 && helmet);
  playerTakeDamage(dmg, { covered });
}

// Shooter → server: report a bullet/knife hit on a remote player (the server
// forwards it to that player's client, which owns its HP). No-op solo.
function netSendHit(targetId, hg, dmg) {
  if (!_connected()) return;
  _ws.send(JSON.stringify({ t: 'hit', target: targetId, hg, dmg }));
}

// Apply an authoritative snapshot: stash our own state for reconciliation, upsert
// every other player's interpolation target.
function _onSnapshot(m) {
  if (m.ack != null && m.ack > _ackSeq) _ackSeq = m.ack;
  for (const e of (m.players || [])) {
    if (e.id === _myId) {
      _authState = {
        pos: e.p.slice(), vel: (e.v || [0, 0, 0]).slice(),
        onGround: !!e.og, wasJump: !!e.wj, duckAmount: e.da || 0,
        phyDucked: !!e.dk, prevVelZ: e.pz || 0,
      };
      _authDirty = true;
    } else {
      _onRemoteState(e);
    }
  }
}

// Reconcile the local player: reset to the authoritative state and replay the cmds
// the server hasn't acked yet. Called from physics.js at the top of playerMove,
// before this frame's prediction. No-op solo or until the first snapshot.
function netReconcile() {
  if (!_authDirty || !_authState || !simHull || typeof simMakeState !== 'function') return;
  _authDirty = false;
  const st = simMakeState(_authState.pos);
  st.vel        = _authState.vel.slice();
  st.onGround   = _authState.onGround;  st.wasJump  = _authState.wasJump;
  st.duckAmount = _authState.duckAmount; st.phyDucked = _authState.phyDucked;
  st.prevVelZ   = _authState.prevVelZ;
  while (_pending.length && _pending[0].seq <= _ackSeq) _pending.shift();   // drop acked
  for (const e of _pending) simPlayerMove(simHull, st, e.cmd, e.dt, { wpnMax: e.wpnMax });
  // Write the corrected prediction back into the shared player globals.
  gsPos = st.pos;             vel = st.vel;
  onGround = st.onGround;     wasJump = st.wasJump;
  duckAmount = st.duckAmount; phyDucked = st.phyDucked;
  prevVelZ = st.prevVelZ;
}

// Buffer this frame's predicted cmd for reconciliation and send it to the server.
// Called from physics.js after the local prediction. No-op solo.
function netRecordCmd(cmd, dt, wpnMax) {
  if (!_connected()) return;
  const seq = ++_cmdSeq;
  const c = { forwardMove: cmd.forwardMove, sideMove: cmd.sideMove,
              jump: cmd.jump, duck: cmd.duck, walk: cmd.walk, yaw: cmd.yaw };
  _pending.push({ seq, cmd: c, dt, wpnMax });
  if (_pending.length > 256) _pending.shift();     // safety cap (very high latency)
  _ws.send(JSON.stringify({
    t: 'cmd', seq, dt,
    fm: c.forwardMove, sm: c.sideMove,
    jp: c.jump ? 1 : 0, dk: c.duck ? 1 : 0, wk: c.walk ? 1 : 0,
    y: c.yaw, ws: wpnMax,
    w: (typeof curW === 'function' && curW()) ? curW().id : undefined,
  }));
}

// Upsert a remote player's interpolation target from a snapshot entry.
// Entry keys: p=[x,y,z] gs, v=[x,y,z] vel, y=yaw, og=onGround, dk=duck, m=model, tm=team.
function _onRemoteState(e) {
  const sp = e.v ? Math.hypot(e.v[0], e.v[1]) : (e.sp || 0);
  let inst = remotePlayers.get(e.id);
  if (!inst) {
    inst = { id: e.id, model: e.m, weapon: e.w || 'usp', root: null, ready: false,
             pos: e.p.slice(), tpos: e.p.slice(), yaw: e.y || 0, tyaw: e.y || 0,
             sp: 0, og: 1, dk: 0, curSeq: 'idle1', frame: 0,
             gunRigs: {}, curGun: null, lightCol: new THREE.Color(1, 1, 1) };
    remotePlayers.set(e.id, inst);
    _buildRemote(inst);
  }
  inst.tpos = e.p.slice();
  inst.tyaw = e.y || 0;
  inst.sp = sp;
  inst.og = e.og ? 1 : 0;
  inst.dk = e.dk ? 1 : 0;
  if (e.w) inst.weapon = e.w;
}

// Build the skinned rig for a remote player (mirrors enemy.js / player.js loaders).
function _buildRemote(inst) {
  const name = inst.model || 'leet';
  const make = (data) => {
    if (!remotePlayers.has(inst.id)) return;                // left before the model arrived
    const rig = _buildRig(data.meshes);
    scene.add(rig.root);
    inst.root = rig.root; inst.meshes = rig.meshes;
    inst.originalPositions = rig.originalPositions; inst.boneIndices = rig.boneIndices;
    inst.bones = data.bones;
    inst.seqMap = {}; data.sequences.forEach(s => { inst.seqMap[s.name] = s; });
    const bind = data.sequences.find(s => s.name === (data.bindSeq || 'idle1')) || data.sequences[0];
    inst.bindWorld = computeBoneWorlds(data.bones, bind.frames[0], null, 0);
    inst.nameToIdx = {}; data.bones.forEach((b, i) => { inst.nameToIdx[b.name] = i; });
    inst.hitboxData = data.hitboxes || [];
    if (typeof _buildInstanceHitboxes === 'function') {     // per-bone OBB hitboxes (enemy.js)
      inst.root.updateMatrixWorld(true);
      _buildInstanceHitboxes(inst);
      if (typeof _updateHitboxes === 'function') _updateHitboxes(inst, inst.bindWorld);
    }
    inst.ready = true;
  };
  if (_netModelCache[name]) { make(_netModelCache[name]); return; }
  fetch(`models/player_${name}.json`).then(r => r.json())
    .then(data => { _netModelCache[name] = data; make(data); })
    .catch(err => console.warn('[mp] remote model not loaded:', name, err));
}

// Same gait choice as the local model (_gaitNames), but from the remote's reported state.
function _remoteSeq(inst) {
  if (!inst.og) return inst.seqMap.jump ? 'jump' : 'idle1';
  if (inst.dk)  return (inst.sp > 12 && inst.seqMap.crouchrun) ? 'crouchrun' : 'crouch_idle';
  return inst.sp > 140 ? 'run' : inst.sp > 12 ? 'walk' : 'idle1';
}

// Per-frame: advance/interpolate every remote player. Our own state is sent as
// usercmds from physics.js (netRecordCmd), not here.
function netUpdate(dt) {
  for (const inst of remotePlayers.values()) _updateRemote(inst, dt);
}

function _updateRemote(inst, dt) {
  if (!inst.ready || !inst.root) return;
  // Smooth toward the last received position/yaw (snapshots arrive at 20 Hz).
  const k = Math.min(1, dt * 14);
  for (let i = 0; i < 3; i++) inst.pos[i] += (inst.tpos[i] - inst.pos[i]) * k;
  let dy = (inst.tyaw - inst.yaw) % (Math.PI * 2);
  if (dy >  Math.PI) dy -= Math.PI * 2;
  if (dy < -Math.PI) dy += Math.PI * 2;
  inst.yaw += dy * k;
  inst.root.position.set(inst.pos[0], inst.pos[2], -inst.pos[1]);   // gs → three; feet at origin z
  inst.root.rotation.y = inst.yaw + Math.PI / 2;                    // matches local model body yaw

  // Advance the locomotion sequence (looping), then skin the mesh to the live pose.
  const want = _remoteSeq(inst);
  if (want !== inst.curSeq) { inst.curSeq = want; inst.frame = 0; }
  const seq = inst.seqMap[inst.curSeq] || inst.seqMap.idle1;
  if (!seq || !seq.frames.length) return;
  const fps = seq.fps > 0 ? seq.fps : 30, N = seq.frames.length;
  inst.frame = (inst.frame + dt * fps) % N;
  const i = Math.floor(inst.frame) % N, frac = inst.frame - Math.floor(inst.frame), next = (i + 1) % N;
  const cur = computeBoneWorlds(inst.bones, seq.frames[i], frac > 0.001 ? seq.frames[next] : null, frac);
  _skinRig(inst.meshes, inst.originalPositions, inst.boneIndices, inst.bones, cur, inst.bindWorld);

  inst.root.updateMatrixWorld(true);
  if (inst.hboxes && typeof _updateHitboxes === 'function') _updateHitboxes(inst, cur);  // hitboxes track the live pose
  _updateRemoteWeapon(inst, cur);     // gun rides the hand (same skeleton, by bone name)
  _updateRemoteLight(inst, dt);       // tint by the map's baked floor light (darken in shadow)
}

// ── Weapon held by a remote player ──────────────────────────────────────────
// Lazily load+build the world model (p_<weapon>.json) for the remote's current
// weapon and drive its skeleton with the player's live bone transforms (matched by
// name), exactly like player.js does for the local third-person gun. Gun-only bones
// (flash/muzzle) keep their own bind pose.
const _pModelCache = {};   // weapon id → loaded p_*.json (shared across remotes)

function _updateRemoteWeapon(inst, hostCur) {
  const id = inst.weapon;
  const file = (typeof _GUN_FILES !== 'undefined') ? _GUN_FILES[id] : null;
  // Hide any previously shown gun if the weapon changed.
  if (inst.curGun && inst.curGun !== id && inst.gunRigs[inst.curGun])
    inst.gunRigs[inst.curGun].root.visible = false;
  inst.curGun = id;
  if (!file) return;                                   // unknown/none → no world model

  let rig = inst.gunRigs[id];
  if (rig === undefined) {                             // kick off the (one-time) load
    inst.gunRigs[id] = null;                           // pending sentinel (don't refetch)
    const build = (data) => {
      if (!remotePlayers.has(inst.id) || !inst.root) return;
      const r = _buildRig(data.meshes);
      inst.root.add(r.root);                           // ride along with the player transform
      inst.gunRigs[id] = {
        id, root: r.root, meshes: r.meshes,
        originalPositions: r.originalPositions, boneIndices: r.boneIndices,
        bones: data.bones, bindFrame: data.bindFrame,
        bindWorld: computeBoneWorlds(data.bones, data.bindFrame, null, 0),
      };
    };
    if (_pModelCache[id]) build(_pModelCache[id]);
    else fetch(file).then(r => r.json())
      .then(data => { _pModelCache[id] = data; build(data); })
      .catch(err => console.warn('[mp] world weapon not loaded:', file, err));
    return;
  }
  if (!rig) return;                                    // still loading
  rig.root.visible = true;
  const gunCur = _gunWorldFromHost(rig, hostCur, inst.nameToIdx);
  _skinRig(rig.meshes, rig.originalPositions, rig.boneIndices, rig.bones, gunCur, rig.bindWorld);
}

// Compose the gun skeleton's world transforms from the player's: shared bones (by
// name) copy the host's live world R/T; gun-only bones do FK from their parent with
// their own bind-pose local transform. Mirrors player.js _updateWeaponAttachment but
// works straight off the already-computed host world pose (computeBoneWorlds output).
const _rgMat = new THREE.Matrix4(), _rgTr = new THREE.Vector3();
function _gunWorldFromHost(rig, hostCur, hostNameToIdx) {
  const bones = rig.bones, n = bones.length;
  const R = new Array(n), T = new Array(n);
  for (let i = 0; i < n; i++) {
    const hi = hostNameToIdx ? hostNameToIdx[bones[i].name] : undefined;
    if (hi !== undefined && hostCur.R[hi]) {
      R[i] = hostCur.R[hi]; T[i] = hostCur.T[hi];
    } else {
      const bf = rig.bindFrame[i];
      const mat = boneEulerMat(bf[3], bf[4], bf[5]);
      const tr = new THREE.Vector3(bf[0], bf[1], bf[2]);
      const par = bones[i].parent;
      if (par >= 0 && R[par]) { mat.premultiply(R[par]); tr.applyMatrix4(R[par]).add(T[par]); }
      R[i] = mat; T[i] = tr;
    }
  }
  return { R, T };
}

// ── Remote model lighting (GoldSrc R_LightPoint, like player.js) ─────────────
// Trace to the floor under the player, read the baked lightmap (vertex colors) and
// tint the body + gun so remote models darken in shadow / brighten in light.
const _netLightRay = new THREE.Raycaster();
const _netLightFrom = new THREE.Vector3();
const _NET_DOWN = new THREE.Vector3(0, -1, 0);
function _updateRemoteLight(inst, dt) {
  if (typeof _shellRayTargets === 'undefined' || !_shellRayTargets) return;
  _netLightFrom.set(inst.pos[0], inst.pos[2] + 16, -inst.pos[1]);
  _netLightRay.set(_netLightFrom, _NET_DOWN); _netLightRay.far = 4096;
  const hits = _netLightRay.intersectObjects(_shellRayTargets, false);
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
  inst.lightCol.r += (r - inst.lightCol.r) * k;
  inst.lightCol.g += (g - inst.lightCol.g) * k;
  inst.lightCol.b += (b - inst.lightCol.b) * k;
  for (const m of inst.meshes) m.material.color.copy(inst.lightCol);
  const gun = inst.gunRigs[inst.curGun];
  if (gun) for (const m of gun.meshes) m.material.color.copy(inst.lightCol);
}

function _removeRemote(id) {
  const inst = remotePlayers.get(id);
  if (inst && inst.root) scene.remove(inst.root);
  remotePlayers.delete(id);
}
function _clearRemotes() {
  for (const inst of remotePlayers.values()) if (inst.root) scene.remove(inst.root);
  remotePlayers.clear();
}
