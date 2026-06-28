// match-core.js — authoritative MATCH state machine (Phase 6, step A): round phases,
// timers, score and win conditions. Dual-mode like sim-core/combat-core: a classic
// browser script that also `module.exports` for Node. PURE: no DOM, no audio, no THREE.
//
// The server runs one of these and broadcasts `gstate`; clients render it (they stop
// ticking their own round logic when driven by the server). Numbers mirror rounds.js /
// CS 1.6. Step A owns ONLY the round flow + score; HP/economy/bomb come in 6B–6D, so
// here a round ends by the clock (CT) or by elimination (one team wiped).

const MATCH_BUY_TIME   = 15;    // s of buy time at round start (mp_buytime-ish)
const MATCH_ROUND_TIME = 115;   // 1:55 main round clock
const MATCH_ROUND_END  = 5;     // banner before the next round
const MATCH_WARMUP_MIN = 1;     // players (joined) needed to kick off the match

const MATCH_MAX_HP     = 100;
const MATCH_MAX_AP     = 100;
const MATCH_FALL_SAFE  = 500.0; // touchdown speed below which falling is harmless
const MATCH_FALL_FATAL = 1100.0;
const MATCH_FALL_PER   = 100.0 / (MATCH_FALL_FATAL - MATCH_FALL_SAFE);   // dmg per unit over safe

// ── Economy (Phase 6C) ───────────────────────────────────────────────────────
const MATCH_START_MONEY = 16000;
const MATCH_MONEY_CAP   = 16000;
const MATCH_WIN_REWARD  = 3250;
const MATCH_LOSS_REWARD  = 1400;
const MATCH_NADE_CAP    = { hegrenade: 1, flashbang: 2, smokegrenade: 1 };

// Buy catalog (must mirror BUY_CATALOG in game.js). team: both|ct|t. kind defaults
// 'weapon'; slot only matters for weapons (one per slot, like CS). Items with no model
// (elites, scout, shotguns, nvg, …) aren't here — not buyable.
const MATCH_BUY = {
  usp:      { price: 500,  team: 'both', slot: 'secondary' },
  glock18:  { price: 400,  team: 'both', slot: 'secondary' },
  deagle:   { price: 650,  team: 'both', slot: 'secondary' },
  p228:     { price: 600,  team: 'both', slot: 'secondary' },
  fiveseven:{ price: 750,  team: 'ct',   slot: 'secondary' },
  mp5:      { price: 1500, team: 'both', slot: 'primary' },
  tmp:      { price: 1250, team: 'ct',   slot: 'primary' },
  mac10:    { price: 1400, team: 't',    slot: 'primary' },
  ump45:    { price: 1700, team: 'both', slot: 'primary' },
  p90:      { price: 2350, team: 'both', slot: 'primary' },
  famas:    { price: 2250, team: 'ct',   slot: 'primary' },
  galil:    { price: 2000, team: 't',    slot: 'primary' },
  m4:       { price: 3100, team: 'ct',   slot: 'primary' },
  ak47:     { price: 2500, team: 't',    slot: 'primary' },
  awp:      { price: 4750, team: 'both', slot: 'primary' },
  aug:      { price: 3500, team: 'ct',   slot: 'primary' },
  sg552:    { price: 3500, team: 't',    slot: 'primary' },
  m249:     { price: 5750, team: 'both', slot: 'primary' },
  // Non-canon HL weapons — only buyable when the server's mp_hl_weapons flag is on (hl:true).
  rpg:      { price: 6000, team: 'both', slot: 'primary', hl: true },
  crossbow: { price: 2500, team: 'both', slot: 'primary', hl: true },
  flashbang:   { price: 200, team: 'both', kind: 'nade' },
  hegrenade:   { price: 300, team: 'both', kind: 'nade' },
  smokegrenade:{ price: 300, team: 'both', kind: 'nade' },
  kevlar:      { price: 650,  team: 'both', kind: 'armor' },
  kevlarhelm:  { price: 1000, team: 'both', kind: 'helm' },
  defusekit:   { price: 200,  team: 'ct',   kind: 'dk' },
};

// ── C4 bomb (Phase 6D) — numbers mirror rounds.js ────────────────────────────
const MATCH_C4_TIME      = 40;    // fuse seconds after a successful plant
const MATCH_PLANT_TIME   = 3.0;   // hold seconds to plant (standing in a bombsite)
const MATCH_DEFUSE_TIME  = 10;    // hold seconds to defuse without a kit
const MATCH_DEFUSE_KIT   = 5;     // …with a defuse kit
const MATCH_C4_DAMAGE    = 500;   // blast damage at the origin
const MATCH_C4_RADIUS    = 700;   // blast radius (units)
const MATCH_PLANT_REWARD = 800;   // money awarded for planting
const MATCH_HE_DAMAGE    = 100;   // HE grenade blast (ReGameDLL pev->dmg) …
const MATCH_HE_RADIUS    = 350;   // … radius = dmg×3.5 (CBaseMonster::RadiusDamage)

// Per-kill reward (ReGameDLL: knife $1500, most guns $300). 🔹 Approx — flat $300 otherwise.
function matchKillReward(weapon) { return weapon === 'knife' ? 1500 : 300; }

// Friendly-fire: teammates take REDUCED damage (not zero). 🔹 Tunable; vanilla CS 1.6 is
// 0 or full (mp_friendlyfire), we use a partial factor. Self-damage is always full.
const MATCH_FF_MULT = 0.35;
function matchFFMult(attacker, victim) {
  if (!attacker || !victim || attacker === victim) return 1;     // self / unknown → full
  return attacker.team === victim.team ? MATCH_FF_MULT : 1;
}

function _matchGive(pl, amount) { pl.money = Math.min(MATCH_MONEY_CAP, pl.money + amount); }

// Validate + apply a buy to a player's economy (money/weapons/nades/armor/helmet/dk).
// Mutates pl on success. Returns { ok, reason, id, kind }. Phase/zone are checked by the
// caller (it has the match phase + the player's position vs buy zones).
function matchBuy(pl, id, opts) {
  const it = MATCH_BUY[id];
  if (!it) return { ok: false, reason: 'Недоступно' };
  if (it.hl && !(opts && opts.hlWeapons)) return { ok: false, reason: 'Недоступно' };   // HL weapons gated by mp_hl_weapons
  if (it.team !== 'both' && it.team !== pl.team) return { ok: false, reason: 'Недоступно вашей команде' };
  const kind = it.kind || 'weapon';

  if (kind === 'armor' || kind === 'helm') {
    const wantHelm = kind === 'helm';
    if (pl.armor >= MATCH_MAX_AP && (!wantHelm || pl.helmet)) return { ok: false, reason: 'Броня уже есть' };
    if (pl.money < it.price) return { ok: false, reason: 'Недостаточно денег' };
    pl.money -= it.price; pl.armor = MATCH_MAX_AP; if (wantHelm) pl.helmet = true;
    return { ok: true, id, kind };
  }
  if (kind === 'dk') {
    if (pl.dk) return { ok: false, reason: 'Дефуз-кит уже есть' };
    if (pl.money < it.price) return { ok: false, reason: 'Недостаточно денег' };
    pl.money -= it.price; pl.dk = true;
    return { ok: true, id, kind };
  }
  if (kind === 'nade') {
    // Server charges money only; the LIVE grenade count is client-owned (so a thrown nade
    // isn't restored by gstate). The client enforces the per-type cap before sending.
    if (pl.money < it.price) return { ok: false, reason: 'Недостаточно денег' };
    pl.money -= it.price;
    return { ok: true, id, kind: 'nade' };
  }
  // weapon (primary/secondary): one per slot — buying drops the old one of that slot.
  if (pl.money < it.price) return { ok: false, reason: 'Недостаточно денег' };
  pl.money -= it.price;
  for (const w of [...pl.weapons]) {
    if (w === id || w === 'knife') continue;
    const o = MATCH_BUY[w];
    if (o && (o.kind || 'weapon') === 'weapon' && o.slot === it.slot) pl.weapons.delete(w);
  }
  pl.weapons.add(id);
  return { ok: true, id, kind: 'weapon', slot: it.slot };
}

function matchCreate(map) {
  return {
    map: map || 'de_dust2',
    phase: 'warmup',            // 'warmup' | 'buy' | 'live' | 'over'
    round: 0,
    timer: 0,                   // remaining seconds of the current phase
    scoreT: 0, scoreCT: 0,
    winner: null, reason: '',   // last round result (shown during 'over')
    bomb: null,                 // planted C4 (Phase 6D): { pos, site, timer, defuseProg, live }
    bombResult: null,           // 'explode' | 'defuse' for one round — drives the client cue
    _ended: false,
  };
}

// Advance the match by dt seconds against the current roster. roster entries:
// { team:'t'|'ct', alive:bool, joined:bool }. Returns events the caller acts on:
// { roundStart:bool, roundEnd:{winner,reason}|null }.
function matchTick(ms, roster, dt) {
  const ev = { roundStart: false, roundEnd: null };
  const joined = roster.filter(p => p.joined);

  if (ms.phase === 'warmup') {
    if (joined.length >= MATCH_WARMUP_MIN) _matchStartRound(ms, ev);
    return ev;
  }

  ms.timer -= dt;

  if (ms.phase === 'buy') {
    // Elimination can already settle it; otherwise buy time elapses into live.
    const w = _matchCheckElim(joined, false);
    if (w) { _matchEndRound(ms, ev, w.winner, w.reason); return ev; }
    if (ms.timer <= 0) { ms.phase = 'live'; ms.timer = MATCH_ROUND_TIME; }
    return ev;
  }

  if (ms.phase === 'live') {
    // A planted bomb runs its OWN fuse; the round clock no longer ends the round. The bomb
    // must be defused (CT win) or it detonates → T win + blast damage (applied by the server,
    // which has the geometry). ev.bombDetonate tells the server where to apply it.
    if (ms.bomb && ms.bomb.live) {
      ms.bomb.timer -= dt;
      if (ms.bomb.timer <= 0) {
        ev.bombDetonate = { pos: ms.bomb.pos.slice() };
        ms.bombResult = 'explode';
        _matchEndRound(ms, ev, 't', 'Бомба взорвана — победа Террористов');
        return ev;
      }
    }
    const w = _matchCheckElim(joined, !!(ms.bomb && ms.bomb.live));
    if (w) { _matchEndRound(ms, ev, w.winner, w.reason); return ev; }
    if (!ms.bomb && ms.timer <= 0) _matchEndRound(ms, ev, 'ct', 'Время вышло — победа Контр-террористов');
    return ev;
  }

  if (ms.phase === 'over') {
    if (ms.timer <= 0) {
      if (joined.length >= MATCH_WARMUP_MIN) _matchStartRound(ms, ev);
      else { ms.phase = 'warmup'; ms.timer = 0; }    // everyone left → back to warmup
    }
    return ev;
  }

  return ev;
}

function _matchStartRound(ms, ev) {
  ms.round++;
  ms.phase = 'buy';
  ms.timer = MATCH_BUY_TIME;
  ms.winner = null; ms.reason = '';
  ms.bomb = null;             // fresh round → no planted bomb (carrier reassigned by the server)
  ms.bombResult = null;
  ms._ended = false;
  ev.roundStart = true;
}

// Server validated a completed plant (carrier + bombsite + 3s hold) → arm the bomb.
function matchBombPlant(ms, pos, site) {
  ms.bomb = { pos: [pos[0], pos[1], pos[2]], site: site || 'a', timer: MATCH_C4_TIME, defuseProg: 0, live: true };
}
// Server validated a completed defuse → CT win (ev carries the round-end for reward handling).
function matchBombDefuse(ms, ev) {
  ms.bombResult = 'defuse';
  _matchEndRound(ms, ev, 'ct', 'Бомба обезврежена — победа Контр-террористов');
}

function _matchEndRound(ms, ev, winner, reason) {
  if (ms._ended) return;
  ms._ended = true;
  ms.phase = 'over';
  ms.timer = MATCH_ROUND_END;
  ms.bomb = null;             // any round end removes the planted bomb (cue via ms.bombResult)
  ms.winner = winner; ms.reason = reason;
  if (winner === 't') ms.scoreT++; else ms.scoreCT++;
  ev.roundEnd = { winner, reason };
}

// Elimination needs BOTH teams present (else a one-team practice round only ends on the
// clock). A team that has members but none alive loses.
function _matchCheckElim(joined, bombPlanted) {
  const t = joined.filter(p => p.team === 't');
  const ct = joined.filter(p => p.team === 'ct');
  if (!t.length || !ct.length) return null;
  const tAlive = t.some(p => p.alive), ctAlive = ct.some(p => p.alive);
  // CTs all dead → T win, always.
  if (!ctAlive && tAlive) return { winner: 't',  reason: 'Спецназ уничтожен — победа Террористов' };
  // With the bomb live, wiping the Ts does NOT end the round — the CTs still have to defuse.
  if (bombPlanted) return null;
  if (!tAlive && ctAlive) return { winner: 'ct', reason: 'Террористы уничтожены — победа Контр-террористов' };
  if (!tAlive && !ctAlive) return { winner: 'ct', reason: 'Ничья — раунд за Контр-террористами' };
  return null;
}

// ── Player HP / armor / death (Phase 6B) ─────────────────────────────────────
// Apply PRE-armor damage to a player (kevlar absorbs covered zones — CS/ReGameDLL
// model: half to health, the rest eats armor at the bonus ratio). Mutates pl.hp /
// pl.armor / pl.alive. `hg` only selects armor coverage (the hitgroup multiplier is
// already baked into `dmg` for bullets). Returns { dealt, died }.
function matchApplyDamage(pl, dmg, hg) {
  if (!pl.alive || dmg <= 0) return { dealt: 0, died: false };
  const covered = (hg === 2 || hg === 3 || hg === 4 || hg === 5) || (hg === 1 && pl.helmet);
  let d = dmg;
  if (pl.armor > 0 && covered) {
    const RATIO = 0.5, BONUS = 0.5;
    let toHealth = d * RATIO;
    let toArmor  = (d - toHealth) * BONUS;
    if (toArmor > pl.armor) { toArmor = pl.armor / BONUS; toHealth = d - toArmor; pl.armor = 0; }
    else pl.armor -= toArmor;
    d = toHealth;
  }
  d = Math.max(0, Math.round(d));
  if (d <= 0) return { dealt: 0, died: false };
  pl.hp -= d;
  let died = false;
  if (pl.hp <= 0) { pl.hp = 0; pl.alive = false; died = true; }
  return { dealt: d, died };
}

// Fall damage for a touchdown speed (GoldSrc-style linear over the safe threshold).
function matchFallDamage(fallVel) {
  return fallVel > MATCH_FALL_SAFE ? (fallVel - MATCH_FALL_SAFE) * MATCH_FALL_PER : 0;
}

// Round respawn: full HP + alive again (armor/helmet persist across rounds, CS-style).
function matchRevive(pl) { pl.hp = MATCH_MAX_HP; pl.alive = true; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    matchCreate, matchTick, matchApplyDamage, matchFallDamage, matchRevive,
    matchBuy, matchKillReward, matchFFMult, matchBombPlant, matchBombDefuse,
    MATCH_BUY_TIME, MATCH_ROUND_TIME, MATCH_ROUND_END, MATCH_WARMUP_MIN, MATCH_MAX_HP, MATCH_FF_MULT,
    MATCH_START_MONEY, MATCH_MONEY_CAP, MATCH_WIN_REWARD, MATCH_LOSS_REWARD, MATCH_BUY,
    MATCH_C4_TIME, MATCH_PLANT_TIME, MATCH_DEFUSE_TIME, MATCH_DEFUSE_KIT,
    MATCH_C4_DAMAGE, MATCH_C4_RADIUS, MATCH_PLANT_REWARD, MATCH_HE_DAMAGE, MATCH_HE_RADIUS,
  };
}
