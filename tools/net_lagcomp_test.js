// net_lagcomp_test.js — unit tests for server-side bullet hitreg + lag compensation
// (Phase 5, step D). Pure: uses the exported world API (no WebSocket).
//
//   • combat-core ray/box + damage math.
//   • worldProcessShot rewinds targets to the shot's svt: the SAME ray that hits a
//     target at its old position misses once the target has moved (true lag comp).
//
// Run:  node tools/net_lagcomp_test.js     (exit 0 = pass)

const srv    = require('../server.js');
const combat = require('../src/combat-core.js');

let failures = 0;
const check = (name, cond, extra) => {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

// ── combat-core unit ─────────────────────────────────────────────────────────
// Shooter eye at z=14 (chest band), target origin at [0,200,0]; ray straight +Y.
{
  const o = [0, 0, 14], d = [0, 1, 0];
  const chest = combat.combatRayHitPlayer(o, d, [0, 200, 0], false);
  check('ray hits standing target', !!chest);
  check('chest band → hitgroup 2', chest && chest.hg === 2, chest ? `hg=${chest.hg}` : '');
  check('hit distance ≈ 184 (box near face)', chest && Math.abs(chest.dist - 184) < 1, chest ? `dist=${chest.dist.toFixed(1)}` : '');

  const head = combat.combatRayHitPlayer([0, 0, 30], d, [0, 200, 0], false);
  check('high ray → head (hg 1)', head && head.hg === 1, head ? `hg=${head.hg}` : '');

  const miss = combat.combatRayHitPlayer([0, 0, 14], d, [500, 200, 0], false);
  check('ray misses off-axis target', !miss);

  const dmg = combat.combatDamage('ak47', 200, 2, false);
  check('ak47 chest @200u damage ≈ 36', Math.abs(dmg - 35.7) < 1.0, `dmg=${dmg.toFixed(2)}`);
  const head4x = combat.combatDamage('ak47', 0, 1, false);
  check('headshot is ×4', Math.abs(head4x - 144) < 0.1, `dmg=${head4x.toFixed(1)}`);
}

// ── server lag-comp rewind ───────────────────────────────────────────────────
{
  const world = srv.createWorld();
  const shooter = srv.worldAddPlayer(world, 1, { tm: 't' });    // opposite teams → full damage (no FF cut)
  const target  = srv.worldAddPlayer(world, 2, { tm: 'ct' });
  shooter.state.pos = [0, 0, 0];
  target.state.pos  = [0, 200, 0];  target.state.phyDucked = false;

  srv.worldRecordHistory(world, 1000);     // target at [0,200,0]
  target.state.pos = [500, 200, 0];        // target sprints sideways
  srv.worldRecordHistory(world, 1050);     // target at [500,200,0]

  const o = [0, 0, 14], d = [0, 1, 0];     // ray toward the OLD position
  const hitOld = srv.worldProcessShot(world, 1, { o, d, w: 'ak47', s: 0, svt: 1000 });
  check('rewind to svt=1000 → hit', hitOld.length === 1 && hitOld[0].tid === 2,
        `hits=${hitOld.length}`);
  check('rewound hit is chest', hitOld[0] && hitOld[0].hg === 2, hitOld[0] ? `hg=${hitOld[0].hg}` : '');
  check('rewound hit dealt damage to HP', hitOld[0] && hitOld[0].dealt > 0 && world.players.get(2).hp < 100,
        hitOld[0] ? `dealt=${hitOld[0].dealt} hp=${world.players.get(2).hp}` : '');

  const hitNew = srv.worldProcessShot(world, 1, { o, d, w: 'ak47', s: 0, svt: 1050 });
  check('rewind to svt=1050 → miss (target moved)', hitNew.length === 0, `hits=${hitNew.length}`);

  // Shooter never hits itself.
  const self = srv.worldProcessShot(world, 2, { o: [500, 200, 14], d: [0, -1, 0], w: 'ak47', s: 0, svt: 1050 });
  check('shooter excluded from its own shot', !self.some(h => h.tid === 2));
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
