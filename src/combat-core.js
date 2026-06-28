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

// Node-only export (browser sees the same names as globals).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    combatRayHitPlayer, combatDamage, combatVelMod,
    COMBAT_WEAPON_DMG, COMBAT_HG_MULT, COMBAT_PEN_MULT,
    COMBAT_BOX_STAND, COMBAT_BOX_DUCK, COMBAT_HW, COMBAT_LARGE_FLINCH,
  };
}
