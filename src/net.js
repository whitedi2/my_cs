// net.js — multiplayer client (Phase 5, step 1: movement sync).
// Classic script, shared global scope. Loads after player.js (reuses _buildRig / _skinRig)
// and weapons.js (computeBoneWorlds); driven each frame from input.js's loop.
//
// Talks to server.js (a dumb relay): we send our own player snapshot ~20×/s and receive
// everyone else's, rendering each remote player with the same skinned rig as the local
// 3rd-person model. NON-authoritative — no server-side hit-reg yet (see docs/PLAN.md).
// If no relay is running the connection just fails silently and the game stays single-player.

const NET_TICK = 0.05;                  // send our state every 50 ms (20 Hz)
const NET_URL  = `ws://${location.hostname || 'localhost'}:8081`;

let _ws = null, _myId = null, _netT = 0;
const remotePlayers = new Map();        // id → instance (rig + anim state + interp targets)
const _netModelCache = {};              // model name → loaded JSON (shared across instances)

function netConnect() {
  if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return;   // already (re)connecting
  try { _ws = new WebSocket(NET_URL); } catch (e) { return; }
  _ws.onopen    = () => console.log('[mp] connected to', NET_URL);
  _ws.onclose   = () => { _myId = null; _clearRemotes(); };
  _ws.onerror   = () => {};             // silent: no relay running → stay single-player
  _ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } _onNetMsg(m); };
}

function _onNetMsg(m) {
  switch (m.t) {
    case 'welcome': _myId = m.id; break;
    case 'join':    break;                                  // instance is created lazily on first state
    case 'leave':   _removeRemote(m.id); break;
    case 'state':   if (m.id !== _myId) _onRemoteState(m); break;
  }
}

// Upsert a remote player's interpolation target from a received snapshot.
// Snapshot keys (kept short): p=[x,y,z] gs, y=yaw, sp=speed, og=onGround, dk=duck, m=model, tm=team.
function _onRemoteState(m) {
  let inst = remotePlayers.get(m.id);
  if (!inst) {
    inst = { id: m.id, model: m.m, root: null, ready: false,
             pos: m.p.slice(), tpos: m.p.slice(), yaw: m.y || 0, tyaw: m.y || 0,
             sp: 0, og: 1, dk: 0, curSeq: 'idle1', frame: 0 };
    remotePlayers.set(m.id, inst);
    _buildRemote(inst);
  }
  inst.tpos = m.p.slice();
  inst.tyaw = m.y || 0;
  inst.sp = m.sp || 0;
  inst.og = m.og ? 1 : 0;
  inst.dk = m.dk ? 1 : 0;
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

// Per-frame: send our snapshot (throttled) and advance/interp every remote player.
function netUpdate(dt) {
  if (_ws && _ws.readyState === 1 && _myId != null && gsPos) {
    _netT += dt;
    if (_netT >= NET_TICK) {
      _netT = 0;
      _ws.send(JSON.stringify({
        t: 'state',
        p: [gsPos[0], gsPos[1], gsPos[2]],
        y: yaw,
        sp: vel ? Math.hypot(vel[0], vel[1]) : 0,
        og: onGround ? 1 : 0,
        dk: phyDucked ? 1 : 0,
        m: (typeof playerModelName !== 'undefined' && playerModelName) ? playerModelName : 'gign',
        tm: (typeof playerTeam !== 'undefined') ? playerTeam : 'ct',
      }));
    }
  }
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
