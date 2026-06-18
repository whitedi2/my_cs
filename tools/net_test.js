// net_test.js — headless test for the authoritative server world (Phase 5, step B).
//
// Verifies the server's world API (server.js) wires sim-core correctly:
//  • feeding usercmds advances a player exactly like a standalone sim-core run
//    (authority is deterministic and matches what the client predicts),
//  • stale / duplicate seq numbers are ignored and lastSeq tracks the newest,
//  • the snapshot entry carries the full state the client needs to reconcile.
//
// Run:  node tools/net_test.js     (exit code 0 = pass, 1 = fail)

const fs   = require('fs');
const path = require('path');

const srv = require('../server.js');
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

// A deterministic scripted input stream (walk forward, strafe, crouch, jump).
function scriptCmd(i) {
  return {
    seq: i + 1,
    dt: 1 / 100,
    fm: (i % 40 < 30) ? 1 : 0,
    sm: (i % 60 < 20) ? 1 : (i % 60 < 40 ? -1 : 0),
    jp: (i % 50 === 49),
    dk: (i % 80 >= 60),
    wk: false,
    y: 0.3,
    ws: 250,
  };
}

// ── Authority matches a standalone sim-core run ──────────────────────────────
{
  const world = srv.createWorld();
  // Place both at the SAME spawn so the runs are comparable.
  const sp = hullData.spawns.ct[0];
  const start = [sp.origin[0], sp.origin[1], sp.origin[2] + 1];
  const pl = srv.worldAddPlayer(world, 1, { tm: 'ct', m: 'gign', p: start, y: 0 });

  const ref = sim.simMakeState(start);
  for (let i = 0; i < 300; i++) {
    const c = scriptCmd(i);
    srv.worldApplyCmd(pl, c);
    sim.simPlayerMove(hull, ref, {
      forwardMove: c.fm, sideMove: c.sm, jump: !!c.jp, duck: !!c.dk, walk: !!c.wk, yaw: c.y,
    }, c.dt, { wpnMax: c.ws });
  }

  const d = Math.hypot(
    pl.state.pos[0] - ref.pos[0], pl.state.pos[1] - ref.pos[1], pl.state.pos[2] - ref.pos[2]);
  check('authority matches standalone sim-core', d < 1e-6,
        `drift=${d.toExponential(2)}  serverPos=${pl.state.pos.map(n => n.toFixed(2))}`);
  check('lastSeq tracks newest cmd', pl.lastSeq === 300, `lastSeq=${pl.lastSeq}`);
}

// ── Stale / duplicate seq are ignored ────────────────────────────────────────
{
  const world = srv.createWorld();
  const sp = hullData.spawns.ct[0];
  const pl = srv.worldAddPlayer(world, 2, { tm: 'ct', p: [sp.origin[0], sp.origin[1], sp.origin[2] + 1], y: 0 });

  // Settle on the ground.
  for (let i = 0; i < 50; i++) srv.worldApplyCmd(pl, { seq: i + 1, dt: 1 / 100, fm: 0, y: 0, ws: 250 });
  const baseSeq = pl.lastSeq, baseX = pl.state.pos[0];

  // Replaying an old seq must be a no-op.
  srv.worldApplyCmd(pl, { seq: baseSeq - 5, dt: 1 / 100, fm: 1, y: 0, ws: 250 });
  check('stale seq ignored', pl.lastSeq === baseSeq && Math.abs(pl.state.pos[0] - baseX) < 1e-9);

  // A duplicate of the latest seq must also be a no-op.
  srv.worldApplyCmd(pl, { seq: baseSeq, dt: 1 / 100, fm: 1, y: 0, ws: 250 });
  check('duplicate seq ignored', pl.lastSeq === baseSeq && Math.abs(pl.state.pos[0] - baseX) < 1e-9);

  // A newer seq advances again.
  srv.worldApplyCmd(pl, { seq: baseSeq + 1, dt: 1 / 100, fm: 1, y: 0, ws: 250 });
  check('newer seq advances', pl.lastSeq === baseSeq + 1);
}

// ── Snapshot carries the full reconcilable state ─────────────────────────────
{
  const world = srv.createWorld();
  srv.worldAddPlayer(world, 7, { tm: 't', m: 'leet', p: [100, 200, 50], y: 1.5 });
  const players = srv.worldSnapshot(world);
  const e = players.find(p => p.id === 7);
  const keys = e ? Object.keys(e) : [];
  const need = ['id', 'p', 'v', 'y', 'og', 'dk', 'da', 'wj', 'pz', 'm', 'tm'];
  check('snapshot has one entry per player', players.length === 1);
  check('snapshot entry has all reconcile fields', need.every(k => keys.includes(k)),
        `keys=${keys.join(',')}`);
  check('snapshot keeps team/model', e && e.tm === 't' && e.m === 'leet');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
