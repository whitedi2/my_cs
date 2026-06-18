// net_match_test.js — unit tests for the authoritative match state machine
// (Phase 6, step A): round phases, timers, score, elimination + the server wiring
// (worldTickMatch marks players alive on a new round; gameState shape). Pure, no WS.
//
// Run:  node tools/net_match_test.js     (exit 0 = pass)

const M   = require('../src/match-core.js');
const srv = require('../server.js');

let failures = 0;
const check = (name, cond, extra) => {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

// ── Round flow (one team → clock decides) ────────────────────────────────────
{
  const ms = M.matchCreate();
  check('starts in warmup', ms.phase === 'warmup' && ms.round === 0);

  let ev = M.matchTick(ms, [], 0.1);
  check('no players → stays warmup', ms.phase === 'warmup' && !ev.roundStart);

  const t1 = [{ team: 't', alive: true, joined: true }];
  ev = M.matchTick(ms, t1, 0.1);
  check('a player joins → round 1, buy phase', ev.roundStart && ms.phase === 'buy' && ms.round === 1,
        `phase=${ms.phase} round=${ms.round}`);
  check('buy timer set', Math.abs(ms.timer - M.MATCH_BUY_TIME) < 0.01, `timer=${ms.timer}`);

  M.matchTick(ms, t1, M.MATCH_BUY_TIME);
  check('buy elapses → live', ms.phase === 'live' && Math.abs(ms.timer - M.MATCH_ROUND_TIME) < 0.5,
        `phase=${ms.phase} timer=${ms.timer.toFixed(1)}`);

  ev = M.matchTick(ms, t1, M.MATCH_ROUND_TIME);
  check('clock runs out → over, CT wins', ms.phase === 'over' && ms.winner === 'ct',
        `phase=${ms.phase} winner=${ms.winner}`);
  check('score CT = 1', ms.scoreCT === 1 && ms.scoreT === 0, `T=${ms.scoreT} CT=${ms.scoreCT}`);
  check('roundEnd event emitted', ev.roundEnd && ev.roundEnd.winner === 'ct');

  ev = M.matchTick(ms, t1, M.MATCH_ROUND_END);
  check('end banner elapses → round 2 buy', ev.roundStart && ms.phase === 'buy' && ms.round === 2,
        `phase=${ms.phase} round=${ms.round}`);
}

// ── Elimination (both teams) ─────────────────────────────────────────────────
{
  const ms = M.matchCreate();
  const both = [{ team: 't', alive: true, joined: true }, { team: 'ct', alive: true, joined: true }];
  M.matchTick(ms, both, 0.01);                 // warmup → round 1 buy
  M.matchTick(ms, both, M.MATCH_BUY_TIME);     // → live
  check('both teams, round live', ms.phase === 'live');

  both[0].alive = false;                        // the only T dies
  const ev = M.matchTick(ms, both, 0.01);
  check('all T dead → CT wins by elimination', ev.roundEnd && ev.roundEnd.winner === 'ct',
        ev.roundEnd ? `winner=${ev.roundEnd.winner}` : 'no end');
  check('elimination scored for CT', ms.scoreCT === 1);
}

// ── Server wiring ────────────────────────────────────────────────────────────
{
  const world = srv.createWorld();
  srv.worldAddPlayer(world, 1, { tm: 't', p: [0, 0, 0] });     // joined (has identity)
  world.players.get(1).alive = false;                          // pretend dead

  const ev = srv.worldTickMatch(world, 0.01);
  check('server starts the round', ev.roundStart && world.match.phase === 'buy');
  check('new round revives players', world.players.get(1).alive === true);

  const gs = srv.gameState(world);
  check('gameState shape', gs.t === 'gstate' && gs.phase === 'buy' && gs.map === 'de_dust2',
        `phase=${gs.phase} map=${gs.map}`);
  check('gameState counts online', gs.online === 1, `online=${gs.online}`);
}

// ── Damage / armor / death / revive / fall (6B) ──────────────────────────────
{
  const pl = { hp: 100, armor: 0, helmet: false, alive: true };
  let r = M.matchApplyDamage(pl, 30, 2);
  check('chest, no armor → full dmg', pl.hp === 70 && r.dealt === 30 && !r.died, `hp=${pl.hp}`);

  const pa = { hp: 100, armor: 100, helmet: false, alive: true };
  M.matchApplyDamage(pa, 40, 2);
  check('kevlar soaks a covered chest hit', pa.hp > 60 && pa.armor < 100, `hp=${pa.hp} ap=${pa.armor}`);

  const ph = { hp: 100, armor: 100, helmet: false, alive: true };
  M.matchApplyDamage(ph, 50, 1);
  check('headshot bypasses kevlar (no helmet)', ph.hp === 50 && ph.armor === 100, `hp=${ph.hp} ap=${ph.armor}`);

  const pd = { hp: 20, armor: 0, helmet: false, alive: true };
  r = M.matchApplyDamage(pd, 50, 2);
  check('lethal hit → died, hp 0, not alive', r.died && pd.hp === 0 && !pd.alive);
  r = M.matchApplyDamage(pd, 50, 2);
  check('a corpse takes no more damage', r.dealt === 0 && !r.died);

  M.matchRevive(pd);
  check('revive → full hp + alive', pd.hp === 100 && pd.alive === true);

  check('safe fall does no damage', M.matchFallDamage(400) === 0);
  check('hard fall hurts', M.matchFallDamage(800) > 0, `dmg=${M.matchFallDamage(800).toFixed(1)}`);
}

// ── Server applies bullet damage to HP + kills ───────────────────────────────
{
  const world = srv.createWorld();
  const a = srv.worldAddPlayer(world, 1, { tm: 't', p: [0, 0, 0] });
  const b = srv.worldAddPlayer(world, 2, { tm: 'ct', p: [0, 200, 0] });
  b.state.pos = [0, 200, 0];

  const shot = { o: [0, 0, 14], d: [0, 1, 0], w: 'ak47', s: 0, svt: Infinity };
  let died = false;
  for (let i = 0; i < 20 && b.alive; i++) {
    const evs = srv.worldProcessShot(world, 1, shot);
    if (evs.some(e => e.died)) died = true;
  }
  check('repeated chest shots kill the target', died && b.hp === 0 && !b.alive, `hp=${b.hp} alive=${b.alive}`);

  const gs = srv.gameState(world, b);
  check('gameState carries victim HP in me', gs.me && gs.me.hp === 0 && gs.me.alive === false,
        gs.me ? `hp=${gs.me.hp}` : 'no me');
}

// ── Economy / buy (6C) ───────────────────────────────────────────────────────
{
  const mk = (team) => ({ team, money: 16000, armor: 0, helmet: false, dk: false,
                          weapons: new Set(['knife', 'usp']), nades: { hegrenade: 0, flashbang: 0, smokegrenade: 0 } });
  const pl = mk('ct');
  let r = M.matchBuy(pl, 'm4');
  check('buy M4 → owned, money −3100', r.ok && pl.weapons.has('m4') && pl.money === 12900, `money=${pl.money}`);
  r = M.matchBuy(pl, 'famas');
  check('buy FAMAS replaces M4 (one primary slot)', r.ok && pl.weapons.has('famas') && !pl.weapons.has('m4'));
  check('usp (secondary) survives a primary buy', pl.weapons.has('usp'));
  r = M.matchBuy(pl, 'ak47');
  check('CT cannot buy AK-47', !r.ok && /команд/.test(r.reason), r.reason);

  const poor = mk('t'); poor.money = 100;
  r = M.matchBuy(poor, 'ak47');
  check('not enough money → blocked', !r.ok && /денег/.test(r.reason), r.reason);

  const k = mk('ct'); k.money = 2000;
  M.matchBuy(k, 'kevlarhelm');
  check('kevlar+helm → armor 100 + helmet, −1000', k.armor === 100 && k.helmet === true && k.money === 1000);
  r = M.matchBuy(k, 'kevlar');
  check('rebuy full armor blocked', !r.ok && /Броня/.test(r.reason));

  const n = mk('t');
  M.matchBuy(n, 'hegrenade');
  r = M.matchBuy(n, 'hegrenade');
  check('HE grenade cap 1', !r.ok && /Максимум/.test(r.reason) && n.nades.hegrenade === 1);

  check('knife kill rewards $1500', M.matchKillReward('knife') === 1500);
  check('gun kill rewards $300', M.matchKillReward('ak47') === 300);
}

// ── Round rewards via the server ─────────────────────────────────────────────
{
  const world = srv.createWorld();
  const a = srv.worldAddPlayer(world, 1, { tm: 't',  p: [0, 0, 0] });
  const b = srv.worldAddPlayer(world, 2, { tm: 'ct', p: [0, 200, 0] });
  srv.worldTickMatch(world, 0.01);                 // round 1 buy
  srv.worldTickMatch(world, M.MATCH_BUY_TIME);     // → live
  a.alive = false; a.money = 0; b.money = 0;        // T wiped; zero money to see the bonus
  srv.worldTickMatch(world, 0.01);                 // elimination → CT win + rewards
  check('winner (CT) gets the win bonus', b.money === M.MATCH_WIN_REWARD, `b=${b.money}`);
  check('loser (T) gets the loss bonus', a.money === M.MATCH_LOSS_REWARD, `a=${a.money}`);

  const gs = srv.gameState(world, b);
  check('gameState me carries economy', gs.me && gs.me.money === M.MATCH_WIN_REWARD && Array.isArray(gs.me.weapons),
        gs.me ? `money=${gs.me.money}` : 'no me');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
