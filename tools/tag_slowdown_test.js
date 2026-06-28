// tag_slowdown_test.js — bullet "tagging" velocity modifier (getting shot slows you).
//
// Two parts:
//   1. combat-core.combatVelMod: per-weapon / stance values match ReGameDLL
//      (ShouldDoLargeFlinch). Pistols/SMGs and leg/duck hits → 0.5 (strong); the
//      "large flinch" rifles/snipers → 0.65 (weaker). Glock < AK on purpose.
//   2. sim-core: a tagged player (velMod < 1) accelerates SLOWER and recovers toward
//      full speed over time, on the ground only — exactly the PreThink behaviour.
//
// Run:  node tools/tag_slowdown_test.js     (exit 0 = pass)

const fs   = require('fs');
const path = require('path');
const sim    = require('../src/sim-core.js');
const combat = require('../src/combat-core.js');

let failures = 0;
const check = (name, cond, extra) => {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

// ── 1. combatVelMod table (hg: 2 = chest, 6 = leg) ───────────────────────────
check('Glock tags hard (0.5)',        combat.combatVelMod('glock18', 2, false) === 0.5);
check('USP tags hard (0.5)',          combat.combatVelMod('usp', 2, false) === 0.5);
check('MP5 tags hard (0.5)',          combat.combatVelMod('mp5', 2, false) === 0.5);
check('AK is large-flinch (0.65)',    combat.combatVelMod('ak47', 2, false) === 0.65);
check('M4 is large-flinch (0.65)',    combat.combatVelMod('m4', 2, false) === 0.65);
check('AWP is large-flinch (0.65)',   combat.combatVelMod('awp', 2, false) === 0.65);
check('AK leg hit → small flinch',    combat.combatVelMod('ak47', 6, false) === 0.5);
check('AK vs ducking → small flinch', combat.combatVelMod('ak47', 2, true)  === 0.5);
check('Glock weaker mod than AK',     combat.combatVelMod('glock18', 2, false) < combat.combatVelMod('ak47', 2, false));

// ── 2. sim damping + recovery on the ground ──────────────────────────────────
const hullData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'maps', 'de_dust2_hull.json'), 'utf8'));
const hull = sim.simMakeHull(hullData);
const DT = 1 / 100;
const fwd = { forwardMove: 1, sideMove: 0, jump: false, duck: false, walk: false, yaw: 0 };

function settleOnFloor() {
  const sp = hullData.spawns.ct[0];
  const st = sim.simMakeState([sp.origin[0], sp.origin[1], sp.origin[2] + 64]);
  for (let i = 0; i < 120 && !st.onGround; i++) sim.simPlayerMove(hull, st, { forwardMove: 0, sideMove: 0, yaw: 0 }, DT, null);
  for (let i = 0; i < 20; i++) sim.simPlayerMove(hull, st, { forwardMove: 0, sideMove: 0, yaw: 0 }, DT, null);
  return st;
}

check('default state has velMod = 1', sim.simMakeState() && sim.simMakeState().velMod === 1);

// Untagged: run forward for ~0.3 s and record speed.
const a = settleOnFloor();
for (let i = 0; i < 30; i++) sim.simPlayerMove(hull, a, fwd, DT, null);
const fullSpd = Math.hypot(a.vel[0], a.vel[1]);

// Tagged with a Glock (0.5): same input, same duration → must be noticeably slower.
const b = settleOnFloor();
b.velMod = 0.5;
for (let i = 0; i < 30; i++) sim.simPlayerMove(hull, b, fwd, DT, null);
const taggedSpd = Math.hypot(b.vel[0], b.vel[1]);

check('tagged player is slower right after the hit', taggedSpd < fullSpd * 0.92,
      `tagged=${taggedSpd.toFixed(1)} full=${fullSpd.toFixed(1)}`);
check('velMod recovers toward 1 while grounded', b.velMod > 0.5 && b.velMod <= 1,
      `velMod=${b.velMod.toFixed(2)}`);

// After plenty of time the modifier is fully recovered to 1 (no lingering slowdown).
for (let i = 0; i < 120; i++) sim.simPlayerMove(hull, b, fwd, DT, null);
check('velMod fully recovers to 1', b.velMod === 1, `velMod=${b.velMod}`);

// In the air the modifier is frozen (no recovery, no damping).
const c = sim.simMakeState([0, 0, 0]);
c.velMod = 0.5; c.onGround = false; c.vel = [200, 0, 50];
const before = c.velMod;
sim.simPlayerMove(hull, c, { forwardMove: 0, sideMove: 0, yaw: 0 }, DT, null);
check('airborne: velMod stays frozen', c.velMod === before, `velMod=${c.velMod}`);

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
