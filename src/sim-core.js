// sim-core.js — deterministic GoldSrc player movement, shared by client & server.
//
// Dual-mode file:
//   • In the browser it loads as a CLASSIC script (no import/export) and defines
//     globals (sim* functions) in the shared src/*.js scope, exactly like the
//     other modules.
//   • In Node it can be `require`d (server / headless tests): the tail exports
//     the same functions via module.exports.
//
// PURE simulation: nothing here touches THREE, the DOM, audio or the camera.
// All collision state (the BSP hull) and all player state are passed in
// EXPLICITLY — no module-level mutable globals — so the same code can run one
// authoritative instance per player on the server AND the local prediction copy
// on the client. The client's src/physics.js keeps the view/recoil/camera tail
// that lives only on the client.
//
// Space: GoldSrc (Z-up). Three.js conversion happens only at render time.

// Physics constants come from config.js (single source of truth). In the
// browser CONFIG is already a global; in Node we require it (config.js exports
// itself in dual-mode too). The require() is only evaluated when CONFIG is
// undefined, so the browser never hits it.
const SIM_SV = (typeof CONFIG !== 'undefined') ? CONFIG
             : (typeof require !== 'undefined' ? require('../config.js') : null);

const SIM_CONTENTS_SOLID = -2;
const SIM_DIST_EPS       = 0.03125;

// ── Hull wrapper ────────────────────────────────────────────────────────────
// Normalises the de_dust2_hull.json layout into a plain object the trace uses.
// stand hull (hull1) for standing, duck hull (hull3) when crouched; entity solid
// brushes get their own per-state head lists.
function simMakeHull(data) {
  return {
    planes:         data.planes,
    clipnodes:      data.clipnodes,
    standHead:      data.hull1_head,
    duckHead:       data.hull3_head ?? data.hull1_head,
    solidHeads:     data.solid_heads      || [],
    solidHeadsDuck: data.solid_heads_duck || data.solid_heads || [],
  };
}

// ── BSP hull trace (mirrors physics.js pointContents/_check/traceMove) ───────
function simPointContents(hull, node, p) {
  while (node >= 0) {
    const cn = hull.clipnodes[node];
    const pl = hull.planes[cn[0]];
    node = (pl[0]*p[0] + pl[1]*p[1] + pl[2]*p[2] - pl[3]) < 0 ? cn[2] : cn[1];
  }
  return node;
}

// hullHead = root node of THIS model (constant through recursion, back-step check)
// node     = current tree node being visited (changes through recursion)
function simHullCheck(hull, hullHead, node, p1f, p2f, p1, p2, tr) {
  if (node < 0) {
    if (node !== SIM_CONTENTS_SOLID) { tr.allsolid = false; }
    else { tr.startsolid = true; }
    return true;
  }
  const cn = hull.clipnodes[node];
  const pl = hull.planes[cn[0]];
  const t1 = pl[0]*p1[0] + pl[1]*p1[1] + pl[2]*p1[2] - pl[3];
  const t2 = pl[0]*p2[0] + pl[1]*p2[1] + pl[2]*p2[2] - pl[3];

  if (t1 >= 0 && t2 >= 0) return simHullCheck(hull, hullHead, cn[1], p1f, p2f, p1, p2, tr);
  if (t1 <  0 && t2 <  0) return simHullCheck(hull, hullHead, cn[2], p1f, p2f, p1, p2, tr);

  const frac = Math.max(0, Math.min(1,
    t1 < 0 ? (t1 + SIM_DIST_EPS)/(t1-t2) : (t1 - SIM_DIST_EPS)/(t1-t2)));
  const midf = p1f + (p2f-p1f)*frac;
  const mid  = [p1[0]+frac*(p2[0]-p1[0]), p1[1]+frac*(p2[1]-p1[1]), p1[2]+frac*(p2[2]-p1[2])];
  const side = t1 < 0 ? 1 : 0;
  if (!simHullCheck(hull, hullHead, cn[1+side], p1f, midf, p1, mid, tr)) return false;
  if (simPointContents(hull, cn[2-side], mid) !== SIM_CONTENTS_SOLID)
    return simHullCheck(hull, hullHead, cn[2-side], midf, p2f, mid, p2, tr);
  if (tr.allsolid) return false;

  const s = side === 0 ? 1 : -1;
  tr.plane = [s*pl[0], s*pl[1], s*pl[2], s*pl[3]];

  let ff = frac;
  for (let i = 0; i < 12; i++) {
    const ep = [p1[0]+ff*(p2[0]-p1[0]), p1[1]+ff*(p2[1]-p1[1]), p1[2]+ff*(p2[2]-p1[2])];
    if (simPointContents(hull, hullHead, ep) !== SIM_CONTENTS_SOLID) break;
    ff = Math.max(0, ff - 0.1);
  }
  tr.fraction = p1f + (p2f-p1f)*ff;
  tr.end = [p1[0]+ff*(p2[0]-p1[0]), p1[1]+ff*(p2[1]-p1[1]), p1[2]+ff*(p2[2]-p1[2])];
  return false;
}

// ducked picks both the world hull head AND the matching entity solid-brush heads.
function simTraceMove(hull, ducked, from, to) {
  const worldHead = ducked ? hull.duckHead : hull.standHead;
  const tr = { fraction:1.0, end:[...to], plane:null, startsolid:false, allsolid:true };
  simHullCheck(hull, worldHead, worldHead, 0, 1, from, to, tr);
  const entityHeads = ducked ? hull.solidHeadsDuck : hull.solidHeads;
  for (const head of entityHeads) {
    if (head < 0) continue;   // empty-hull entity, skip fast
    const t2 = { fraction:1.0, end:[...to], plane:null, startsolid:false, allsolid:true };
    simHullCheck(hull, head, head, 0, 1, from, to, t2);
    if (t2.fraction < tr.fraction) {
      tr.fraction = t2.fraction; tr.end = t2.end;
      tr.plane = t2.plane; tr.startsolid = t2.startsolid; tr.allsolid = t2.allsolid;
    }
  }
  return tr;
}

// ── Player state ────────────────────────────────────────────────────────────
// Fresh movement state for one player. Only the fields the simulation reads/writes
// — the client's view/recoil/camera state stays in physics.js.
function simMakeState(pos) {
  return {
    pos:        pos ? [...pos] : [0, 0, 0],
    vel:        [0, 0, 0],
    onGround:   false,
    wasJump:    false,
    duckAmount: 0,
    phyDucked:  false,
    prevVelZ:   0,
  };
}

// ── Movement primitives (mirror physics.js categorize/friction/accel/slideMove)
function simCategorize(hull, st) {
  // Moving up fast (just jumped) → airborne; don't trace for the floor.
  if (st.vel[2] > 180) { st.onGround = false; return; }
  const down = [st.pos[0], st.pos[1], st.pos[2] - 2];
  const tr   = simTraceMove(hull, st.phyDucked, st.pos, down);
  st.onGround = tr.fraction < 1 && tr.plane && tr.plane[2] > 0.7;
  if (st.onGround && tr.fraction > 0) st.pos = [...tr.end];
}

function simFriction(st, dt) {
  const spd = Math.hypot(st.vel[0], st.vel[1]);
  if (spd < 1) { st.vel[0] = st.vel[1] = 0; return; }
  const drop  = Math.max(spd, SIM_SV.stopspeed) * SIM_SV.friction * dt;
  const scale = Math.max(0, spd - drop) / spd;
  st.vel[0] *= scale; st.vel[1] *= scale;
}

function simAccel(st, wishDir, wishSpd, ac, dt) {
  const cur = st.vel[0]*wishDir[0] + st.vel[1]*wishDir[1] + st.vel[2]*wishDir[2];
  const add = wishSpd - cur;
  if (add <= 0) return;
  const a = Math.min(ac * wishSpd * dt, add);
  st.vel[0] += a*wishDir[0]; st.vel[1] += a*wishDir[1]; st.vel[2] += a*wishDir[2];
}

function simSlideMove(hull, st, dt) {
  const ducked = st.phyDucked;
  let timeLeft = dt;
  const hitPlanes = [];
  for (let bump = 0; bump < 4 && timeLeft > 0; bump++) {
    const dest = [st.pos[0]+st.vel[0]*timeLeft, st.pos[1]+st.vel[1]*timeLeft, st.pos[2]+st.vel[2]*timeLeft];
    const tr   = simTraceMove(hull, ducked, st.pos, dest);
    // Anti fall-through (see physics.js): embedded origin → don't accept a move
    // through solid; stop or un-embed by pushing up.
    if (tr.allsolid) { st.vel[0] = st.vel[1] = st.vel[2] = 0; break; }
    if (tr.startsolid) {
      let freeZ = null;
      for (let i = 1; i <= 36; i++) {
        const p = [st.pos[0], st.pos[1], st.pos[2] + i];
        if (!simTraceMove(hull, ducked, p, p).startsolid) { freeZ = st.pos[2] + i; break; }
      }
      if (freeZ !== null) st.pos[2] = freeZ;
      else { st.vel[0] = st.vel[1] = st.vel[2] = 0; }
      if (st.vel[2] < 0) st.vel[2] = 0;
      break;
    }
    st.pos = [...tr.end];
    timeLeft -= timeLeft * tr.fraction;
    if (tr.fraction === 1 || !tr.plane) break;
    hitPlanes.push(tr.plane);
    for (const pl of hitPlanes) {
      const dot = st.vel[0]*pl[0] + st.vel[1]*pl[1] + st.vel[2]*pl[2];
      if (dot >= 0) continue;
      if (pl[2] > 0.7 && st.onGround) {
        if (st.vel[2] < 0) st.vel[2] = 0;     // floor on ground: kill only downward speed
      } else {
        st.vel[0] -= dot*pl[0]; st.vel[1] -= dot*pl[1]; st.vel[2] -= dot*pl[2];
      }
    }
  }
}

// ── One movement tick ───────────────────────────────────────────────────────
// hull   : simMakeHull(...) result (shared, read-only).
// st     : simMakeState(...) — mutated in place.
// cmd    : usercmd { forwardMove:-1..1, sideMove:-1..1, jump:bool, duck:bool,
//                    walk:bool, yaw:radians }.
// dt     : tick seconds.
// params : { wpnMax } — active weapon's run-speed cap (defaults to SV.maxspeed).
// Returns an events object { jumped, landed, fallVel } so the caller (server)
// owns side effects like fall damage — the sim itself never applies HP changes.
function simPlayerMove(hull, st, cmd, dt, params) {
  const SV = SIM_SV;
  const ev = { jumped: false, landed: false, fallVel: 0, stoodUp: false };
  const wantDuck = !!cmd.duck;

  // Duck transition (smooth 0..1) + duck hull state while airborne.
  if (wantDuck) st.duckAmount = Math.min(1, st.duckAmount + dt / SV.ducktime);
  else          st.duckAmount = Math.max(0, st.duckAmount - dt / SV.uncrouchtime);
  if (!st.onGround &&  wantDuck) st.phyDucked = true;
  if (!st.onGround && !wantDuck) st.phyDucked = false;

  // Categorize ground (uses current phyDucked hull).
  const wasGround = st.onGround;
  simCategorize(hull, st);

  // Stand up when crouch released on ground and there's headroom.
  if (st.phyDucked && st.onGround && !wantDuck) {
    const trUp = simTraceMove(hull, true, st.pos, [st.pos[0], st.pos[1], st.pos[2] + 37]);
    if (trUp.fraction >= 1.0) { st.pos[2] += 19; st.phyDucked = false; ev.stoodUp = true; }
  }

  // Report landing (caller applies fall damage). m_flFallVelocity = -vel.z at touchdown.
  if (!wasGround && st.onGround) { ev.landed = true; ev.fallVel = -st.prevVelZ; }
  st.prevVelZ = st.vel[2];

  // Speed / wish dir. Weapon caps run speed; walk/crouch scale with it.
  const walk   = !!cmd.walk;
  const wpnMax = (params && params.wpnMax) || SV.maxspeed;
  const sScale = wpnMax / SV.maxspeed;
  const maxSpd = walk ? SV.walkspeed * sScale
               : st.duckAmount > 0.1 ? SV.crouchspeed * sScale
               : wpnMax;

  const yaw  = cmd.yaw || 0;
  const fwdX = -Math.sin(yaw), fwdY = Math.cos(yaw);
  const rgtX =  Math.cos(yaw), rgtY = Math.sin(yaw);
  const fm = cmd.forwardMove || 0, sm = cmd.sideMove || 0;
  const wx = fwdX*fm + rgtX*sm;
  const wy = fwdY*fm + rgtY*sm;
  const wlen = Math.hypot(wx, wy);
  const wSpd = Math.min(wlen, 1) * maxSpd;
  const wDir = wlen > 0 ? [wx/wlen, wy/wlen, 0] : [0, 0, 0];

  // Ground / air logic.
  if (st.onGround) {
    st.vel[2] = 0;
    simFriction(st, dt);
    simAccel(st, wDir, wSpd, SV.accelerate, dt);

    const jumpKey = !!cmd.jump;
    if (jumpKey && !st.wasJump) {
      // Crouch-jump: stand up first if physically ducked and there's headroom.
      if (st.phyDucked) {
        const trUp = simTraceMove(hull, true, st.pos, [st.pos[0], st.pos[1], st.pos[2] + 37]);
        if (trUp.fraction >= 1.0) { st.pos[2] += 19; st.phyDucked = false; ev.stoodUp = true; }
      }
      if (!st.phyDucked) {
        // Bunnyhop protection: per-jump tax + hard mega-cap (GoldSrc PM_PreventMegaBunnyJumping).
        const maxScaled = 1.4 * SV.maxspeed;
        const spd = Math.hypot(st.vel[0], st.vel[1]);
        if (spd > maxScaled) { const f = (maxScaled / spd) * 0.65; st.vel[0] *= f; st.vel[1] *= f; }
        else if (spd > SV.maxspeed * 0.7) { st.vel[0] *= 0.8; st.vel[1] *= 0.8; }
        st.vel[2]   = SV.jumpvel;
        st.onGround = false;
        ev.jumped   = true;
      }
    }
    st.wasJump = jumpKey;
  } else {
    st.vel[2] -= SV.gravity * 0.5 * dt;            // first half-gravity (GoldSrc)
    simAccel(st, wDir, Math.min(wSpd, 30), SV.airaccel, dt);
    st.wasJump = true;
  }

  // Move + second half-gravity.
  const ducked = st.phyDucked;
  const savedPos = [...st.pos], savedVel = [...st.vel];
  simSlideMove(hull, st, dt);
  if (!st.onGround) st.vel[2] -= SV.gravity * 0.5 * dt;

  // Step-up: blocked horizontally on ground → climb stair.
  const movedH = Math.hypot(st.pos[0]-savedPos[0], st.pos[1]-savedPos[1]);
  const wantH  = Math.hypot(savedVel[0]*dt, savedVel[1]*dt);
  if (st.onGround && wantH > 0.1) {
    const noStepPos = [...st.pos], noStepVel = [...st.vel];
    st.pos = [...savedPos]; st.vel = [...savedVel];
    const up = simTraceMove(hull, ducked, st.pos, [st.pos[0], st.pos[1], st.pos[2]+SV.stepsize]);
    st.pos = [...up.end];
    simSlideMove(hull, st, dt);
    const dn = simTraceMove(hull, ducked, st.pos, [st.pos[0], st.pos[1], st.pos[2]-SV.stepsize*2]);
    if (dn.fraction < 1 && dn.plane && dn.plane[2] > 0.7) {
      const stepMovedH = Math.hypot(dn.end[0]-savedPos[0], dn.end[1]-savedPos[1]);
      if (stepMovedH > movedH) st.pos = [...dn.end];
      else { st.pos = noStepPos; st.vel = noStepVel; }
    } else {
      st.pos = noStepPos; st.vel = noStepVel;
    }
  }

  // Step-down: stick to terrain going downhill.
  if (st.onGround && st.vel[2] <= 0) {
    const dn = simTraceMove(hull, ducked, st.pos, [st.pos[0], st.pos[1], st.pos[2]-SV.stepsize]);
    if (dn.fraction < 1 && dn.plane && dn.plane[2] > 0.7) st.pos = [...dn.end];
  }

  return ev;
}

// Node-only: export the same functions the browser sees as globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    simMakeHull, simMakeState, simPlayerMove, simTraceMove,
    simPointContents, simCategorize,
  };
}
