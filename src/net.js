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
const remotePlayers = new Map();          // id → instance (rig + anim state + snapshot buffer)
const _netModelCache = {};                // model name → loaded JSON (shared across instances)

// Snapshot interpolation (Phase 5, step C). Snapshots carry a monotonic server time
// `svt`; we render remote players at `_renderSvt = newestSvt − NET_INTERP_MS`, blending
// the two buffered snapshots that bracket it. This trades a fixed ~100 ms delay for
// smooth motion under jitter/loss, and `_renderSvt` is exactly the time we tell the
// server we were aiming at, so its lag-comp rewind matches what we saw.
const NET_INTERP_MS = 100;
let _newestSvt = 0;                        // newest server time we've received
let _renderSvt = 0;                        // server time we're currently rendering remotes at

function _connected() { return _ws && _ws.readyState === 1 && _myId != null; }

// Connect to the server. `join=false` connects just to read status / lobby (no hello, so
// the server keeps us out of the match until we pick a team); `join=true` also sends our
// identity (hello) once open — or immediately if we're already connected.
let _wantHello = false;
function netConnect(join) {
  if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) {
    if (join) { _wantHello = true; if (_ws.readyState === 1) netHello(); }
    return;
  }
  _wantHello = !!join;
  _setMpStatus('connecting');
  try { _ws = new WebSocket(NET_URL); } catch (e) { _setMpStatus('offline'); return; }
  _ws.onopen    = () => { console.log('[mp] connected to', NET_URL); _setMpStatus('connected'); if (_wantHello) netHello(); };
  _ws.onclose   = () => {
    _myId = null; _ackSeq = 0; _pending.length = 0;
    _authState = null; _authDirty = false; _clearRemotes();
    _setMpStatus('offline');
    if (typeof onNetRoundReset === 'function') onNetRoundReset();   // resume local rounds
  };
  _ws.onerror   = () => { _setMpStatus('offline'); };   // no server → stay single-player
  _ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } _onNetMsg(m); };
}

// Reflect the connection / match state in the start menu (Phase 6A lobby).
function _setMpStatus(state, gs) {
  const el = (typeof document !== 'undefined') && document.getElementById('mp-status');
  if (!el) return;
  let txt, col;
  if (state === 'connected') {
    const online = gs ? gs.online : null;
    txt = online != null ? `● Сервер: онлайн (${online})` : '● Сервер: подключён';
    col = '#6bd16b';
  } else if (state === 'connecting') { txt = '○ Подключение к серверу…'; col = '#e8c34a'; }
  else                               { txt = '○ Сервер недоступен — соло'; col = '#c98a8a'; }
  if (gs && gs.map) txt += ` · карта: ${gs.map}`;
  el.textContent = txt; el.style.color = col;
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
    case 'dmg':     _onDamage(m); break;
    case 'gstate':  _onGState(m); break;
    case 'bought':  _onBought(m); break;
  }
}

// Server reply to a buy intent (Phase 6C): flash the result; on a successful weapon buy
// equip it locally (full ammo). Money/inventory state syncs via gstate.me.
function _onBought(m) {
  if (typeof _flashBuy === 'function') _flashBuy(m.ok ? 'Куплено' : (m.reason || 'Не куплено'));
  if (m.ok && m.kind === 'weapon' && m.id && typeof WPNS !== 'undefined') {
    if (typeof ownedWeapons !== 'undefined') ownedWeapons.add(m.id);   // optimistic; gstate.me confirms
    const idx = WPNS.findIndex(w => w.id === m.id);
    if (idx >= 0) {
      const w = WPNS[idx];
      if (w.maxAmmo) { w.ammo = w.maxAmmo; w.reserve = w._reserve0 != null ? w._reserve0 : w.reserve; }
      if (typeof switchWeapon === 'function') switchWeapon(idx);
    }
  }
}

// Client → server: a buy intent (the server validates money/phase/zone/team and grants).
function netSendBuy(id) {
  if (!_connected() || !id) return;
  _ws.send(JSON.stringify({ t: 'buy', id }));
}

// Authoritative match state from the server (Phase 6A/6B): round HUD + lobby + our own HP.
function _onGState(m) {
  _setMpStatus('connected', m);
  if (typeof applyServerRound === 'function') applyServerRound(m);
  if (m.me && typeof applyServerSelf === 'function') applyServerSelf(m.me);
}

// An authoritative damage/death event from the server (Phase 6B). For us → HUD/HP +
// hurt/death feedback (game.js). For a remote → flinch, or play the death animation and
// freeze the corpse. Revival (round respawn) comes from the snapshot `al` flag.
function _onDamage(m) {
  if (m.id === _myId) {
    if (typeof onServerDamage === 'function') onServerDamage(m.hg | 0, m.hp | 0, !!m.died, m.by | 0);
    return;
  }
  const inst = remotePlayers.get(m.id);
  if (!inst) return;
  if (m.died) {
    inst.dead = true; inst.frame = 0;
    inst.deathSeq = _pickDeathSeq(inst, m.hg | 0);
    inst.flinchT = 0;
  } else if (inst.flinch) {
    const hg = m.hg | 0;
    const seq = (hg === 1 && inst.flinch['head_flinch']) ? 'head_flinch' : 'gut_flinch';
    if (inst.flinch[seq]) { inst.flinchSeq = seq; inst.flinchFrame = 0; inst.flinchT = inst.flinchDur || 0.22; }
  }
}

// Death sequence by hitgroup (head/gutshot specials, else a random death1..3). Null if
// the model carries none (no --deaths export) — the corpse then just freezes upright.
function _pickDeathSeq(inst, hg) {
  if (!inst.seqMap) return null;
  if (hg === 1 && inst.seqMap['head'])    return 'head';
  if (hg === 3 && inst.seqMap['gutshot']) return 'gutshot';
  const deaths = ['death1', 'death2', 'death3'].filter(n => inst.seqMap[n]);
  return deaths.length ? deaths[Math.floor(Math.random() * deaths.length)] : null;
}

// Shooter → server: report a MELEE (knife) hit on a remote player. Bullet hitreg is
// server-side now (see netSendShot); the knife stays shooter-reported. No-op solo.
function netSendHit(targetId, hg, dmg) {
  if (!_connected()) return;
  _ws.send(JSON.stringify({ t: 'hit', target: targetId, hg, dmg }));
}

// Shooter → server: a bullet's ray (GoldSrc origin + dir) for authoritative,
// lag-compensated hitreg. We send `svt` = the exact server time we're rendering our
// targets at, so the server rewinds them to that instant before testing the ray. The
// server computes the damage (weapon × falloff × hitgroup) and forwards it to victims.
function netSendShot(o, d, weaponId, silenced) {
  if (!_connected()) return;
  _ws.send(JSON.stringify({ t: 'shot', o, d, w: weaponId, s: silenced ? 1 : 0, svt: _renderSvt }));
}

// Apply an authoritative snapshot: track the server time, stash our own state for
// reconciliation, and buffer every other player's state for interpolation.
function _onSnapshot(m) {
  if (m.ack != null && m.ack > _ackSeq) _ackSeq = m.ack;
  const svt = (typeof m.svt === 'number') ? m.svt : (_newestSvt + 50);   // fallback: assume 20 Hz
  if (svt > _newestSvt) _newestSvt = svt;
  for (const e of (m.players || [])) {
    if (e.id === _myId) {
      _authState = {
        pos: e.p.slice(), vel: (e.v || [0, 0, 0]).slice(),
        onGround: !!e.og, wasJump: !!e.wj, duckAmount: e.da || 0,
        phyDucked: !!e.dk, prevVelZ: e.pz || 0,
      };
      _authDirty = true;
    } else {
      _onRemoteState(e, svt);
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
    y: c.yaw, ws: wpnMax,                 // ws = weapon run-speed cap (NOT the state machine)
    w: (typeof curW === 'function' && curW()) ? curW().id : undefined,
    // Third-person presentation for our remote avatar on other clients: look pitch +
    // the weapon state machine (so they see us aim up/down, fire, reload). Authoritative
    // movement ignores these; the server just relays them in the snapshot.
    pi: (typeof pitch !== 'undefined') ? pitch : 0,
    wsv: (typeof ws !== 'undefined') ? ws : 0,
    wsp: (typeof wsT !== 'undefined') ? wsT : 0,
  }));
}

// Buffer a remote player's snapshot sample (tagged with server time `svt`) for
// interpolation. Entry keys: p=[x,y,z] gs, v=[x,y,z] vel, y=yaw, pi=pitch, og=onGround,
// dk=duck, da=duckAmount, wsv=weapon-state, wsp=weapon-state time, m=model, tm=team, w=weapon.
function _onRemoteState(e, svt) {
  let inst = remotePlayers.get(e.id);
  if (!inst) {
    inst = { id: e.id, model: e.m, weapon: e.w || 'usp', root: null, ready: false,
             buf: [], pos: e.p.slice(), yaw: e.y || 0, phase: 0,
             dead: false, deathSeq: null, frame: 0, flinchSeq: 'gut_flinch', flinchFrame: 0,
             gunRigs: {}, lightCol: new THREE.Color(1, 1, 1),
             handWorld: new THREE.Vector3(), muzzleWorld: new THREE.Vector3() };
    remotePlayers.set(e.id, inst);
    _buildRemote(inst);
  } else if (e.m && e.m !== inst.model) {
    // Team/model switch → rebuild the rig with the new model (keeps the snapshot buffer).
    if (inst.root) scene.remove(inst.root);
    inst.model = e.m; inst.root = null; inst.ready = false;
    inst.gunRigs = {};
    _buildRemote(inst);
  }
  if (e.w) inst.weapon = e.w;
  if (e.al && inst.dead) inst.dead = false;   // server revived them (round respawn) → clear corpse
  inst.buf.push({
    svt,
    pos: e.p.slice(), yaw: e.y || 0, pitch: e.pi || 0,
    vel: (e.v || [0, 0, 0]).slice(),
    og: e.og ? 1 : 0, dk: e.dk ? 1 : 0, da: e.da || 0,
    ws: (e.wsv !== undefined) ? e.wsv : 0, wsT: (e.wsv !== undefined) ? (e.wsp || 0) : 0,
  });
  while (inst.buf.length > 40) inst.buf.shift();   // ~2 s of history at 20 Hz
}

// Interpolate a remote's buffered samples at server time `rsvt`. Holds the nearest end
// when rsvt falls outside the buffer (start-up / stall → no extrapolation, just freeze).
function _sampleRemote(inst, rsvt) {
  const buf = inst.buf;
  if (!buf || !buf.length) return null;
  if (buf.length === 1 || rsvt <= buf[0].svt) return _bufCopy(buf[0]);
  if (rsvt >= buf[buf.length - 1].svt) return _bufCopy(buf[buf.length - 1]);
  for (let i = buf.length - 1; i > 0; i--) {
    const b = buf[i], a = buf[i - 1];
    if (rsvt >= a.svt && rsvt <= b.svt) {
      const span = b.svt - a.svt;
      return _lerpSample(a, b, span > 0 ? (rsvt - a.svt) / span : 0);
    }
  }
  return _bufCopy(buf[buf.length - 1]);
}
function _bufCopy(s) {
  return { pos: s.pos.slice(), yaw: s.yaw, pitch: s.pitch, vel: s.vel.slice(),
           da: s.da, og: s.og, dk: s.dk, ws: s.ws, wsT: s.wsT };
}
function _lerpSample(a, b, f) {
  const lp = (x, y) => x + (y - x) * f;
  let dy = (b.yaw - a.yaw) % (Math.PI * 2);
  if (dy >  Math.PI) dy -= Math.PI * 2;
  if (dy < -Math.PI) dy += Math.PI * 2;
  const sameWs = a.ws === b.ws;
  return {
    pos: [lp(a.pos[0], b.pos[0]), lp(a.pos[1], b.pos[1]), lp(a.pos[2], b.pos[2])],
    yaw: a.yaw + dy * f, pitch: lp(a.pitch, b.pitch),
    vel: b.vel,                                   // velocity: latest (drives gait direction)
    da: lp(a.da, b.da), og: (f < 0.5 ? a.og : b.og), dk: (f < 0.5 ? a.dk : b.dk),
    ws: b.ws, wsT: sameWs ? lp(a.wsT, b.wsT) : b.wsT,
  };
}

// Build the skinned rig for a remote player. Uses the shared _initModelRig (player.js)
// so the remote carries the SAME animation data (aim sets, upper/lower split, twist
// map, sequences) the local third-person model does — they animate through one core.
function _buildRemote(inst) {
  const name = inst.model || 'leet';
  const make = (data) => {
    if (!remotePlayers.has(inst.id)) return;                // left before the model arrived
    const rig = _buildRig(data.meshes);
    scene.add(rig.root);
    inst.root = rig.root; inst.meshes = rig.meshes;
    inst.originalPositions = rig.originalPositions; inst.boneIndices = rig.boneIndices;
    _initModelRig(inst, data);                              // bones, seqs, aim sets, split, twist map, bind pose
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

// Per-frame: advance the interpolation clock, then render every remote player at it.
// Our own avatar is sent as usercmds from physics.js (netRecordCmd), not here.
function netUpdate(dt) {
  // Render ~NET_INTERP_MS behind the newest snapshot. Advance in real time; resync hard
  // after a stall / before the first snapshot (when the gap to the target is large).
  const target = _newestSvt - NET_INTERP_MS;
  if (_renderSvt === 0 || Math.abs(target - _renderSvt) > 250) _renderSvt = target;
  else { _renderSvt += dt * 1000; if (_renderSvt > target) _renderSvt = target; }

  for (const inst of remotePlayers.values()) _updateRemote(inst, dt);
}

const _ZERO3 = [0, 0, 0];

// Sample the remote's buffered snapshots at the interpolation time, then drive it
// through the SAME third-person animation core as our local model (player.js
// animateThirdPerson): gait + leg twist, stand↔crouch blend, upper-body aim by pitch,
// shoot/reload gestures, weapon-in-hand, map lighting and OBB hitboxes.
function _updateRemote(inst, dt) {
  if (!inst.ready || !inst.root) return;
  const s = _sampleRemote(inst, _renderSvt);
  if (!s) return;
  inst.pos = s.pos; inst.yaw = s.yaw; inst.dk = s.dk;   // latest interp pose (corpse/light/backstab/hit-predict)

  // Dead → play the death animation and freeze the corpse (no gait/aim/gun).
  if (inst.dead) { _updateRemoteDead(inst, dt); return; }

  if (typeof animateThirdPerson === 'function')
    animateThirdPerson(inst, {
      pos: s.pos, vel: s.vel || _ZERO3, yaw: s.yaw, pitch: s.pitch || 0,
      onGround: !!s.og, duckAmount: s.da || 0, phyDucked: !!s.dk,
      weaponId: inst.weapon, weaponType: _weaponTypeOf(inst.weapon),
      ws: s.ws || 0, wsT: s.wsT || 0,
    }, dt);
}

// Play a remote's death sequence (once, hold the last frame) and freeze the corpse on
// the floor. Reuses the same skin + hitbox path as a live model; the gun is hidden.
function _updateRemoteDead(inst, dt) {
  const seq = (inst.deathSeq && inst.seqMap[inst.deathSeq]) || inst.seqMap.idle1;
  if (!seq || !seq.frames.length) return;
  const fps = seq.fps > 0 ? seq.fps : 30, N = seq.frames.length;
  inst.frame = Math.min((inst.frame || 0) + dt * fps, N - 1);
  const i = Math.floor(inst.frame), frac = inst.frame - i, next = Math.min(i + 1, N - 1);
  const cur = computeBoneWorlds(inst.bones, seq.frames[i], (frac > 0.001 && next > i) ? seq.frames[next] : null, frac);

  inst.root.rotation.y = inst.yaw + Math.PI / 2;
  inst.root.position.set(inst.pos[0], inst.pos[2], -inst.pos[1]);   // origin at pos.z (stand offset)
  inst.root.updateMatrixWorld(true);
  _skinRig(inst.meshes, inst.originalPositions, inst.boneIndices, inst.bones, cur, inst.bindWorld);
  for (const k in inst.gunRigs) { const g = inst.gunRigs[k]; if (g) g.root.visible = false; }   // drop the gun from view
  if (inst.hboxes && typeof _updateHitboxes === 'function') _updateHitboxes(inst, cur);
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
