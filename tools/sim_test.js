// sim_test.js — headless sanity test for src/sim-core.js (Phase 5, step A).
//
// Runs the shared deterministic movement core against the real de_dust2 hull, with
// NO browser / THREE / DOM. Verifies: a dropped player lands on the floor and stops
// falling, then walking forward actually moves it without falling through the world.
//
// Run:  node tools/sim_test.js     (exit code 0 = pass, 1 = fail)

const fs   = require('fs');
const path = require('path');

const sim = require('../src/sim-core.js');

const hullData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'maps', 'de_dust2_hull.json'), 'utf8'));
const hull = sim.simMakeHull(hullData);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

const DT = 1 / 100;   // 100 Hz fixed tick
const idleCmd = { forwardMove: 0, sideMove: 0, jump: false, duck: false, walk: false, yaw: 0 };

// ── Test 1: drop onto the floor ──────────────────────────────────────────────
// Spawn the player a bit above a CT spawn origin and let gravity pull it down.
{
  const sp = hullData.spawns.ct[0];
  const start = [sp.origin[0], sp.origin[1], sp.origin[2] + 64];
  const st = sim.simMakeState(start);

  let landed = false, landTick = -1;
  for (let i = 0; i < 200; i++) {
    sim.simPlayerMove(hull, st, idleCmd, DT, null);
    if (st.onGround) { landed = true; landTick = i; break; }
  }
  check('drop: player lands on the floor', landed, `tick=${landTick}`);

  // Settle a few more ticks, then it must be at rest (no residual fall-through).
  for (let i = 0; i < 30; i++) sim.simPlayerMove(hull, st, idleCmd, DT, null);
  check('drop: vertical velocity settles', Math.abs(st.vel[2]) < 1,
        `vz=${st.vel[2].toFixed(3)}`);
  check('drop: stays on ground', st.onGround === true);
  check('drop: rests near spawn z (no fall-through)',
        Math.abs(st.pos[2] - sp.origin[2]) < 8,
        `z=${st.pos[2].toFixed(2)} spawnz=${sp.origin[2]}`);

  // ── Test 2: walk forward ────────────────────────────────────────────────
  const before = [st.pos[0], st.pos[1], st.pos[2]];
  const walkCmd = { forwardMove: 1, sideMove: 0, jump: false, duck: false, walk: false, yaw: 0 };
  for (let i = 0; i < 100; i++) sim.simPlayerMove(hull, st, walkCmd, DT, null);
  const movedH = Math.hypot(st.pos[0] - before[0], st.pos[1] - before[1]);
  check('walk: player moved horizontally', movedH > 20, `moved=${movedH.toFixed(1)}u`);
  check('walk: stayed on ground', st.onGround === true);
  check('walk: did not fall out of the world', st.pos[2] > sp.origin[2] - 64,
        `z=${st.pos[2].toFixed(2)}`);
}

// ── Test 3: jump leaves the ground then returns ──────────────────────────────
{
  const sp = hullData.spawns.ct[0];
  const st = sim.simMakeState([sp.origin[0], sp.origin[1], sp.origin[2] + 64]);
  for (let i = 0; i < 200 && !st.onGround; i++) sim.simPlayerMove(hull, st, idleCmd, DT, null);

  const jumpCmd = { forwardMove: 0, sideMove: 0, jump: true, duck: false, walk: false, yaw: 0 };
  const ev = sim.simPlayerMove(hull, st, jumpCmd, DT, null);
  check('jump: reported jumped event', ev.jumped === true);
  check('jump: left the ground', st.onGround === false, `vz=${st.vel[2].toFixed(1)}`);

  // Release jump, idle until it lands again.
  let landedAgain = false;
  for (let i = 0; i < 200; i++) {
    const e = sim.simPlayerMove(hull, st, idleCmd, DT, null);
    if (e.landed) { landedAgain = true; break; }
  }
  check('jump: lands again', landedAgain);
}

// ── Test 4: crouching ON THE FLOOR swaps in the duck hull (PM_FinishDuck) ─────
// Regression: the hull used to switch only in the air, so a player crouched on the
// ground kept the full-height box (and full-height hitboxes, no accuracy bonus).
{
  const sp = hullData.spawns.ct[0];
  const st = sim.simMakeState([sp.origin[0], sp.origin[1], sp.origin[2] + 64]);
  for (let i = 0; i < 200 && !st.onGround; i++) sim.simPlayerMove(hull, st, idleCmd, DT, null);
  for (let i = 0; i < 20; i++) sim.simPlayerMove(hull, st, idleCmd, DT, null);
  check('duck: starts standing on the floor', st.onGround && !st.phyDucked);
  const z0 = st.pos[2];

  const duckCmd = { forwardMove: 0, sideMove: 0, jump: false, duck: true, walk: false, yaw: 0 };
  let downTick = -1;
  for (let i = 0; i < 60; i++) {
    const e = sim.simPlayerMove(hull, st, duckCmd, DT, null);
    if (e.duckedDown) { downTick = i; break; }
  }
  check('duck: hull swaps once the crouch completes', downTick >= 0 && st.phyDucked,
        `tick=${downTick} (ducktime 0.2s ≈ ${Math.round(0.2 / DT)} ticks)`);
  check('duck: origin drops 18 (feet stay on the floor)', Math.abs((z0 - st.pos[2]) - 18) < 0.01,
        `dz=${(z0 - st.pos[2]).toFixed(3)}`);
  for (let i = 0; i < 20; i++) sim.simPlayerMove(hull, st, duckCmd, DT, null);
  check('duck: stays down and on the ground', st.phyDucked && st.onGround && Math.abs(st.pos[2] - (z0 - 18)) < 0.01);

  let stood = false;
  for (let i = 0; i < 20; i++) { if (sim.simPlayerMove(hull, st, idleCmd, DT, null).stoodUp) stood = true; }
  for (let i = 0; i < 10; i++) sim.simPlayerMove(hull, st, idleCmd, DT, null);
  check('duck: release stands back up', stood && !st.phyDucked);
  check('duck: back at the standing height', Math.abs(st.pos[2] - z0) < 0.5,
        `dz=${(st.pos[2] - z0).toFixed(3)}`);
}

// ── Test 6: jump height, jump penalty (pm_shared fuser2) and crouch speed ──────
{
  const near = (a, b, e) => Math.abs(a - b) <= e;
  const sp = hullData.spawns.ct[0];
  const yaw = ((sp.angle || 0) - 90) * Math.PI / 180;         // the spawn faces open space
  const fresh = () => {
    const st = sim.simMakeState([sp.origin[0], sp.origin[1], sp.origin[2] + 64]);
    for (let i = 0; i < 200 && !st.onGround; i++) sim.simPlayerMove(hull, st, idleCmd, DT, null);
    for (let i = 0; i < 20; i++) sim.simPlayerMove(hull, st, idleCmd, DT, null);
    return st;
  };
  const cmd = o => Object.assign({ forwardMove: 0, sideMove: 0, jump: false, duck: false, walk: false, yaw }, o);

  // PM_JumpHeight: sqrt(2·800·45) → a 45 u rise.
  {
    const st = fresh(), z0 = st.pos[2];
    sim.simPlayerMove(hull, st, cmd({ jump: true }), DT, null);
    const vz0 = st.vel[2];
    let top = z0;
    for (let i = 0; i < 150; i++) { sim.simPlayerMove(hull, st, idleCmd, DT, null); top = Math.max(top, st.pos[2]); }
    check('jump: take-off = sqrt(2·800·45) ≈ 268.3 (minus half a tick of gravity)', near(vz0, 268.33 - 4, 1), `vz=${vz0.toFixed(2)}`);
    check('jump: rises 45 u (PM_JumpHeight)', near(top - z0, 45, 1.5), `rise=${(top - z0).toFixed(2)}`);
  }

  // Jumping again right on landing: the jump is scaled by (100 − t·0.019)% of the penalty left.
  {
    const st = fresh();
    sim.simPlayerMove(hull, st, cmd({ jump: true }), DT, null);
    let landed = false;
    for (let i = 0; i < 150 && !landed; i++) landed = sim.simPlayerMove(hull, st, cmd({}), DT, null).landed;
    const left = st.stamina;
    sim.simPlayerMove(hull, st, cmd({ jump: true }), DT, null);
    const r = (100 - Math.max(0, left - 10) * 0.019) / 100;       // the timer ticks once more before PM_Jump
    check('jump penalty: an immediate re-jump is lower by the penalty ratio', st.vel[2] < 268.33 * 0.95 && near(st.vel[2], 268.33 * r - 4, 1.5),
          `vz=${st.vel[2].toFixed(1)} want≈${(268.33 * r - 4).toFixed(1)} (penalty ${left.toFixed(0)} ms)`);
  }

  // Running jump: speed drops after landing while the penalty runs, then comes back to 250.
  {
    const st = fresh();
    for (let i = 0; i < 100; i++) sim.simPlayerMove(hull, st, cmd({ forwardMove: 1 }), DT, null);
    const run = Math.hypot(st.vel[0], st.vel[1]);
    sim.simPlayerMove(hull, st, cmd({ forwardMove: 1, jump: true }), DT, null);
    let landed = false, slowest = Infinity;
    for (let i = 0; i < 150 && !landed; i++) landed = sim.simPlayerMove(hull, st, cmd({ forwardMove: 1 }), DT, null).landed;
    for (let i = 0; i < 20; i++) { sim.simPlayerMove(hull, st, cmd({ forwardMove: 1 }), DT, null); slowest = Math.min(slowest, Math.hypot(st.vel[0], st.vel[1])); }
    check('jump penalty: landing from a running jump bleeds speed', run > 249 && slowest < run * 0.6, `run=${run.toFixed(0)} → ${slowest.toFixed(0)}`);
  }

  // The penalty timer runs out 1315.79 ms after a jump: 132 ticks of 10 ms.
  {
    const st = fresh();
    sim.simPlayerMove(hull, st, cmd({ jump: true }), DT, null);
    let ticks = 1;
    while (st.stamina > 0 && ticks < 400) { sim.simPlayerMove(hull, st, idleCmd, DT, null); ticks++; }
    check('jump penalty: lasts 1315.79 ms (132 ticks after the jump tick)', ticks === 133, `ticks=${ticks} incl. the jump`);
  }

  // Crouch-walk: input × PLAYER_DUCKING_MULTIPLIER 0.333 → 250 · 0.333 = 83.25.
  {
    const st = fresh();
    let top = 0;
    for (let i = 0; i < 120; i++) { sim.simPlayerMove(hull, st, cmd({ forwardMove: 1, duck: true }), DT, null); top = Math.max(top, Math.hypot(st.vel[0], st.vel[1])); }
    check('crouch-walk = 250 × 0.333 (PLAYER_DUCKING_MULTIPLIER)', near(top, 83.25, 0.5), `top=${top.toFixed(2)}`);
  }
}

// ── Test 5: grenade throw + flight = engine MOVETYPE_BOUNCE + CGrenade::BounceTouch ──
{
  const near = (a, b, e) => Math.abs(a - b) <= e;
  // Throw speed (wpn_hegrenade.cpp): (90 − biased pitch)·6, capped at 750.
  check('nade throw: level aim = 600 u/s', near(sim.simGrenadeThrow(0, 0).speed, 600, 1e-9));
  check('nade throw: capped at 750 looking up', sim.simGrenadeThrow(0, -45).speed === 750);
  check('nade throw: 300 u/s looking 45° down', near(sim.simGrenadeThrow(0, 45).speed, 300, 1e-9));
  check('nade throw: level aim leaves 10° up', near(Math.asin(sim.simGrenadeThrow(0, 0).dir[2]) * 180 / Math.PI, 10, 1e-9));

  const sp = hullData.spawns.ct[0];
  const floorSt = sim.simMakeState([sp.origin[0], sp.origin[1], sp.origin[2] + 64]);
  for (let i = 0; i < 200 && !floorSt.onGround; i++) sim.simPlayerMove(hull, floorSt, idleCmd, DT, null);
  const floorZ = floorSt.pos[2] - 36;                // player feet = the floor
  const nadeRestZ = floorZ + 18;                     // duck-hull centre resting on it

  // Drop straight down from 100 u above rest: the rebound keeps (1 − friction) of the speed.
  for (const [type, want] of [['hegrenade', 0.3], ['flashbang', 0.2]]) {
    const g = { type, pos: [floorSt.pos[0], floorSt.pos[1], nadeRestZ + 100], vel: [0, 0, 0], onGround: false, bounceCount: 0 };
    let before = 0, after = null;
    for (let i = 0; i < 300 && after === null; i++) {
      const vz0 = g.vel[2];
      sim.simGrenadeStep(hull, g, 0.01);
      if (g.bounceCount === 1) { before = -(vz0 - sim.SIM_GRENADE[type].gravity * 800 * 0.01); after = g.vel[2]; }
    }
    check(`nade ${type}: floor rebound = ${want} of impact speed`, after !== null && near(after / before, want, 0.01),
          after !== null ? `${after.toFixed(1)} / ${before.toFixed(1)} = ${(after / before).toFixed(3)}` : 'no bounce');
  }

  // A glancing floor hit in the air keeps its horizontal speed (only the normal part bounces).
  {
    const yaw = ((sp.angle || 0) - 90) * Math.PI / 180;   // the spawn faces open space
    const g = { type: 'hegrenade', pos: [floorSt.pos[0], floorSt.pos[1], nadeRestZ + 4],
                vel: [-Math.sin(yaw) * 300, Math.cos(yaw) * 300, -200], onGround: false, bounceCount: 0 };
    let hSpeedAfter = null;
    for (let i = 0; i < 50 && hSpeedAfter === null; i++) {
      sim.simGrenadeStep(hull, g, 0.01);
      if (g.bounceCount === 1) hSpeedAfter = Math.hypot(g.vel[0], g.vel[1]);
    }
    check('nade: airborne bounce keeps the tangential speed', hSpeedAfter !== null && near(hSpeedAfter, 300, 0.5),
          `h=${hSpeedAfter && hSpeedAfter.toFixed(2)}`);
  }

  // A normal level throw from eye height comes to rest before the 1.5 s fuse, on the floor.
  {
    const yaw = ((sp.angle || 0) - 90) * Math.PI / 180;
    const th = sim.simGrenadeThrow(yaw, 0);
    const g = { type: 'hegrenade', pos: [floorSt.pos[0], floorSt.pos[1], floorSt.pos[2] + 17],
                vel: th.dir.map(c => c * th.speed), onGround: false, bounceCount: 0 };
    let restT = null;
    for (let i = 0; i < 150; i++) { sim.simGrenadeStep(hull, g, 0.01); if (g.resting && restT === null) restT = (i + 1) * 0.01; }
    check('nade: level throw settles before the fuse', restT !== null && restT < 1.5, `rest at ${restT && restT.toFixed(2)}s`);
    check('nade: rests on a floor, not in solid', g.onGround && g.vel.every(v => v === 0));
  }
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
