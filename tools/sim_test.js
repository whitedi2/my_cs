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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
