// combat-core.js — authoritative bullet hit registration math, shared by the server
// (Phase 5, step D). Dual-mode like sim-core.js: a classic browser script that also
// `module.exports` for Node. PURE: no THREE, no DOM, GoldSrc space (Z-up).
//
// The server can't replay each player's skeletal animation, so for server-side hitreg
// it approximates the per-bone OBB hitboxes with a STANCE-AWARE BOX STACK around the
// authoritative origin (head / chest / stomach / legs). The shooter's client still does
// the precise per-bone ray for its own blood/sound feedback; the server box stack is
// what decides authoritative damage + the hitgroup. 🔹 Approximation — see DIFFERENCES.

// Per-weapon damage + distance falloff (must mirror WPNS in src/weapons.js). dmg/rangeMod
// are the un-silenced values; *Sil override when the shot is suppressed. Range falloff:
// dmg *= rangeMod^(dist/500). Source: CS 1.6 / ReGameDLL.
const COMBAT_WEAPON_DMG = {
  m4:        { dmg: 32,  rangeMod: 0.97,  dmgSil: 33, rangeModSil: 0.95 },
  ak47:      { dmg: 36,  rangeMod: 0.98  },
  galil:     { dmg: 30,  rangeMod: 0.98  },
  famas:     { dmg: 30,  rangeMod: 0.96  },
  aug:       { dmg: 32,  rangeMod: 0.96  },
  sg552:     { dmg: 33,  rangeMod: 0.955 },
  mp5:       { dmg: 26,  rangeMod: 0.84  },
  tmp:       { dmg: 20,  rangeMod: 0.85  },
  mac10:     { dmg: 29,  rangeMod: 0.82  },
  ump45:     { dmg: 30,  rangeMod: 0.82  },
  p90:       { dmg: 21,  rangeMod: 0.885 },
  m249:      { dmg: 32,  rangeMod: 0.97  },
  awp:       { dmg: 115, rangeMod: 0.99  },
  usp:       { dmg: 34,  rangeMod: 0.79,  dmgSil: 30, rangeModSil: 0.79 },
  glock18:   { dmg: 25,  rangeMod: 0.75  },
  deagle:    { dmg: 54,  rangeMod: 0.81  },
  p228:      { dmg: 32,  rangeMod: 0.8   },
  fiveseven: { dmg: 20,  rangeMod: 0.885 },
};

// Hitgroup multipliers (1 head ×4, 2 chest ×1, 3 stomach ×1.25, 4/5 arm ×1, 6/7 leg ×0.75).
const COMBAT_HG_MULT = { 0: 1, 1: 4, 2: 1, 3: 1.25, 4: 1, 5: 1, 6: 0.75, 7: 0.75 };
const COMBAT_PEN_MULT = 0.6;          // damage retained after piercing one body

// Player hull half-width (GoldSrc ±16) and the origin-relative Z box stack. Standing
// hull spans z[-36,36], duck hull z[-18,18]; the stacks below carve that into zones.
const COMBAT_HW = 16;
const COMBAT_BOX_STAND = [
  { hg: 1, zmin:  24, zmax:  36 },    // head
  { hg: 2, zmin:   4, zmax:  24 },    // chest (+ arms)
  { hg: 3, zmin:  -6, zmax:   4 },    // stomach
  { hg: 6, zmin: -36, zmax:  -6 },    // legs
];
const COMBAT_BOX_DUCK = [
  { hg: 1, zmin:  10, zmax:  18 },
  { hg: 2, zmin:  -2, zmax:  10 },
  { hg: 3, zmin:  -8, zmax:  -2 },
  { hg: 6, zmin: -18, zmax:  -8 },
];

// Ray (origin o, dir d) vs axis-aligned box [bmin,bmax]. Returns the entry distance
// (>=0) along d, or -1 if no hit. Slab method; d need not be normalised for the test
// but the returned value is in d-length units (we pass a normalised d so it's distance).
function _combatRayAABB(o, d, bmin, bmax) {
  let tmin = 0, tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < bmin[a] || o[a] > bmax[a]) return -1;
    } else {
      const inv = 1 / d[a];
      let t1 = (bmin[a] - o[a]) * inv, t2 = (bmax[a] - o[a]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

// Ray vs a player at `pos` (GoldSrc origin) in the given stance. Returns the nearest
// box hit { hg, dist } (distance along the ray), or null if the ray misses.
function combatRayHitPlayer(o, d, pos, ducked) {
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  const dir = [d[0] / dl, d[1] / dl, d[2] / dl];
  const stack = ducked ? COMBAT_BOX_DUCK : COMBAT_BOX_STAND;
  let best = Infinity, hg = -1;
  for (const b of stack) {
    const bmin = [pos[0] - COMBAT_HW, pos[1] - COMBAT_HW, pos[2] + b.zmin];
    const bmax = [pos[0] + COMBAT_HW, pos[1] + COMBAT_HW, pos[2] + b.zmax];
    const t = _combatRayAABB(o, dir, bmin, bmax);
    if (t >= 0 && t < best) { best = t; hg = b.hg; }
  }
  return hg >= 0 ? { hg, dist: best } : null;
}

// Authoritative pre-armor damage for one bullet: weapon base × distance falloff ×
// hitgroup. The victim's client still applies its own kevlar (covered zones). Returns 0
// for an unknown weapon.
function combatDamage(weaponId, dist, hg, silenced) {
  const w = COMBAT_WEAPON_DMG[weaponId];
  if (!w) return 0;
  let dmg = (silenced && w.dmgSil != null) ? w.dmgSil : w.dmg;
  const rm = (silenced && w.rangeModSil != null) ? w.rangeModSil : w.rangeMod;
  dmg *= Math.pow(rm, dist / 500);
  dmg *= (COMBAT_HG_MULT[hg] != null ? COMBAT_HG_MULT[hg] : 1);
  return dmg;
}

// Bullet "tagging" velocity modifier (GoldSrc CBasePlayer::TraceAttack → TakeDamageImpulse):
// a hit drops the victim's velMod, which then recovers in sim-core (PreThink). "Large flinch"
// guns set 0.65; everything else sets 0.5 — the STRONGER slowdown — so a Glock/USP/SMG tags
// harder than a rifle. A leg hit or a ducking victim is always the small flinch (0.5) too.
// Source: ReGameDLL CBasePlayer::ShouldDoLargeFlinch. (The original ALSO adds a knockback
// impulse on the large-flinch path — not modelled here; see DIFFERENCES.) Our M4's id is 'm4'.
const COMBAT_LARGE_FLINCH = new Set([
  'scout', 'aug', 'sg550', 'galil', 'famas', 'awp', 'm3', 'm4', 'g3sg1', 'deagle', 'sg552', 'ak47',
]);
function combatVelMod(weaponId, hg, ducked) {
  const leg = (hg === 6 || hg === 7);
  const large = !ducked && !leg && COMBAT_LARGE_FLINCH.has(weaponId);
  return large ? 0.65 : 0.5;
}

// ── Ammo economy (ReGameDLL weapontype.h / weapontype.cpp) ──────────────────────
// One purchase (',' / '.', or the ammo menu) buys ONE pack of the gun's calibre: `buy`
// rounds for `price`, clamped to the `max` a player can carry (full price even when only
// part of the pack fits; refused when already full — BuyGunAmmo). Shared by the client
// (solo) and the server (MP validation), so both charge the same.
const COMBAT_AMMO = {
  '338magnum':  { price: 125, buy: 10, max: 30 },
  '357sig':     { price: 50,  buy: 13, max: 52 },
  '45acp':      { price: 25,  buy: 12, max: 100 },
  '50ae':       { price: 40,  buy: 7,  max: 35 },
  '556nato':    { price: 60,  buy: 30, max: 90 },
  '556natobox': { price: 60,  buy: 30, max: 200 },
  '57mm':       { price: 50,  buy: 50, max: 100 },
  '762nato':    { price: 80,  buy: 30, max: 90 },
  '9mm':        { price: 20,  buy: 30, max: 120 },
};
const COMBAT_WEAPON_CALIBER = {
  usp: '45acp', glock18: '9mm', deagle: '50ae', p228: '357sig', fiveseven: '57mm',
  mp5: '9mm', tmp: '9mm', mac10: '45acp', ump45: '45acp', p90: '57mm',
  famas: '556nato', galil: '556nato', m4: '556nato', aug: '556nato', sg552: '556nato',
  ak47: '762nato', awp: '338magnum', m249: '556natobox',
};
// Spawn sidearm backpack ammo (CBasePlayer::GiveDefaultItems, CS 1.6): USP 12 + 24, Glock 20 + 40.
// A BOUGHT gun comes with a full magazine and no reserve at all.
const COMBAT_SPAWN_RESERVE = { usp: 24, glock18: 40 };
// Armour purchase (ReGameDLL BuyItem, MENU_SLOT_ITEM_VEST / _VESTHELM). Returns the price to
// charge, or null when the purchase is refused (already have it). armor: 0..100, helmet: bool.
//   vest:      full armour → refused; else 650.
//   vest+helm: full armour → helmet 350 (refused if the helmet is there too);
//              not full   → 650 if the helmet is already there, else 1000.
function combatArmorPrice(wantHelm, armor, helmet) {
  const full = armor >= 100;
  if (!wantHelm) return full ? null : 650;
  if (full) return helmet ? null : 350;
  return helmet ? 650 : 1000;
}
function combatAmmoPack(weaponId) {
  const c = COMBAT_WEAPON_CALIBER[weaponId];
  return c ? COMBAT_AMMO[c] : null;
}

// ── Round money (ReGameDLL gamerules.h REWARD_* + multiplay_gamerules.cpp) ─────────────────
// Team payouts at round end on a bomb map (de_dust2):
//   bomb exploded (Target_Bombed)   T  3500
//   bomb defused  (Target_Defused)  CT 3250, and the LOSING Ts still get 800 for the plant
//   elimination   (Round_Ts/Round_Cts on a bomb map) winner 3250
//   time ran out  (Target_Saved)    CT 3250
// The losing team gets the loss bonus: 1400 to start; from the 2nd straight loss +500 per loss
// while it is below 3000 (so it tops out at 3400, as in 1.6); a team that breaks its own losing
// streak resets it to 1500. ONE bonus value shared by both teams, as in the original.
// Kills: +300 per enemy (any weapon), −3300 for a teammate (PAYBACK_FOR_KILLED_TEAMMATES).
const COMBAT_REWARD = {
  explode: 3500, defuse: 3250, elim: 3250, time: 3250,
  plantedLost: 800, killEnemy: 300, killTeammate: -3300,
  lossDefault: 1400, lossMin: 1500, lossMax: 3000, lossAdd: 500,
};
function combatEconomyNew() { return { lossBonus: COMBAT_REWARD.lossDefault, tLosses: 0, ctLosses: 0 }; }
// eco: combatEconomyNew() state (mutated). winner 't'|'ct'; kind 'explode'|'defuse'|'elim'|'time'.
// Returns the per-player payout for each team: { t, ct }.
function combatRoundMoney(eco, winner, kind) {
  const R = COMBAT_REWARD;
  if (winner === 't') { if (eco.tLosses > 1) eco.lossBonus = R.lossMin; eco.tLosses = 0; eco.ctLosses++; }
  else                { if (eco.ctLosses > 1) eco.lossBonus = R.lossMin; eco.ctLosses = 0; eco.tLosses++; }
  if (eco.tLosses > 1 && eco.lossBonus < R.lossMax)       eco.lossBonus += R.lossAdd;
  else if (eco.ctLosses > 1 && eco.lossBonus < R.lossMax) eco.lossBonus += R.lossAdd;
  const out = { t: 0, ct: 0 };
  out[winner] += R[kind] || 0;
  out[winner === 't' ? 'ct' : 't'] += eco.lossBonus;
  if (kind === 'defuse') out.t += R.plantedLost;
  return out;
}
function combatKillReward(teamKill) { return teamKill ? COMBAT_REWARD.killTeammate : COMBAT_REWARD.killEnemy; }

// Node-only export (browser sees the same names as globals).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    combatRayHitPlayer, combatDamage, combatVelMod,
    COMBAT_WEAPON_DMG, COMBAT_HG_MULT, COMBAT_PEN_MULT,
    COMBAT_BOX_STAND, COMBAT_BOX_DUCK, COMBAT_HW, COMBAT_LARGE_FLINCH,
    COMBAT_AMMO, COMBAT_WEAPON_CALIBER, COMBAT_SPAWN_RESERVE, combatAmmoPack, combatArmorPrice,
    COMBAT_REWARD, combatEconomyNew, combatRoundMoney, combatKillReward,
  };
}
