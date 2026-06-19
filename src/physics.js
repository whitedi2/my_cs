// physics.js — BSP hull trace + GoldSrc player movement.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── BSP Hull Trace ────────────────────────────────────────────────────────
// GoldSrc space: Z-up, X-east, Y-north
// Three.js ↔ GoldSrc: (tx,ty,tz) ↔ (tx,-tz,ty)

const CONTENTS_SOLID = -2;
const DIST_EPS       = 0.03125;

let gPlanes, gClipnodes, gHullHead;
let gEntitySolidHeads     = [];
let gEntitySolidHeadsDuck = [];

function pointContents(node, p) {
  while (node >= 0) {
    const cn = gClipnodes[node];
    const pl = gPlanes[cn[0]];
    node = (pl[0]*p[0] + pl[1]*p[1] + pl[2]*p[2] - pl[3]) < 0 ? cn[2] : cn[1];
  }
  return node;
}

// hullHead = root node of THIS model (constant through recursion, used for back-step check)
// node     = current tree node being visited (changes through recursion)
function _check(hullHead, node, p1f, p2f, p1, p2, tr) {
  if (node < 0) {
    if (node !== CONTENTS_SOLID) { tr.allsolid = false; }
    else { tr.startsolid = true; }
    return true;
  }
  const cn = gClipnodes[node];
  const pl = gPlanes[cn[0]];
  const t1 = pl[0]*p1[0] + pl[1]*p1[1] + pl[2]*p1[2] - pl[3];
  const t2 = pl[0]*p2[0] + pl[1]*p2[1] + pl[2]*p2[2] - pl[3];

  if (t1 >= 0 && t2 >= 0) return _check(hullHead, cn[1], p1f, p2f, p1, p2, tr);
  if (t1 <  0 && t2 <  0) return _check(hullHead, cn[2], p1f, p2f, p1, p2, tr);

  const frac = Math.max(0, Math.min(1,
    t1 < 0 ? (t1 + DIST_EPS)/(t1-t2) : (t1 - DIST_EPS)/(t1-t2)));
  const midf = p1f + (p2f-p1f)*frac;
  const mid  = [p1[0]+frac*(p2[0]-p1[0]), p1[1]+frac*(p2[1]-p1[1]), p1[2]+frac*(p2[2]-p1[2])];
  const side = t1 < 0 ? 1 : 0;
  if (!_check(hullHead, cn[1+side], p1f, midf, p1, mid, tr)) return false;
  if (pointContents(cn[2-side], mid) !== CONTENTS_SOLID)
    return _check(hullHead, cn[2-side], midf, p2f, mid, p2, tr);
  if (tr.allsolid) return false;

  const s = side === 0 ? 1 : -1;
  tr.plane = [s*pl[0], s*pl[1], s*pl[2], s*pl[3]];

  let ff = frac;
  for (let i = 0; i < 12; i++) {
    const ep = [p1[0]+ff*(p2[0]-p1[0]), p1[1]+ff*(p2[1]-p1[1]), p1[2]+ff*(p2[2]-p1[2])];
    if (pointContents(hullHead, ep) !== CONTENTS_SOLID) break;
    ff = Math.max(0, ff - 0.1);
  }
  tr.fraction = p1f + (p2f-p1f)*ff;
  tr.end = [p1[0]+ff*(p2[0]-p1[0]), p1[1]+ff*(p2[1]-p1[1]), p1[2]+ff*(p2[2]-p1[2])];
  return false;
}

function traceMove(from, to) {
  // Trace world model first
  const tr = { fraction:1.0, end:[...to], plane:null, startsolid:false, allsolid:true };
  _check(gHullHead, gHullHead, 0, 1, from, to, tr);
  // Trace each solid brush entity using matching hull (duck hull3 or stand hull1)
  const entityHeads = (gHullHead === gHullHeadDuck) ? gEntitySolidHeadsDuck : gEntitySolidHeads;
  for (const head of entityHeads) {
    if (head < 0) continue;   // empty-hull entity, skip fast
    const t2 = { fraction:1.0, end:[...to], plane:null, startsolid:false, allsolid:true };
    _check(head, head, 0, 1, from, to, t2);
    if (t2.fraction < tr.fraction) {
      tr.fraction = t2.fraction; tr.end = t2.end;
      tr.plane = t2.plane; tr.startsolid = t2.startsolid; tr.allsolid = t2.allsolid;
    }
  }
  return tr;
}

// ── Player physics ────────────────────────────────────────────────────────
let gsPos, vel, onGround, wasJump;
let gsSpawn = null, gsSpawnYaw = 0;   // reference CT spawn[0] (stable anchor, e.g. for the dummies)
let spawnPoints = { ct: [], t: [] };  // all team spawn points (origin + angle) from the BSP
let buyZones    = [];                 // func_buyzone AABBs {min,max,team} from the BSP
let bombSites   = [];                 // func_bomb_target AABBs {min,max,site:'a'|'b'} from the BSP
let playerTeam  = 'ct';               // current team — picks which spawns respawn() uses

// GoldSrc entity yaw (deg, 0=+X, 90=+Y) → our yaw. forward(yaw)=(-sin,cos) in GoldSrc,
// entity forward=(cos θ,sin θ) → yaw = θ − 90°.
function _angleToYaw(deg) { return (deg - 90) * Math.PI / 180; }
let duckAmount = 0;          // 0 = standing, 1 = fully crouched
let phyDucked  = false;      // duck hull (hull3) is physically active
let smoothCamY = null;       // smoothed camera Y for stair interpolation
let duckViewOfs = 0;         // smoothed duck-hull view offset (px) — avoids crouch-jump dip
let punchPitch = 0;          // landing view-kick offset (radians)
let punchVel   = 0;          // spring velocity for punch
let punchRoll  = 0;          // landing view-roll (tilt to one side, radians)
let punchRollVel = 0;        // spring velocity for roll
let recoilPitch = 0;         // gun recoil: vertical angle (positive = up)
let recoilYaw   = 0;         // gun recoil: horizontal angle (negative = right)
let lastShotAge = 999;       // seconds since last shot — gates recoil accumulate vs recover
let xhairGap     = 0;        // crosshair expansion from FIRING (px): always shown, slow contract
let xhairMoveGap = 0;        // crosshair expansion from MOVEMENT (px): gated by cl_dynamiccrosshair
let prevVelZ   = 0;          // z-velocity from previous frame (for landing detection)
let gHullHeadStand, gHullHeadDuck;
let simHull = null;          // sim-core hull wrapper (shared movement core) — built in initPhysics
let localSt = null;          // reusable sim-core state object for the local player

// Fall damage (CS player.h): no hurt below 500 u/s, fatal (100 dmg) at 1100 u/s,
// linear between. DMG_FALL bypasses armor. dmg = (fallspeed − 500) · 100/(1100−500).
const FALL_SAFE_SPEED       = 500.0;
const FALL_FATAL_SPEED      = 1100.0;
const FALL_DAMAGE_PER_SPEED = 100.0 / (FALL_FATAL_SPEED - FALL_SAFE_SPEED);

const SV = CONFIG;

function initPhysics(hull) {
  gPlanes            = hull.planes;
  gClipnodes         = hull.clipnodes;
  gHullHeadStand     = hull.hull1_head;
  gHullHeadDuck      = hull.hull3_head ?? hull.hull1_head;
  gHullHead          = gHullHeadStand;
  gEntitySolidHeads     = hull.solid_heads      || [];
  gEntitySolidHeadsDuck = hull.solid_heads_duck || gEntitySolidHeads;
  // Shared deterministic core (sim-core.js) drives local prediction; same wrapper the
  // server builds. Built once here from the loaded hull JSON.
  if (typeof simMakeHull === 'function') simHull = simMakeHull(hull);

  // All spawn points from the BSP (origin + real yaw from "angles").
  spawnPoints.ct = (hull.spawns && hull.spawns.ct) || [];
  spawnPoints.t  = (hull.spawns && hull.spawns.t)  || [];
  buyZones = hull.buyzones || [];
  bombSites = hull.bombsites || [];
  // Stable reference = first CT spawn (used to anchor the test dummies).
  const ref = spawnPoints.ct[0];
  gsSpawn = ref ? [...ref.origin] : [0, 0, 200];
  gsSpawn[2] += 1;
  gsSpawnYaw = ref ? _angleToYaw(ref.angle || 0) : 0;
  respawn();
}

// Pick a spawn point for the given team and place the player there facing the
// point's fixed angle. CS assigns spawns sequentially at round start; for this
// sandbox we pick a random one each respawn (shows the different fixed view angles).
function pickSpawn(team) {
  const list = (spawnPoints[team] && spawnPoints[team].length) ? spawnPoints[team] : spawnPoints.ct;
  const sp = (list && list.length) ? list[Math.floor(Math.random() * list.length)] : null;
  if (sp) {
    gsPos = [sp.origin[0], sp.origin[1], sp.origin[2] + 1];
    yaw   = _angleToYaw(sp.angle || 0);
  } else {
    gsPos = [...gsSpawn];
    yaw   = gsSpawnYaw;
  }
}

// Reset the player to a (re)spawn point. Used by initPhysics and the menu.
function respawn() {
  // Driven mode (Phase 6E): the SERVER owns the spawn position — it assigns a distinct spawn at
  // round start and the snapshot/reconciliation places us. So don't pick a spawn or netHello here
  // (that would fight the server); just reset local view/recoil so the new round starts clean.
  if (typeof _netDriven !== 'undefined' && _netDriven) {
    recoilPitch = recoilYaw = 0;
    punchPitch = punchVel = punchRoll = punchRollVel = 0;
    pitch = 0;
    return;
  }
  pickSpawn(playerTeam);
  vel = [0, 0, 0];
  onGround = false;
  wasJump  = false;
  prevVelZ = 0;            // clear fall-velocity so respawning doesn't re-trigger fall damage
  duckAmount = 0;
  phyDucked  = false;
  duckViewOfs = 0;
  smoothCamY = null;
  recoilPitch = recoilYaw = 0;
  punchPitch = punchVel = punchRoll = punchRollVel = 0;
  pitch = 0;
  // Spawn "gear-up" sound — the original plays the gun-pickup/equip sound on (re)spawn.
  // At map-load init this is silent (audio context isn't up yet, so playSound no-ops);
  // it fires on the real spawns: team select (setTeam) and the restart button.
  if (typeof playSound === 'function') playSound('items/gunpickup2.wav', { volume: 0.8 });
  // Multiplayer: a (re)spawn teleports us — resync the authoritative server to the new
  // pose so it doesn't reconcile us back to the old spot. No-op solo / before connect.
  if (typeof netHello === 'function') netHello();
}

// Switch team and respawn at that team's points (called by the team-select menu).
function setTeam(team) {
  playerTeam = (team === 't') ? 't' : 'ct';
  respawn();
}

function categorize() {
  // GoldSrc PM_CategorizePosition: when moving up fast (just jumped), you're
  // airborne — don't trace for the floor. Without this guard, on high-refresh
  // monitors (tiny dt) the player rises <2u in the frame after a jump, the
  // downward trace still hits the floor, onGround flips back true and vel[2] is
  // zeroed — so the jump only "twitches up" and rarely takes off. 180 = engine value.
  if (vel[2] > 180) { onGround = false; return; }
  const down = [gsPos[0], gsPos[1], gsPos[2] - 2];
  const tr   = traceMove(gsPos, down);
  onGround = tr.fraction < 1 && tr.plane && tr.plane[2] > 0.7;
  if (onGround && tr.fraction > 0) gsPos = [...tr.end];
}

function applyFriction(dt) {
  const spd = Math.hypot(vel[0], vel[1]);
  if (spd < 1) { vel[0] = vel[1] = 0; return; }
  const drop  = Math.max(spd, SV.stopspeed) * SV.friction * dt;
  const scale = Math.max(0, spd - drop) / spd;
  vel[0] *= scale; vel[1] *= scale;
}

function accel(wishDir, wishSpd, ac, dt) {
  const cur = vel[0]*wishDir[0] + vel[1]*wishDir[1] + vel[2]*wishDir[2];
  const add = wishSpd - cur;
  if (add <= 0) return;
  const a = Math.min(ac * wishSpd * dt, add);
  vel[0] += a*wishDir[0]; vel[1] += a*wishDir[1]; vel[2] += a*wishDir[2];
}

function slideMove(dt) {
  let timeLeft = dt;
  const hitPlanes = [];
  for (let bump = 0; bump < 4 && timeLeft > 0; bump++) {
    const dest = [gsPos[0]+vel[0]*timeLeft, gsPos[1]+vel[1]*timeLeft, gsPos[2]+vel[2]*timeLeft];
    const tr   = traceMove(gsPos, dest);
    // Anti fall-through: if the origin is already embedded in geometry the trace
    // returns end=dest *through* solid (clipping into a slope/box → falling out
    // of the world). Don't accept that move — stop, or un-embed by pushing up.
    if (tr.allsolid) { vel[0] = vel[1] = vel[2] = 0; break; }
    if (tr.startsolid) {
      let freeZ = null;
      for (let i = 1; i <= 36; i++) {
        const p = [gsPos[0], gsPos[1], gsPos[2] + i];
        if (!traceMove(p, p).startsolid) { freeZ = gsPos[2] + i; break; }
      }
      if (freeZ !== null) gsPos[2] = freeZ;
      else { vel[0] = vel[1] = vel[2] = 0; }
      if (vel[2] < 0) vel[2] = 0;
      break;
    }
    gsPos = [...tr.end];
    timeLeft -= timeLeft * tr.fraction;
    if (tr.fraction === 1 || !tr.plane) break;
    hitPlanes.push(tr.plane);
    for (const pl of hitPlanes) {
      const dot = vel[0]*pl[0] + vel[1]*pl[1] + vel[2]*pl[2];
      if (dot >= 0) continue;
      // Floor surface on ground: only cancel downward velocity, preserve horizontal speed
      if (pl[2] > 0.7 && onGround) {
        if (vel[2] < 0) vel[2] = 0;
      } else {
        vel[0] -= dot*pl[0]; vel[1] -= dot*pl[1]; vel[2] -= dot*pl[2];
      }
    }
  }
}

function playerMove(dt) {
  // ── Build this frame's usercmd from input ──────────────────────────────
  // Same input mapping as before, expressed as a usercmd so the shared
  // deterministic core (sim-core.js) drives both this local prediction AND the
  // authoritative server. The client-only tail (view punch, recoil, camera) is below.
  const wantDuck  = keys['ControlLeft'] || keys['ControlRight'];
  const walk      = keys['ShiftLeft'] || keys['ShiftRight'];
  const arrowMove = !thirdPerson;   // 3rd-person arrows orbit the camera, not move
  let fm = 0, sm = 0;
  if (keys['KeyW'] || (arrowMove && keys['ArrowUp']))    fm += 1;
  if (keys['KeyS'] || (arrowMove && keys['ArrowDown']))  fm -= 1;
  if (keys['KeyD'] || (arrowMove && keys['ArrowRight'])) sm += 1;
  if (keys['KeyA'] || (arrowMove && keys['ArrowLeft']))  sm -= 1;
  let wpnMax = (typeof curW === 'function' && curW().maxSpeed) || SV.maxspeed;
  if (typeof isScoped === 'function' && isScoped()) wpnMax = curW().zoomSpeed || wpnMax;
  const cmd = { forwardMove: fm, sideMove: sm, jump: !!keys['Space'],
                duck: !!wantDuck, walk: !!walk, yaw };

  // Multiplayer: fold in any pending server correction (reset to the authoritative
  // state + replay still-unacked cmds) BEFORE predicting this frame. No-op solo.
  if (typeof netReconcile === 'function') netReconcile();

  // ── Run the shared movement core on our local state ────────────────────
  // Pack the module globals into the explicit state object, tick, unpack back.
  if (!localSt) localSt = simMakeState(gsPos);
  localSt.pos = gsPos;             localSt.vel = vel;
  localSt.onGround = onGround;     localSt.wasJump = wasJump;
  localSt.duckAmount = duckAmount; localSt.phyDucked = phyDucked;
  localSt.prevVelZ = prevVelZ;

  const ev = simPlayerMove(simHull, localSt, cmd, dt, { wpnMax });

  gsPos = localSt.pos;             vel = localSt.vel;
  onGround = localSt.onGround;     wasJump = localSt.wasJump;
  duckAmount = localSt.duckAmount; phyDucked = localSt.phyDucked;
  prevVelZ = localSt.prevVelZ;
  // The +19 stand-up teleport already accounts for the crouch view offset — snap it
  // so the camera doesn't dip (sim-core reports the teleport via ev.stoodUp).
  if (ev.stoodUp) duckViewOfs = 0;

  // Multiplayer: buffer this cmd for reconciliation + send it to the server. Solo no-op.
  if (typeof netRecordCmd === 'function') netRecordCmd(cmd, dt, wpnMax);

  // ── Client-only landing side effects (from the core's reported event) ──
  // Crouch-landing settle: pure ROLL (tilt to one side) when you held crouch through
  // the jump and land ducked. A normal jump is too soft to register.
  if (ev.landed && duckAmount > 0.5) {
    const impact = ev.fallVel;                 // downward speed at touchdown
    const soft   = SV.jumpvel - 95;            // ~150
    if (impact > soft) {
      const rAngle = Math.min((impact - soft) * 0.0006, 0.12);   // radians (~3–7°)
      punchRoll = rAngle * (Math.random() < 0.5 ? 1 : -1);
    }
  }
  // Fall damage (CS FlPlayerFallDamage): any landing over the safe threshold hurts;
  // armor doesn't help. (HP stays client-side until server-side hit-reg, step D.)
  if (ev.landed && ev.fallVel > FALL_SAFE_SPEED && typeof playerTakeDamage === 'function')
    playerTakeDamage((ev.fallVel - FALL_SAFE_SPEED) * FALL_DAMAGE_PER_SPEED, { covered: false });

  // ── View punch spring (landing kick) ──────────────────────────────────
  // Implicit Euler — unconditionally stable at any dt (explicit blows up at dt≥0.05)
  // System: dp/dt = v,  dv/dt = -k*p - d*v   (k=200, d=8)
  {
    const k = 200, d = 8;
    const denom = 1 + d * dt + k * dt * dt;
    const nv = (punchVel - k * dt * punchPitch) / denom;
    punchPitch += dt * nv;
    punchVel    = nv;
    if (Math.abs(punchPitch) < 0.0003 && Math.abs(punchVel) < 0.0003) {
      punchPitch = punchVel = 0;
    }
  }
  // Landing roll: snapped on instantly at touchdown, then levels out smoothly.
  punchRoll *= Math.exp(-dt * 4);
  if (Math.abs(punchRoll) < 0.0006) punchRoll = 0;

  // ── Gun recoil decay — engine V_DropPunchAngle (HLSDK cl_dll/view.cpp) ─────
  // Shrinks the punch-angle VECTOR's magnitude every frame: len -= (10 + len·0.5)·dt,
  // direction preserved. The 10°/s term is degrees in the engine → 10·D in our radians.
  // Per-shot KickBack adds faster than this drains during a burst (so the spray climbs and
  // saturates at the weapon's cap); once firing stops it recenters in ~0.4 s, just like CS.
  lastShotAge += dt;
  const _punchLen = Math.hypot(recoilPitch, recoilYaw);
  if (_punchLen > 1e-6) {
    const _newLen = Math.max(0, _punchLen - (10 * Math.PI / 180 + _punchLen * 0.5) * dt);
    const _s = _newLen / _punchLen;
    recoilPitch *= _s;
    recoilYaw   *= _s;
  }
  if (Math.abs(recoilPitch) < 0.0005) recoilPitch = 0;
  if (Math.abs(recoilYaw)   < 0.0005) recoilYaw   = 0;

  // ── Camera ────────────────────────────────────────────────────────────
  // Duck hull origin sits 18 below the stand origin for the same body, so the
  // camera needs +18 whenever phyDucked — IN AIR TOO. Smoothing the offset means
  // ducking mid-air and landing crouched no longer dip the view ~18 units below
  // the crouch level; the camera just shifts gently (as in the original).
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const wantDuckOfs = phyDucked ? 18 : 0;
  duckViewOfs += (wantDuckOfs - duckViewOfs) * (1 - Math.exp(-16 * dt));
  const targetCamY = gsPos[2] + eyeH + duckViewOfs;
  if (smoothCamY === null) smoothCamY = targetCamY;
  if (onGround) {
    const camDiff = targetCamY - smoothCamY;
    if (Math.abs(camDiff) > SV.stepsize * 3) {
      smoothCamY = targetCamY;
    } else {
      smoothCamY += camDiff * (1 - Math.exp(-CONFIG.stairSmoothing * dt));
    }
  } else {
    smoothCamY = targetCamY;   // in air: track exactly (no lag on jump/fall)
  }
  yawObj.position.set(gsPos[0], smoothCamY, -gsPos[1]);
}

// Place the camera at the current spawn without simulating. Used while the player
// is frozen (team/class select): playerMove — which normally positions the camera —
// doesn't run, so without this the camera sits at the world origin (0,0,0) and looks
// off the map. Puts the eye at the spawn point looking along its angle.
function syncCameraToPlayer() {
  if (!gsPos) return;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  smoothCamY = gsPos[2] + eyeH;
  yawObj.position.set(gsPos[0], smoothCamY, -gsPos[1]);
}

