// weapons.js — weapon configs, switching, skeletal animation, firing/recoil, melee.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── Weapon configs ────────────────────────────────────────────────────────
const D = Math.PI / 180;
const SHOT_RANGE = 8192;   // hitscan trace length (GoldSrc engine max) — far targets still register

// Builds a standard auto-rifle entry (shared rig offsets + idle/shoot1-3/reload/draw
// sequences). Stats (damage/rangeMod/fireInterval/clip/reload) come from CS/ReGameDLL.
// These models (galil/famas/aug/sg552) name their idle sequence 'idle'; pass s.idle
// to override for a model that uses a different name (e.g. ak47's 'idle1').
function _autoRifle(id, label, s) {
  const fire = s.fire || ['shoot1', 'shoot2', 'shoot3'];
  return [{
    id, label,
    jsonFile: `models/v_${id}.json`,
    idleSeq: s.idle || 'idle', drawSeq: 'draw', reloadSeq: 'reload',
    fireSeq: fire[0], fireSeqsUnsil: fire,
    silencer: false, autofire: true,
    fireInterval: s.fireInterval, spread: s.spread,
    fireSound: s.fireSound,                                  // code-driven gunfire (random over the list)
    damage: s.damage, rangeMod: s.rangeMod,
    recoilProc: { pitch: s.recoilP, stemShots: 3, latBase: 0.4, latGrow: 0.09, latMax: 1.1, flipChance: 5 },
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun', shellType: s.shellType || 'rifle',
    flashSX: 0.5, flashSY: 0.5, flashType: s.flashType || 'rifle',
    muzzleBone: s.muzzleBone, muzzleOrg: s.muzzleOrg,         // attachment 0 from the MDL
    ejectionBone: s.ejectBone, ejectionOrg: s.ejectOrg,      // attachment 1 from the MDL
    ammo: s.ammo, maxAmmo: s.ammo, reserve: s.reserve || 90, reloadTime: s.reload,
    maxSpeed: s.maxSpeed || 250,                             // CS 1.6 m_flMaxSpeed (run cap)
    slot: 'primary',
    root: null,
  }];
}

// Standard semi-auto pistol entry (shared rig offsets). Per-weapon fire sequences.
function _pistol(id, label, s) {
  return [{
    id, label,
    jsonFile: `models/v_${id}.json`,
    idleSeq: s.idle || 'idle1', drawSeq: 'draw', reloadSeq: 'reload',
    fireSeq: s.fire[0], fireSeqsUnsil: s.fire,
    silencer: false, autofire: false,
    fireInterval: s.fireInterval, recoilKick: s.recoilKick,
    spread: s.spread, spreadGrow: s.spreadGrow ?? 0.004, spreadMax: s.spreadMax ?? 0.05,
    fireSound: s.fireSound,                                  // code-driven gunfire (random over the list)
    damage: s.damage, rangeMod: s.rangeMod,
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun', shellType: 'pistol',
    flashSX: 0.5, flashSY: 0.5, flashType: 'pistol',
    muzzleBone: s.muzzleBone, muzzleOrg: s.muzzleOrg,         // attachment 0 from the MDL
    ejectionBone: s.ejectBone, ejectionOrg: s.ejectOrg,      // attachment 1 from the MDL
    ammo: s.ammo, maxAmmo: s.ammo, reserve: s.reserve, reloadTime: s.reload,
    maxSpeed: s.maxSpeed || 250,                             // CS 1.6 m_flMaxSpeed (run cap)
    // Burst fire (Glock): RMB toggles a 3-round burst per trigger pull.
    burstCapable: s.burstCapable, burstCount: s.burstCount,
    burstInterval: s.burstInterval, burstCooldown: s.burstCooldown,
    slot: 'secondary',
    root: null,
  }];
}

// Throwable (HE / flashbang / smoke): deploy → idle → pullpin (hold) → throw.
// No ammo/reserve; ownership/count lives in game.js (grenadeCounts). The pin sound
// fires from the MDL event in 'pullpin'; the projectile + detonation live in grenades.js.
function _grenade(id, label) {
  return [{
    id, label,
    jsonFile: `models/v_${id}.json`,
    idleSeq: 'idle', drawSeq: 'deploy',
    pullpinSeq: 'pullpin', throwSeq: 'throw',
    throwReleaseT: 0.3,        // seconds into the throw anim when the nade leaves the hand
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'grenade', slot: 'grenade',
    grenadeType: id,
    root: null,
  }];
}

const WPNS = [
  {
    id: 'm4', label: 'M4A1',
    jsonFile: 'models/v_m4a1.json', jsonFileSil: 'models/v_m4a1_sil.json',
    idleSeq: 'idle_unsil', idleSeqSil: 'idle',
    fireSeq: 'shoot1_unsil', fireSeqSil: 'shoot1',
    fireSeqsUnsil: ['shoot1_unsil', 'shoot2_unsil', 'shoot3_unsil'],
    fireSeqsSil:   ['shoot1', 'shoot2', 'shoot3'],
    reloadSeq: 'reload_unsil', reloadSeqSil: 'reload',
    drawSeq: 'draw_unsil', drawSeqSil: 'draw',
    silencer: false,
    autofire: true,
    fireInterval: 0.09,
    spread: 0.012,
    // Code-driven gunfire (random over the list). Silenced uses its own sample.
    fireSound:    ['weapons/m4a1_unsil-1.wav', 'weapons/m4a1_unsil-2.wav'],
    fireSoundSil: ['weapons/m4a1-1.wav'],
    // CS 1.6: 32/bullet (33 silenced), range falloff ×rangeMod per 500u
    damage: 32, rangeMod: 0.97, damageSil: 33, rangeModSil: 0.95,
    // CS 1.6-style procedural recoil (KickBack): vertical grows each shot (the
    // T's stem), lateral starts after a few shots and grows, applied in a
    // direction that RANDOMLY flips — so the horizontal bar is different every
    // burst (sometimes long one way, sometimes switches). Degrees per shot.
    recoilProc: {
      pitch:     0.85,  // vertical kick per shot (degrees)
      stemShots: 4,     // shots kept vertical before the bar starts
      latBase:   0.35,  // lateral kick when the bar begins
      latGrow:   0.08,  // lateral added per shot into the bar
      latMax:    1.0,   // per-shot lateral cap
      flipChance: 6,    // direction flips with probability 1/(flipChance+1) per shot
    },
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun',
    muzzleBone: 41, muzzleOrg: [0, -14.25, 0], muzzleOrgSil: [0, -18.5, 0],
    ejectionBone: 41, ejectionOrg: [0, -1.25, 0], shellType: 'rifle',
    flashSX: 0.5, flashSY: 0.5, flashType: 'rifle',
    ammo: 30, maxAmmo: 30,
    reserve: 90, reloadTime: 3.1,
    maxSpeed: 230,            // CS 1.6 m_flMaxSpeed (run cap)
    slot: 'primary',
    root: null,
  },
  // ── Auto-rifles (group 1). Stats verified vs ReGameDLL; view-model placement
  // reuses the shared rig offsets; muzzle/ejection bones omitted (flash/shell fall
  // back to centered) — to be tuned per model later. Sequences: idle1/shoot1-3/reload/draw.
  ..._autoRifle('ak47',  'AK-47',          { damage: 36, rangeMod: 0.98,  fireInterval: 0.0975, ammo: 30, reload: 2.45, recoilP: 1.05, spread: 0.016, maxSpeed: 221, fireSound: ['weapons/ak47-1.wav', 'weapons/ak47-2.wav'], muzzleBone: 20, muzzleOrg: [2.75, -22.5, 2.9],  ejectBone: 41, ejectOrg: [0, -3.0, 0] }),
  ..._autoRifle('galil', 'IDF Defender',   { damage: 30, rangeMod: 0.98,  fireInterval: 0.0875, ammo: 35, reload: 2.45, recoilP: 0.9,  spread: 0.014, maxSpeed: 240, fireSound: ['weapons/galil-1.wav', 'weapons/galil-2.wav'], muzzleBone: 12, muzzleOrg: [0, -20.18, 0.42],  ejectBone: 12, ejectOrg: [-0.6, -3.9, 1.0] }),
  ..._autoRifle('famas', 'Clarion 5.56',   { damage: 30, rangeMod: 0.96,  fireInterval: 0.09,   ammo: 25, reload: 3.3,  recoilP: 0.8,  spread: 0.013, maxSpeed: 240, fireSound: ['weapons/famas-1.wav', 'weapons/famas-2.wav'], muzzleBone: 45, muzzleOrg: [0, 14.5, -2.9],    ejectBone: 45, ejectOrg: [-0.8, -4.4, -3.2] }),
  ..._autoRifle('aug',   'Bullpup',        { damage: 32, rangeMod: 0.96,  fireInterval: 0.09,   ammo: 30, reload: 3.3,  recoilP: 0.85, spread: 0.013, maxSpeed: 240, fireSound: ['weapons/aug-1.wav'], muzzleBone: 20, muzzleOrg: [2.4, -15.7, 1.1],   ejectBone: 41, ejectOrg: [-0.75, 4.0, 0.75] }),
  ..._autoRifle('sg552', 'Krieg 552',      { damage: 33, rangeMod: 0.955, fireInterval: 0.0825, ammo: 30, reload: 3.0,  recoilP: 0.95, spread: 0.014, maxSpeed: 235, fireSound: ['weapons/sg552-1.wav', 'weapons/sg552-2.wav'], muzzleBone: 38, muzzleOrg: [0, -11.25, -0.5],  ejectBone: 38, ejectOrg: [0, -1.0, 0] }),
  // ── SMGs (group 3, full-auto, 9mm/.45 shells). Stats verified vs ReGameDLL.
  ..._autoRifle('mp5',   'MP5 Navy',  { damage: 26, rangeMod: 0.84,  fireInterval: 0.08,   ammo: 30, reserve: 120, reload: 2.6, recoilP: 0.55, spread: 0.016, fireSound: ['weapons/mp5-1.wav', 'weapons/mp5-2.wav'], shellType: 'pistol', muzzleBone: 20, muzzleOrg: [3.4, -13.7, 2.5],  ejectBone: 38, ejectOrg: [0, -1.5, 0] }),
  ..._autoRifle('tmp',   'TMP',       { damage: 20, rangeMod: 0.85,  fireInterval: 0.07,   ammo: 30, reserve: 120, reload: 2.1, recoilP: 0.4,  spread: 0.016, fireSound: ['weapons/tmp-1.wav', 'weapons/tmp-2.wav'], shellType: 'pistol', fire: ['shoot'], muzzleBone: 20, muzzleOrg: [2.5, -15.8, 2.25],  ejectBone: 40, ejectOrg: [0, -1.0, 0.5] }),
  ..._autoRifle('mac10', 'MAC-10',    { damage: 29, rangeMod: 0.82,  fireInterval: 0.075,  ammo: 30, reserve: 100, reload: 3.1, recoilP: 0.6,  spread: 0.02,  fireSound: ['weapons/mac10-1.wav'], shellType: 'pistol', muzzleBone: 20, muzzleOrg: [2.0, -8.0, 0.5],   ejectBone: 40, ejectOrg: [0, -2.0, 0] }),
  ..._autoRifle('ump45', 'UMP45',     { damage: 30, rangeMod: 0.82,  fireInterval: 0.095,  ammo: 25, reserve: 100, reload: 3.5, recoilP: 0.55, spread: 0.016, fireSound: ['weapons/ump45-1.wav'], shellType: 'pistol', muzzleBone: 41, muzzleOrg: [0, -8.3, 0],       ejectBone: 41, ejectOrg: [0, -1.0, 0] }),
  ..._autoRifle('p90',   'P90',       { damage: 21, rangeMod: 0.885, fireInterval: 0.07,   ammo: 50, reserve: 100, reload: 3.3, recoilP: 0.5,  spread: 0.016, maxSpeed: 245, fireSound: ['weapons/p90-1.wav'], shellType: 'pistol', idle: 'idle', muzzleBone: 20, muzzleOrg: [1.9, -8.6, 1.5],   ejectBone: 39, ejectOrg: [1.0, -2.0, 0] }),
  // ── Machine gun (group 5, full-auto). Verified vs ReGameDLL.
  ..._autoRifle('m249',  'M249 Para', { damage: 32, rangeMod: 0.97,  fireInterval: 0.10,   ammo: 100, reserve: 200, reload: 4.7, recoilP: 1.0, spread: 0.012,
                  maxSpeed: 220, fireSound: ['weapons/m249-1.wav', 'weapons/m249-2.wav'], fire: ['shoot1', 'shoot2'], muzzleBone: 20, muzzleOrg: [3.6, -18.4, 2.75],  ejectBone: 49, ejectOrg: [0, 0, 0] }),
  // ── Sniper rifle (group 4). Bolt-action, semi-auto, scoped. Stats from ReGameDLL:
  // 115 dmg, near-zero range falloff (longest range), 1.5s bolt cycle, RMB scope
  // cycles FOV 90→40→10→90. Pinpoint when still, accuracy wrecked by movement.
  {
    id: 'awp', label: 'AWP',
    jsonFile: 'models/v_awp.json',
    idleSeq: 'idle1', drawSeq: 'draw', reloadSeq: 'reload',
    fireSeq: 'shoot1', fireSeqsUnsil: ['shoot1', 'shoot2', 'shoot3'],
    silencer: false, autofire: false,
    fireInterval: 1.5,           // bolt-action cycle (ReGameDLL GetNextAttackDelay 1.5)
    recoilKick: 0.22,            // big single-shot vertical screen punch
    spread: 0.001,               // pinpoint when standing still
    moveSpreadMult: 3.0,         // movement wrecks accuracy (sniper)
    fireSound: ['weapons/awp1.wav'],          // code-driven gunfire
    deploySound: 'weapons/awp_deploy.wav',    // draw has no MDL event → code-driven
    zoomFovs: [40, 10],          // RMB cycles 90 → 40 → 10 → 90 (ReGameDLL AWP)
    scopeResumeDelay: 1.3,       // unscoped through the bolt cycle (~1.2s anim), re-zooms near the end
    // CS 1.6: 115/bullet, near-zero range falloff (longest range)
    damage: 115, rangeMod: 0.99,
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun', shellType: 'rifle',
    flashSX: 0.5, flashSY: 0.5, flashType: 'rifle',
    muzzleBone: 38, muzzleOrg: [0, -22.0, 0],    // MDL attachment 0 (muzzle)
    ejectionBone: 38, ejectionOrg: [0, -4.5, 0], // MDL attachment 1 (shell)
    ammo: 10, maxAmmo: 10, reserve: 30, reloadTime: 2.93,
    maxSpeed: 210, zoomSpeed: 150,   // CS 1.6: 210 run, drops to 150 while scoped
    slot: 'primary',
    root: null,
  },
  {
    id: 'usp', label: 'USP',
    jsonFile: 'models/v_usp.json', jsonFileSil: 'models/v_usp_sil.json',
    idleSeq: 'idle_unsil', idleSeqSil: 'idle',
    fireSeq: 'shoot1_unsil', fireSeqSil: 'shoot1',
    fireSeqsUnsil:    ['shoot1_unsil', 'shoot2_unsil', 'shoot3_unsil'],
    fireSeqsSil:      ['shoot1', 'shoot2', 'shoot3'],
    fireSeqLastUnsil: 'shootlast_unsil',
    fireSeqLastSil:   'shootlast',
    reloadSeq: 'reload_unsil', reloadSeqSil: 'reload',
    // Code-driven gunfire (random over the list). Silenced uses its own samples.
    fireSound:    ['weapons/usp_unsil-1.wav'],
    fireSoundSil: ['weapons/usp1.wav', 'weapons/usp2.wav'],
    // CS 1.6: 34/bullet (30 silenced), fast range falloff (pistol)
    damage: 34, rangeMod: 0.79, damageSil: 30, rangeModSil: 0.79,
    fireInterval: 0.15,  // semi-auto cycletime (was missing → defaulted to a too-fast 0.12)
    recoilKick: 0.04,    // vertical-only screen kick (unchanged)
    // Bullet scatter widens with fast spam (decal only — screen stays vertical),
    // shrinks back to a tight tap once you pause.
    spread: 0.008,       // tight when tapping
    spreadGrow: 0.005,   // widens per consecutive shot
    spreadMax: 0.05,     // medium-distance scatter cap
    drawSeq: 'draw_unsil', drawSeqSil: 'draw',
    silencer: false,
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun',
    muzzleBone: 20, muzzleOrg: [2.6, -8.1, 1.5], muzzleOrgSil: [2.6, -13.3, 2.0],
    ejectionBone: 42, ejectionOrg: [0, -1.5, 0], shellType: 'pistol',
    flashSX: 0.5, flashSY: 0.5, flashType: 'pistol',
    ammo: 12, maxAmmo: 12,
    reserve: 100, reloadTime: 2.7,
    slot: 'secondary',
    root: null,
  },
  // ── Pistols (group 2, semi-auto). Stats verified vs ReGameDLL. Elite (dual-wield)
  // deferred — it needs alternating left/right shoot sequences.
  // Fire anim: only the subtle slide rack (shoot3). The MDL also has shoot/shoot2, but those
  // throw the right hand far back — in the original the semi-auto glock just clicks the slide
  // with a little recoil, so cycling all three looked wrong (big hand kick on 2 of 3 shots).
  // 🔹 Deviation from the original 3-anim variety — see docs/DIFFERENCES.md.
  ..._pistol('glock18',   'Glock-18',     { damage: 25, rangeMod: 0.75,  ammo: 20, reserve: 120, reload: 2.2, fireInterval: 0.2,   recoilKick: 0.03,  spread: 0.010, fireSound: ['weapons/glock18-2.wav'], fire: ['shoot3'], burstCapable: true, burstCount: 3, burstInterval: 0.1, burstCooldown: 0.3, muzzleBone: 20, muzzleOrg: [2.5, -8.7, 1.7],  ejectBone: 38, ejectOrg: [0, -2.5, 0] }),
  ..._pistol('deagle',    'Desert Eagle', { damage: 54, rangeMod: 0.81,  ammo: 7,  reserve: 35,  reload: 2.2, fireInterval: 0.225, recoilKick: 0.08,  spread: 0.006, spreadGrow: 0.06, spreadMax: 0.10, fireSound: ['weapons/deagle-1.wav', 'weapons/deagle-2.wav'], fire: ['shoot1', 'shoot2'], muzzleBone: 20, muzzleOrg: [2.6, -8.8, 1.4],  ejectBone: 38, ejectOrg: [0, -2.5, 0] }),
  ..._pistol('p228',      'P228 Compact', { damage: 32, rangeMod: 0.8,   ammo: 13, reserve: 52,  reload: 2.7, fireInterval: 0.15,  recoilKick: 0.045, spread: 0.008, fireSound: ['weapons/p228-1.wav'], fire: ['shoot1', 'shoot2', 'shoot3'], muzzleBone: 20, muzzleOrg: [2.6, -6.8, 1.5],  ejectBone: 39, ejectOrg: [0, -2.0, 0] }),
  ..._pistol('fiveseven', 'Five-SeveN',   { damage: 20, rangeMod: 0.885, ammo: 20, reserve: 100, reload: 3.2, fireInterval: 0.15,  recoilKick: 0.03,  spread: 0.008, fireSound: ['weapons/fiveseven-1.wav'], fire: ['shoot1', 'shoot2'], muzzleBone: 41, muzzleOrg: [0, -6.0, 0],  ejectBone: 41, ejectOrg: [0, -2.5, 0] }),
  // ── Half-Life weapons (NON-CANON, opt-in via the server's mp_hl_weapons flag) ──
  // Ported from original HL GoldSrc (v_rpg / v_crossbow). `hl:true` marks them so they
  // can be hidden when the flag is off; `projectile` makes WS.FIRE spawn a travelling
  // rocket/bolt instead of a hitscan bullet (see updateWeapon FIRE branch + projectiles.js).
  // Numbers from HLSDK (rpg.cpp / crossbow.cpp / skill.cfg); 🔹 = approximated for CS — see
  // docs/DIFFERENCES.md. Price is non-canon (no CS value exists).
  {
    id: 'rpg', label: 'RPG', hl: true, leftHandModel: true,
    jsonFile: 'models/v_rpg.json',
    idleSeq: 'idle', drawSeq: 'draw1', reloadSeq: 'reload',
    fireSeq: 'fire', fireSeqsUnsil: ['fire'],
    silencer: false, autofire: false,
    fireInterval: 1.5,            // 🔹 refire/reload gate after a rocket
    fireSound: ['weapons/rocketfire1.wav'],
    // Travelling rocket: ~100 blast dmg, radius-damage (HL plrDmgRPG=100). 🔹 constant speed.
    projectile: { kind: 'rocket', model: 'models/v_rpgrocket.json',
                  speed: 1000, damage: 100, radius: 250, flySound: 'weapons/rocket1.wav' },
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun',
    ammo: 1, maxAmmo: 1, reserve: 4, reloadTime: 2.0,
    maxSpeed: 250,
    slot: 'primary',
    root: null,
  },
  {
    id: 'crossbow', label: 'Crossbow', hl: true, leftHandModel: true,
    jsonFile: 'models/v_crossbow.json',
    idleSeq: 'idle1', drawSeq: 'draw1', reloadSeq: 'reload',
    fireSeq: 'fire1', fireSeqsUnsil: ['fire1'],
    silencer: false, autofire: false,
    fireInterval: 0.75,          // HLSDK crossbow refire
    fireSound: ['weapons/xbow_fire1.wav'],
    zoomFovs: [20],              // RMB toggles the 2× scope (reuses the AWP zoom path)
    // Travelling bolt: sticks where it lands. HL MP bolt dmg = 10 (sk_plr_crossbow). 🔹
    projectile: { kind: 'bolt', model: 'models/v_bolt.json', speed: 2000, damage: 10, stick: true,
                  flySound: 'weapons/xbow_fly1.wav',
                  hitWorld: ['weapons/xbow_hit1.wav', 'weapons/xbow_hit2.wav'],
                  hitBody:  ['weapons/xbow_hitbod1.wav', 'weapons/xbow_hitbod2.wav'] },
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12, type: 'gun',
    ammo: 5, maxAmmo: 5, reserve: 50, reloadTime: 4.5,
    maxSpeed: 240,
    slot: 'primary',
    root: null,
  },
  {
    id: 'knife', label: 'KNIFE',
    jsonFile: 'models/v_knife.json',
    idleSeq: 'idle',
    drawSeq: 'draw',
    pos: new THREE.Vector3(-0.04, -0.20, -0.75),
    rot: { x: -0.10, y: Math.PI / 2, z: 0.15 },
    scale: 0.12,
    type: 'melee',
    slashDamage: 20, stabDamage: 65, backstabMult: 3,   // CS 1.6 knife (swing/stab); ×3 from behind
    // Code-driven knife sounds (no MDL events): swing/stab + flesh/wall hits.
    deploySound:   'weapons/knife_deploy1.wav',
    slashSound:    ['weapons/knife_slash1.wav', 'weapons/knife_slash2.wav'],
    stabSound:     'weapons/knife_stab.wav',
    hitFleshSound: ['weapons/knife_hit1.wav', 'weapons/knife_hit2.wav', 'weapons/knife_hit3.wav', 'weapons/knife_hit4.wav'],
    hitWallSound:  'weapons/knife_hitwall1.wav',
    slot: 'melee',
    root: null,
  },
  // ── Grenades (slot 4). Throw cycle + projectile/detonation in grenades.js.
  ..._grenade('hegrenade',    'HE Grenade'),
  ..._grenade('flashbang',    'Flashbang'),
  ..._grenade('smokegrenade', 'Smoke Grenade'),
];

// ── Canon per-weapon accuracy (ReGameDLL wpn_*.cpp) ──────────────────────────
// Each gun computes its bullet-cone spread from an accuracy scalar + the firing stance.
// Two scalar models, straight from the source:
//   'bloom' (rifles/SMGs/M249): m_flAccuracy = min(max, shots^exp / div + base) — grows with
//            sustained fire; per-stance spread = add + mul·acc.
//   'decay' (pistols): m_flAccuracy -= (cool − Δt_since_last)·step, clamped [lo,hi] — recovers
//            between shots; per-stance spread = factor·(1 − acc).
//   'fixed' (AWP): per-stance constant (no scalar) — pinpoint still, wrecked by movement.
// Stances are tested air → run(>runThresh) → walk(>walkThresh) → duck → still, matching the
// PrimaryAttack branch order. Rifles only run/still (runThresh 140); pistols treat ANY motion
// as 'run' (runThresh ~0). `sil` overrides stances when the weapon is silenced.
const WEAPON_ACCURACY = {
  // Rifles
  ak47:  { model: 'bloom', exp: 3, div: 200,   base: 0.35, max: 1.25, air: { add: 0.04,  mul: 0.4  }, run: { add: 0.04,  mul: 0.07  }, still: { add: 0, mul: 0.0275 } },
  m4:    { model: 'bloom', exp: 3, div: 220,   base: 0.3,  max: 1.0,  air: { add: 0.035, mul: 0.4  }, run: { add: 0.035, mul: 0.07  }, still: { add: 0, mul: 0.025  }, sil: { still: { add: 0, mul: 0.02 } } },
  galil: { model: 'bloom', exp: 3, div: 200,   base: 0.35, max: 1.25, air: { add: 0.04,  mul: 0.3  }, run: { add: 0.04,  mul: 0.07  }, still: { add: 0, mul: 0.0375 } },
  famas: { model: 'bloom', exp: 3, div: 215,   base: 0.3,  max: 1.0,  air: { add: 0.03,  mul: 0.3  }, run: { add: 0.03,  mul: 0.07  }, still: { add: 0, mul: 0.02   } },
  aug:   { model: 'bloom', exp: 3, div: 215,   base: 0.3,  max: 1.0,  air: { add: 0.035, mul: 0.4  }, run: { add: 0.035, mul: 0.07  }, still: { add: 0, mul: 0.02   } },
  sg552: { model: 'bloom', exp: 3, div: 220,   base: 0.3,  max: 1.0,  air: { add: 0.035, mul: 0.45 }, run: { add: 0.035, mul: 0.075 }, still: { add: 0, mul: 0.02   } },
  // SMGs — on-ground spread is the same moving or still (no run branch), only air differs.
  mp5:   { model: 'bloom', exp: 2, div: 220.1, base: 0.45, max: 0.75, air: { add: 0, mul: 0.2   }, still: { add: 0, mul: 0.04  } },
  tmp:   { model: 'bloom', exp: 3, div: 200,   base: 0.55, max: 1.4,  air: { add: 0, mul: 0.25  }, still: { add: 0, mul: 0.03  } },
  mac10: { model: 'bloom', exp: 3, div: 200,   base: 0.6,  max: 1.65, air: { add: 0, mul: 0.375 }, still: { add: 0, mul: 0.03  } },
  ump45: { model: 'bloom', exp: 2, div: 210,   base: 0.5,  max: 1.0,  air: { add: 0, mul: 0.24  }, still: { add: 0, mul: 0.04  } },
  p90:   { model: 'bloom', exp: 2, div: 175,   base: 0.45, max: 1.0,  air: { add: 0, mul: 0.3   }, run: { add: 0, mul: 0.115 }, runThresh: 170, still: { add: 0, mul: 0.045 } },
  // Machine gun
  m249:  { model: 'bloom', exp: 3, div: 175,   base: 0.4,  max: 0.9,  air: { add: 0.045, mul: 0.5 }, run: { add: 0.045, mul: 0.095 }, still: { add: 0, mul: 0.03 } },
  // Sniper — fixed per-stance cone
  awp:   { model: 'fixed', air: 0.85, run: 0.25, walk: 0.1, walkThresh: 10, duck: 0.0, still: 0.001 },
  // Pistols — time-decay; any movement (runThresh ~0) uses the 'run' branch.
  usp:       { model: 'decay', cool: 0.3,   step: 0.275, lo: 0.6,   hi: 0.92, runThresh: 5, air: 1.2, run: 0.225, duck: 0.08,  still: 0.1,
               sil: { air: 1.3, run: 0.25, duck: 0.125, still: 0.15 } },
  glock18:   { model: 'decay', cool: 0.325, step: 0.275, lo: 0.6,   hi: 0.9,  runThresh: 5, air: 1.0, run: 0.165, duck: 0.075, still: 0.1  },
  deagle:    { model: 'decay', cool: 0.4,   step: 0.35,  lo: 0.55,  hi: 0.9,  runThresh: 5, air: 1.5, run: 0.25,  duck: 0.115, still: 0.13 },
  p228:      { model: 'decay', cool: 0.325, step: 0.3,   lo: 0.6,   hi: 0.9,  runThresh: 5, air: 1.5, run: 0.255, duck: 0.075, still: 0.15 },
  fiveseven: { model: 'decay', cool: 0.275, step: 0.25,  lo: 0.725, hi: 0.92, runThresh: 5, air: 1.5, run: 0.255, duck: 0.075, still: 0.15 },
};

// Canon fire-cycle times (ReGameDLL flCycleTime, pistols after their −= adjustment).
const CANON_CYCLE = {
  ak47: 0.0955, m4: 0.0875, galil: 0.0875, famas: 0.0825, aug: 0.0825, sg552: 0.0825,
  mp5: 0.075, tmp: 0.07, mac10: 0.07, ump45: 0.1, p90: 0.066, m249: 0.10,
  usp: 0.15, glock18: 0.15, deagle: 0.225, p228: 0.15, fiveseven: 0.15,
};
WPNS.forEach(w => { if (CANON_CYCLE[w.id] != null) w.fireInterval = CANON_CYCLE[w.id]; });

// Resolve a weapon's bullet-cone spread for this shot from its canon accuracy model.
// sc = consecutive shots this burst; spd2d = horizontal speed; ducking = phyDucked.
function _canonSpread(a, wpn, sc, spd2d, onGround, ducking) {
  let acc = 1;
  if (a.model === 'bloom') {
    acc = Math.min(a.max, Math.pow(sc, a.exp) / a.div + a.base);
  } else if (a.model === 'decay') {
    if (wpn._acc == null) wpn._acc = a.hi;
    // Δt since the last shot: small gap → accuracy drops (spray), long gap → recovers to hi.
    const dt = Math.min(lastShotAge, a.cool * 4);
    wpn._acc = Math.max(a.lo, Math.min(a.hi, wpn._acc - (a.cool - dt) * a.step));
    acc = wpn._acc;
  }
  let name;
  if (!onGround)                                              name = 'air';
  else if (a.run  != null && spd2d > (a.runThresh  ?? 140))  name = 'run';
  else if (a.walk != null && spd2d > (a.walkThresh ?? 10))   name = 'walk';
  else if (a.duck != null && ducking)                        name = 'duck';
  else                                                       name = 'still';
  let st = (wpn.silencer && a.sil && a.sil[name] != null) ? a.sil[name] : a[name];
  if (st == null) st = (wpn.silencer && a.sil && a.sil.still != null) ? a.sil.still : a.still;
  if (a.model === 'bloom') return st.add + st.mul * acc;
  if (a.model === 'decay') return st * (1 - acc);
  return st;                                                  // fixed
}

// ── Canon view recoil (ReGameDLL CBasePlayerWeapon::KickBack), per firing stance ──
// Each stance is [up_base, lat_base, up_mod, lat_mod, up_max, lat_max, dir_change] in DEGREES.
// Per shot (n = m_iShotsFired, 1-based): vertical kick = up_base + (n>1 ? n·up_mod : 0), pushed
// UP and clamped to up_max; lateral = lat_base + (n>1 ? n·lat_mod : 0), walked left/right (clamped
// ±lat_max) with the side flipping at probability 1/(dir_change+1). up_max/lat_max = 0 → no clamp.
// Branch order differs in the source: rifles test moving BEFORE air; SMGs/M249/P90 test air first.
const KICKBACK = {
  ak47:  { move: [1.5,0.45,0.225,0.05,6.5,2.5,7], air: [2.0,1.0,0.5,0.35,9.0,6.0,5], duck: [0.9,0.35,0.15,0.025,5.5,1.5,9], still: [1.0,0.375,0.175,0.0375,5.75,1.75,8] },
  m4:    { move: [1.0,0.45,0.28,0.045,3.75,3.0,7], air: [1.2,0.5,0.23,0.15,5.5,3.5,6], duck: [0.6,0.3,0.2,0.0125,3.25,2.0,7], still: [0.65,0.35,0.25,0.015,3.5,2.25,7] },
  galil: { move: [1.0,0.45,0.28,0.045,3.75,3.0,7], air: [1.2,0.5,0.23,0.15,5.5,3.5,6], duck: [0.6,0.3,0.2,0.0125,3.25,2.0,7], still: [0.65,0.35,0.25,0.015,3.5,2.25,7] },
  famas: { move: [1.0,0.45,0.275,0.05,4.0,2.5,7], air: [1.25,0.45,0.22,0.18,5.5,4.0,5], duck: [0.575,0.325,0.2,0.011,3.25,2.0,8], still: [0.625,0.375,0.25,0.0125,3.5,2.25,8] },
  aug:   { move: [1.0,0.45,0.275,0.05,4.0,2.5,7], air: [1.25,0.45,0.22,0.18,5.5,4.0,5], duck: [0.575,0.325,0.2,0.011,3.25,2.0,8], still: [0.625,0.375,0.25,0.0125,3.5,2.25,8] },
  sg552: { move: [1.0,0.45,0.28,0.04,4.25,2.5,7], air: [1.25,0.45,0.22,0.18,6.0,4.0,5], duck: [0.6,0.35,0.2,0.0125,3.7,2.0,10], still: [0.625,0.375,0.25,0.0125,4.0,2.25,9] },
  mp5:   { airFirst: true, air: [0.9,0.475,0.35,0.0425,5.0,3.0,6], move: [0.5,0.275,0.2,0.03,3.0,2.0,10], duck: [0.225,0.15,0.1,0.015,2.0,1.0,10], still: [0.25,0.175,0.125,0.02,2.25,1.25,10] },
  tmp:   { airFirst: true, air: [1.1,0.5,0.35,0.045,4.5,3.5,6], move: [0.8,0.4,0.2,0.03,3.0,2.5,7], duck: [0.7,0.35,0.125,0.025,2.5,2.0,10], still: [0.725,0.375,0.15,0.025,2.75,2.25,9] },
  mac10: { airFirst: true, air: [1.3,0.55,0.4,0.05,4.75,3.75,5], move: [0.9,0.45,0.25,0.035,3.5,2.75,7], duck: [0.75,0.4,0.175,0.03,2.75,2.5,10], still: [0.775,0.425,0.2,0.03,3.0,2.75,9] },
  ump45: { airFirst: true, air: [0.125,0.65,0.55,0.0475,5.5,4.0,10], move: [0.55,0.3,0.225,0.03,3.5,2.5,10], duck: [0.25,0.175,0.125,0.02,2.25,1.25,10], still: [0.275,0.2,0.15,0.0225,2.5,1.5,10] },
  p90:   { airFirst: true, air: [0.9,0.45,0.35,0.04,5.25,3.5,4], move: [0.45,0.3,0.2,0.0275,4.0,2.25,7], duck: [0.275,0.2,0.125,0.02,3.0,1.0,9], still: [0.3,0.225,0.125,0.02,3.25,1.25,8] },
  m249:  { airFirst: true, air: [1.8,0.65,0.45,0.125,5.0,3.5,8], move: [1.1,0.5,0.3,0.06,4.0,3.0,8], duck: [0.75,0.325,0.25,0.025,3.5,2.5,9], still: [0.8,0.35,0.3,0.03,3.75,3.0,9] },
  // Pistols + AWP: one flat call for every stance — pure 2° vertical, no lateral, no cap (each
  // shot kicks up and the spring recenters between shots). Glock has NO view punch (KickBack(0…)).
  usp:       { all: [2.0,0,0,0,0,0,0] },
  deagle:    { all: [2.0,0,0,0,0,0,0] },
  p228:      { all: [2.0,0,0,0,0,0,0] },
  fiveseven: { all: [2.0,0,0,0,0,0,0] },
  awp:       { all: [2.0,0,0,0,0,0,0] },
  glock18:   { all: [0,0,0,0,0,0,0] },
};
// Pick the KickBack stance row matching the firing pose (source branch order per weapon class).
function _kickbackRow(kb, spd2d, onGround, ducking) {
  if (kb.all) return kb.all;
  const moving = spd2d > 1;
  if (kb.airFirst) {
    if (!onGround) return kb.air;
    if (moving)    return kb.move;
  } else {
    if (moving)    return kb.move;
    if (!onGround) return kb.air;
  }
  if (ducking) return kb.duck;
  return kb.still;
}

let curWpnIdx  = WPNS.findIndex(w => w.id === 'knife');   // start on the knife
let nextWpnIdx = -1;

const WS = { IDLE: 0, DRAW: 1, SLASH: 2, STAB: 3, FIRE: 4, RELOAD: 5, SILENCER: 6, PULLPIN: 7, THROW: 8 };
let ws = WS.DRAW, wsT = 0, wsIdleT = 0, wsHit = false;
let meleeCooldown = 0;          // time (s) until the next knife attack is allowed
let bobCycle = 0, bobAmt = 0;  // weapon bob state

function curW() { return WPNS[curWpnIdx]; }

// ── Sniper scope (AWP) ──────────────────────────────────────────────────────
// scopeLevel 0 = unscoped; else 1-based index into curW().zoomFovs.
// RMB cycles through the levels and back to 0 (AWP: 90 → 40 → 10 → 90).
let scopeLevel = 0;
// CS 1.6: a scoped shot unscopes momentarily, then re-zooms. These track the
// pending auto re-zoom (level to restore + countdown until it fires).
let _scopeResumeLevel = 0, _scopeResumeT = 0;
function scopeFov() {
  const w = curW();
  return (scopeLevel > 0 && w.zoomFovs) ? w.zoomFovs[scopeLevel - 1] : null;
}
function isScoped() { return scopeFov() !== null; }
function cycleScope() {
  const w = curW();
  if (!w.zoomFovs || !w.zoomFovs.length) return;
  // Only zoom from a settled weapon (not mid-reload/draw), as in the original.
  if (ws !== WS.IDLE && ws !== WS.FIRE) return;
  scopeLevel = (scopeLevel + 1) % (w.zoomFovs.length + 1);
  if (typeof playSound === 'function') playSound('weapons/zoom.wav');
  if (typeof updateFOV === 'function') updateFOV();
  _updateScopeOverlay();
}
function resetScope() {
  _scopeResumeLevel = 0; _scopeResumeT = 0;   // cancel any pending auto re-zoom
  if (scopeLevel === 0) return;
  scopeLevel = 0;
  if (typeof updateFOV === 'function') updateFOV();
  _updateScopeOverlay();
}
function _updateScopeOverlay() {
  const el = document.getElementById('scope');
  if (el) el.style.display = isScoped() ? 'block' : 'none';
}

// ── Skeletal animation system (per-weapon state) ─────────────────────────
// Each weapon stores its own animation data in wpn.anim
// GoldSrc MDL bone math: euler angles → quaternion → matrix
function lerpAngle(a, b, t) {
  let d = b - a;
  if (d >  Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function boneEulerQuat(rx, ry, rz, out) {
  const sr = Math.sin(rx * 0.5), cr = Math.cos(rx * 0.5);
  const sp = Math.sin(ry * 0.5), cp = Math.cos(ry * 0.5);
  const sy = Math.sin(rz * 0.5), cy = Math.cos(rz * 0.5);
  return out.set(
    sr*cp*cy - cr*sp*sy,
    cr*sp*cy + sr*cp*sy,
    cr*cp*sy - sr*sp*cy,
    cr*cp*cy + sr*sp*sy
  );
}

function boneEulerMat(rx, ry, rz) {
  return new THREE.Matrix4().makeRotationFromQuaternion(
    boneEulerQuat(rx, ry, rz, new THREE.Quaternion())
  );
}

// ── Load weapon meshes + animation ────────────────────────────────────────
const _texLoader = new THREE.TextureLoader(_assetMgr);   // tracked for the loading screen

function _buildGroup(data, scale) {
  const root = new THREE.Group();
  const originalPositions = [], boneIndices = [];
  data.meshes.forEach(m => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(m.positions), 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(m.uvs,     2));
    geo.setIndex(m.indices);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo,
      new THREE.MeshLambertMaterial({ map: _texLoader.load(m.texFile), side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    root.add(mesh);
    originalPositions.push(new Float32Array(m.positions));
    if (m.boneIndices) boneIndices.push(m.boneIndices);
  });
  root.scale.setScalar(scale);
  return { root, originalPositions, boneIndices };
}

function _activateGroup(wpn, g) {
  wpn.root = g.root;
  wpn.originalPositions = g.originalPositions;
  wpn.boneIndices = g.boneIndices;
}

// Deferred: called once at "Start" so view-model meshes aren't fetched on page load.
let _weaponsLoaded = false;
function loadWeaponModels() {
  if (_weaponsLoaded) return;
  _weaponsLoaded = true;
  WPNS.forEach(wpn => {
    _trackFetchStart();
    fetch(wpn.jsonFile).then(r => r.json()).then(data => {
      wpn._groupUnsil = _buildGroup(data, wpn.scale);
      _activateGroup(wpn, wpn._groupUnsil);
      wpn.root.visible = (WPNS.indexOf(wpn) === curWpnIdx);
      vmScene.add(wpn.root);

      // Load animation file if available
      const animFile = wpn.jsonFile.replace('.json', '_anim.json');
      _trackFetchStart();
      fetch(animFile).then(r => r.ok ? r.json() : Promise.reject())
        .then(animData => {
          wpn.anim = { bones: animData.bones, seqs: animData.sequences, curFrame: 0 };
          // Resolve idle sequence name against what this MDL actually contains
          // (some use 'idle', others 'idle1'). A wrong name leaves idleWorld null,
          // which aborts the whole skeletal update (no animation, no muzzle/shell).
          const has = n => animData.sequences.some(s => s.name === n);
          if (wpn.idleSeq && !has(wpn.idleSeq)) {
            const found = animData.sequences.find(s => /idle/i.test(s.name));
            if (found) { console.warn(`${wpn.id}: idle '${wpn.idleSeq}' missing → using '${found.name}'`); wpn.idleSeq = found.name; }
          }
          console.log(`Anim loaded: ${wpn.id} (${animData.bones.length} bones)`);
        }).catch(() => {}).finally(_trackFetchEnd);

      // Load silenced variant if available
      if (wpn.jsonFileSil) {
        _trackFetchStart();
        fetch(wpn.jsonFileSil).then(r => r.json()).then(silData => {
          wpn._groupSil = _buildGroup(silData, wpn.scale);
          wpn._groupSil.root.visible = false;
          vmScene.add(wpn._groupSil.root);
        }).catch(() => {}).finally(_trackFetchEnd);
      }
      _trackFetchEnd();   // mesh JSON done (after its textures + nested fetches started)
    }).catch(() => { _trackFetchEnd(); console.warn(`${wpn.jsonFile} not found`); });
  });
}

function toggleSilencer() {
  const wpn = curW();
  if (!wpn._groupSil || ws !== WS.IDLE) return;
  wpn._silAdding = !wpn.silencer;
  if (wpn.anim) { wpn.anim._silAnimDone = false; wpn.anim.curFrame = 0; }
  ws = WS.SILENCER; wsT = 0;
}

function _finishSilencer(wpn) {
  const hasSil = wpn._silAdding;
  wpn.root.visible = false;
  _activateGroup(wpn, hasSil ? wpn._groupSil : wpn._groupUnsil);
  if (!wpn._idleSeqOrig) { wpn._idleSeqOrig = wpn.idleSeq; wpn._fireSeqOrig = wpn.fireSeq; wpn._reloadSeqOrig = wpn.reloadSeq; wpn._drawSeqOrig = wpn.drawSeq; }
  wpn.idleSeq   = hasSil ? wpn.idleSeqSil   : wpn._idleSeqOrig;
  wpn.fireSeq   = hasSil ? wpn.fireSeqSil   : wpn._fireSeqOrig;
  wpn.reloadSeq = hasSil ? wpn.reloadSeqSil : wpn._reloadSeqOrig;
  wpn.drawSeq   = hasSil ? wpn.drawSeqSil   : wpn._drawSeqOrig;
  wpn.root.visible = true;
  wpn.silencer = hasSil;
  if (wpn.anim) { wpn.anim.idleWorld = null; wpn.anim._prevAttackWs = undefined; }
}

function switchWeapon(idx) {
  if (idx === curWpnIdx || idx < 0 || idx >= WPNS.length) return;
  // Only switch to a weapon the player actually owns (knife always owned).
  if (typeof ownedWeapons !== 'undefined' && !ownedWeapons.has(WPNS[idx].id)) return;
  // Разрешить переключение во время перезарядки или глушителя, но отметить прерывание
  if (ws === WS.RELOAD) {
    WPNS[curWpnIdx]._reloadInterrupted = true;
  }
  if (ws === WS.SILENCER) {
    WPNS[curWpnIdx]._silencerInterrupted = true;
  }
  nextWpnIdx = idx;
  if (ws === WS.IDLE || ws === WS.DRAW || ws === WS.RELOAD || ws === WS.SILENCER) _beginDraw(nextWpnIdx);
}

// ── Spectator first-person viewmodel ────────────────────────────────────────
// When dead and spectating a player in first-person, render a REAL viewmodel (vmScene, like
// the local player's) of THAT player's weapon, animated by their weapon state (ws/wsT from the
// snapshot). All viewmodels are preloaded by loadWeaponModels, so any weapon can be shown.
// We hijack curWpnIdx + ws/wsT while spectating and restore them on exit (the local player is
// dead, so its own weapon state doesn't matter until the server respawns it).
let _specVmActive = false, _specVmSaveIdx = -1;
function _specVmEnter() {
  if (_specVmActive) return;
  _specVmActive = true;
  _specVmSaveIdx = curWpnIdx;
}
function _specVmExit() {
  if (!_specVmActive) return;
  _specVmActive = false;
  if (WPNS[curWpnIdx] && WPNS[curWpnIdx].root) WPNS[curWpnIdx].root.visible = false;
  if (_specVmSaveIdx >= 0) curWpnIdx = _specVmSaveIdx;
  if (WPNS[curWpnIdx] && WPNS[curWpnIdx].root) WPNS[curWpnIdx].root.visible = true;
  ws = WS.IDLE; wsT = 0;
}
// Per-frame: show the spectated weapon's viewmodel and pose it from the remote's ws/wsT, with
// the same bob (from their movement), recoil kick, muzzle flash and shell eject a live player
// sees. vel/og = the spectated player's velocity + on-ground (for bob).
let _specPrevWs = -1, _specPrevWsT = 0;
function _specVmUpdate(weaponId, rws, rwsT, vel, og, dt) {
  const idx = WPNS.findIndex(w => w.id === weaponId);
  if (idx < 0) return;
  if (idx !== curWpnIdx) {
    if (WPNS[curWpnIdx] && WPNS[curWpnIdx].root) WPNS[curWpnIdx].root.visible = false;
    curWpnIdx = idx;
    if (WPNS[curWpnIdx] && WPNS[curWpnIdx].root) WPNS[curWpnIdx].root.visible = true;
    _specPrevWs = -1;                            // new weapon → don't carry a stale fire edge
  }
  const wpn = curW();
  if (!wpn.root) return;
  // Drive the skeletal pose from the spectated player's weapon state machine (same enum/timing
  // the local player uses, so fire/reload/idle resolve identically).
  ws = rws || WS.IDLE; wsT = rwsT || 0;
  wsIdleT += dt;

  // Weapon bob from the spectated player's movement (mirrors updateWeapon).
  const _hspd = (vel && og) ? Math.hypot(vel[0], vel[1]) : 0;
  const _tgtBob = og ? Math.min(_hspd / SV.maxspeed, 1) : 0;
  bobAmt += (_tgtBob - bobAmt) * Math.min(dt * 8, 1);
  if (_hspd > 5) bobCycle += dt * (_hspd / SV.maxspeed) * (Math.PI * 2);
  const _bob = Math.sin(bobCycle) * bobAmt;
  const bobYaw = -_bob * 0.035, bobX = -_bob * 0.035 * 2.4, bobZ = _bob * (_bob >= 0 ? 0.11 : 0.04);

  const p = wpn.root.position, r = wpn.root.rotation;
  if (ws === WS.FIRE) {                          // recoil kick (mirrors the FIRE state)
    const DUR = wpn.fireInterval || 0.12;
    const t = Math.min(wsT / DUR, 1);
    const kick = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    p.set(wpn.pos.x + bobX, wpn.pos.y + kick * 0.03, wpn.pos.z + kick * 0.04 + bobZ);
    r.set(wpn.rot.x - kick * 0.08, wpn.rot.y + bobYaw, wpn.rot.z);
  } else {                                        // idle/reload/draw: base pose + idle sway + bob
    p.set(wpn.pos.x + bobX, wpn.pos.y + Math.sin(wsIdleT * 1.6) * 0.005, wpn.pos.z + bobZ);
    r.set(wpn.rot.x + Math.cos(wsIdleT * 0.9) * 0.007, wpn.rot.y + bobYaw, wpn.rot.z);
  }

  if (typeof applySkeletalAnimation === 'function') applySkeletalAnimation(wpn, dt);

  // Fire edge → muzzle flash + shell (first-person, in vmScene), like a live shooter. A "shot"
  // is entering FIRE or wsT resetting backward during sustained fire (≥1 per snapshot at worst).
  const isShot = (ws === WS.FIRE) && (_specPrevWs !== WS.FIRE || wsT < _specPrevWsT - 1e-4);
  if (isShot) {
    if (typeof _showFlash === 'function')  _showFlash(wpn);
    if (typeof _ejectShell === 'function') _ejectShell(wpn);
  }
  _specPrevWs = ws; _specPrevWsT = wsT;
}

function _beginDraw(idx) {
  resetScope();   // switching weapons always drops the scope
  if (WPNS[curWpnIdx].root) WPNS[curWpnIdx].root.visible = false;
  curWpnIdx  = idx;
  nextWpnIdx = -1;
  ws = WS.DRAW; wsT = 0;
  meleeCooldown = 0;
  const wpn = WPNS[curWpnIdx];
  wpn._reloadInterrupted = false;  // Очистить флаг прерывания при переключении на новое оружие
  wpn._silencerInterrupted = false;  // Очистить флаг глушителя при переключении
  wpn._bursting = false; wpn._burstLeft = 0;   // cancel any in-progress burst on draw
  wpn._fireQueued = false;                     // drop any buffered semi-auto click
  if (wpn.anim) { wpn.anim._drawAnimDone = false; wpn.anim.curFrame = 0; }
  if (wpn.root) wpn.root.visible = true;
  // Guns play their deploy sound via an MDL event; the knife has none, so emit
  // its code-driven deploy here. Warm the rest of this weapon's samples too.
  if (typeof warmWeaponSounds === 'function') warmWeaponSounds(wpn);
  if (wpn.deploySound && typeof playSound === 'function') playSound(wpn.deploySound);
}

// Begin a new shot (a fresh trigger pull). Used by every fire-start point so burst
// initialization lives in one place. ws/wsT/wsHit are shared globals. For a
// burst-mode weapon (Glock with RMB toggle) one pull queues a 3-round burst.
function _beginFire(wpn) {
  wpn.ammo--; ws = WS.FIRE; wsT = 0; wsHit = false;
  if (wpn._burstMode) { wpn._bursting = true; wpn._burstLeft = (wpn.burstCount || 3) - 1; }
  else { wpn._bursting = false; wpn._burstLeft = 0; }
}

function hitCheck(maxDist) {
  if (!gsPos || !gPlanes) return null;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const cp   = Math.cos(pitch), spv = Math.sin(pitch);
  const from = [gsPos[0], gsPos[1], gsPos[2] + eyeH];
  const fx   = -Math.sin(yaw)*cp, fy = Math.cos(yaw)*cp, fz = -spv;
  const to   = [from[0]+fx*maxDist, from[1]+fy*maxDist, from[2]+fz*maxDist];
  return traceMove(from, to);
}

// Returns trace if melee connects within dist, null if miss.
function _meleeHits(dist) {
  if (!gsPos || !gPlanes) return null;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const cp   = Math.cos(pitch), spv = Math.sin(pitch);
  const from = [gsPos[0], gsPos[1], gsPos[2] + eyeH];
  const fx   = -Math.sin(yaw)*cp, fy = Math.cos(yaw)*cp, fz = -spv;
  const to   = [from[0]+fx*dist, from[1]+fy*dist, from[2]+fz*dist];
  const tr   = traceMove(from, to);
  return tr.fraction < 1.0 ? tr : null;
}

// Start a knife attack with original CS 1.6 timing and hit/miss animation set.
//   LMB slash : hit → slash1/slash2 (0.25s),  miss → midslash1/midslash2 (0.4s)
//   RMB stab  : hit → stab (1.1s),            miss → stab_miss (1.0s)
function _startMeleeAttack(wpn, isStab) {
  const meleeResult = _meleeHits(48);
  const hit = meleeResult !== null;
  // Cut orientation (right-hand weapon): LMB = one diagonal upper-left→lower-right,
  // RMB = near-horizontal. Mirrored for a left-hand weapon. Small jitter only.
  const handSign = rightHand ? 1 : -1;
  let seqName, cd, cutRoll;
  if (isStab) {
    seqName = hit ? 'stab' : 'stab_miss';
    cd = hit ? 1.1 : 1.0;
    ws = WS.STAB;
    cutRoll = handSign * -0.12 + (Math.random() - 0.5) * 0.1;   // RMB → near-horizontal
  } else {
    // LMB always plays the full swing (midslash1/midslash2 alternating); the
    // slash1/slash2 sequences are 2-frame impact stubs, not real swings, so a
    // hit must not shorten the visible animation. Hit only affects the cooldown.
    const i = wpn.anim ? (wpn.anim._slashIdx = ((wpn.anim._slashIdx ?? -1) + 1) % 2) : 0;
    seqName = i ? 'midslash2' : 'midslash1';
    cd = hit ? 0.35 : 0.4;
    ws = WS.SLASH;
    cutRoll = handSign * -0.35 + (Math.random() - 0.5) * 0.12;  // LMB → shallow diagonal upper-left→lower-right
  }
  if (hit) _spawnDecal('knife', 64, 0, cutRoll);
  let bodyHit = false;
  if (typeof enemyTryShoot === 'function') bodyHit = enemyTryShoot(48, {   // knife the dummy if in range
    melee: true,
    damage: isStab ? (wpn.stabDamage ?? 65) : (wpn.slashDamage ?? 25),
    backstabMult: wpn.backstabMult ?? 3,
  });
  // Original knife sounds (code-driven, no MDL events): swing swoosh on every
  // attack (LMB slash and RMB stab both swing the blade), then the impact sample
  // — flesh hit, wall hit, or the stab thunk. CHAN_WEAPON so fast swings don't
  // pile up; a moment later the impact replaces the swoosh, as in the engine.
  if (typeof playSound === 'function') {
    playRandom(wpn.slashSound, { channel: 'weapon' });               // swing whoosh (LMB + RMB)
    if (bodyHit) {
      if (isStab) playSound(wpn.stabSound, { channel: 'weapon' });   // meaty stab thunk
      else        playRandom(wpn.hitFleshSound, { channel: 'weapon' });
    } else if (hit) {
      playSound(wpn.hitWallSound, { channel: 'weapon' });            // blade on world geometry
    }
  }
  wsT = 0; wsHit = false;
  meleeCooldown = cd;
  if (wpn.anim) {
    wpn.anim._attackSeq = seqName;
    wpn.anim._prevAttackWs = undefined;   // force frame reset in applySkeletalAnimation
    wpn.anim._attackAnimDone = false;
  }
}

function updateWeapon(dt) {
  const wpn = curW();
  if (!wpn.root) return;
  // Scope drops on reload/draw (the gun comes up off the eye), stays through fire.
  if (scopeLevel > 0 && (ws === WS.RELOAD || ws === WS.DRAW)) resetScope();
  // Pending auto re-zoom after a scoped shot: restore the scope once the beat
  // passes — unless we've since started a reload/draw (those keep it unscoped).
  if (_scopeResumeT > 0) {
    _scopeResumeT -= dt;
    if (_scopeResumeT <= 0) {
      if (_scopeResumeLevel > 0 && wpn.zoomFovs && ws !== WS.RELOAD && ws !== WS.DRAW) {
        scopeLevel = _scopeResumeLevel;
        if (typeof updateFOV === 'function') updateFOV();
        _updateScopeOverlay();
      }
      _scopeResumeLevel = 0;
    }
  }
  wsT += dt; wsIdleT += dt;
  if (meleeCooldown > 0) meleeCooldown -= dt;
  const p = wpn.root.position, r = wpn.root.rotation;
  const eo = t => 1 - (1-t)*(1-t);

  // Weapon bob (GoldSrc style: 0.8s cycle at max speed)
  const _hspd = (vel && onGround) ? Math.hypot(vel[0], vel[1]) : 0;
  const _tgtBob = onGround ? Math.min(_hspd / SV.maxspeed, 1) : 0;
  bobAmt += (_tgtBob - bobAmt) * Math.min(dt * 8, 1);
  if (_hspd > 5) bobCycle += dt * (_hspd / SV.maxspeed) * (Math.PI * 2 / 1.0);
  const _bob = Math.sin(bobCycle) * bobAmt;
  const bobYaw = -_bob * 0.035;                        // вращение вокруг ствола
  const bobX   = -_bob * 0.035 * 2.4;                 // компенсация — ствол к центру
  const bobZ   =  _bob * (_bob >= 0 ? 0.11 : 0.04);   // назад много, вперёд мало

  // Crosshair dynamics (CS-style): expands fast on shots/movement, contracts slowly.
  const _spd2d = vel ? Math.hypot(vel[0], vel[1]) : 0;
  let _moveGap = 0;
  if (!onGround)        _moveGap = 26;                       // airborne — wide open
  else {
    _moveGap = Math.max(0, _spd2d - 40) / 250 * 16;          // running opens it
    if (phyDucked) _moveGap *= 0.4;                          // crouch tightens
  }
  xhairGap *= Math.exp(-dt * 3.0);                           // firing expansion: slow contraction
  if (xhairGap > 60) xhairGap = 60;
  xhairMoveGap = _moveGap;                                   // movement expansion tracks speed/air

  if (nextWpnIdx >= 0 && ws === WS.IDLE) { _beginDraw(nextWpnIdx); return; }

  switch (ws) {
    case WS.DRAW: {
      if (wsT <= dt * 1.5 && wpn.anim) restoreWeaponVertices(wpn);
      p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
      r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
      if (wpn.anim?._drawAnimDone || wsT >= 2.0) {
        ws = WS.IDLE; wsT = 0;
        // Если новое оружие имеет 0 патронов и есть резерв - начать перезарядку
        if (wpn.type === 'gun' && wpn.ammo === 0 && wpn.reserve > 0) {
          ws = WS.RELOAD; wsT = 0;
        } else if (lmbHeld && wpn.type === 'gun' && wpn.ammo > 0) {
          // Если LMB зажата во время draw и есть патроны - начать стрельбу
          _beginFire(wpn);
        } else if (lmbHeld && wpn.type === 'grenade') {
          // LMB held through the deploy (the mousedown fired before idle, so PULLPIN
          // was never latched) — pull the pin now so the release still throws.
          ws = WS.PULLPIN; wsT = 0; wsHit = false;
          if (wpn.anim) { wpn.anim._prevAnimWs = undefined; wpn.anim.curFrame = 0; }
        }
      }
      break;
    }
    case WS.IDLE: {
      p.set(wpn.pos.x + bobX, wpn.pos.y + Math.sin(wsIdleT*1.6)*0.005, wpn.pos.z + bobZ);
      r.set(wpn.rot.x + Math.cos(wsIdleT*0.9)*0.007, wpn.rot.y + bobYaw, wpn.rot.z);
      break;
    }
    case WS.PULLPIN: {
      // Hold while LMB is down (pin pulled, pose held at the last pullpin frame).
      // Release → WS.THROW (set in the mouseup handler). The pin sound fires from
      // the MDL event in the 'pullpin' sequence.
      p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
      r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
      break;
    }
    case WS.THROW: {
      p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
      r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
      // Release the projectile partway through the throw animation.
      if (!wsHit && wsT >= (wpn.throwReleaseT || 0.3)) {
        wsHit = true;
        if (typeof throwGrenade === 'function') throwGrenade(wpn);
      }
      // Only consume/redeploy AFTER the nade has actually left the hand (wsHit). The
      // state switch runs before applySkeletalAnimation resets _grenAnimDone, so on a
      // repeated throw that flag is still true from the previous throw — without the
      // wsHit guard it would consume the grenade on frame 0 and spawn no projectile.
      if (wsHit && (wpn.anim?._grenAnimDone || wsT >= 1.0)) {
        // Out of this type → switch to the best remaining weapon; else redeploy.
        if (typeof afterGrenadeThrow === 'function') afterGrenadeThrow(wpn);
        else { ws = WS.IDLE; wsT = 0; }
      }
      break;
    }
    case WS.SLASH: {
      if (wpn.anim) {
        // Knife has a full skeletal swing+return animation that itself starts
        // and ends in the idle pose — let it drive everything (original look),
        // and only return to IDLE once it has finished its smooth recovery.
        p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
        r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
        if (wsT >= 0.12 && !wsHit) { wsHit = true; hitCheck(32); }
        if (wpn.anim._attackAnimDone || wsT >= 1.4) { ws = WS.IDLE; wsT = 0; wsHit = false; }
        break;
      }
      const PRE = 0.14, POST = 0.34;
      if (wsT < PRE) {
        const t = eo(wsT / PRE);
        p.set(wpn.pos.x + t*0.22, wpn.pos.y - t*0.10, wpn.pos.z);
        r.set(wpn.rot.x - t*0.32, wpn.rot.y + t*0.28, wpn.rot.z + t*0.40);
      } else {
        const t = Math.min((wsT - PRE) / POST, 1);
        p.set(wpn.pos.x + (1-t)*0.22 - t*0.20, wpn.pos.y - (1-t)*0.10, wpn.pos.z);
        r.set(wpn.rot.x - (1-t)*0.32, wpn.rot.y + (1-t)*0.28 - t*0.55, wpn.rot.z + (1-t)*0.40 - t*0.16);
        if (t >= 0.25 && !wsHit) { wsHit = true; hitCheck(32); }
        if (t >= 1) { ws = WS.IDLE; wsT = 0; wsHit = false; }
      }
      break;
    }
    case WS.STAB: {
      if (wpn.anim) {
        p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
        r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
        if (wsT >= 0.22 && !wsHit) { wsHit = true; hitCheck(32); }
        if (wpn.anim._attackAnimDone || wsT >= 1.6) { ws = WS.IDLE; wsT = 0; wsHit = false; }
        break;
      }
      const PRE = 0.10, POST = 0.44;
      if (wsT < PRE) {
        const t = wsT / PRE;
        p.set(wpn.pos.x, wpn.pos.y - t*0.07, wpn.pos.z + t*0.11);
        r.set(wpn.rot.x + t*0.22, wpn.rot.y, wpn.rot.z);
      } else {
        const t = Math.min((wsT - PRE) / POST, 1);
        const fwd = t < 0.35 ? eo(t/0.35) : 1 - eo((t-0.35)/0.65);
        p.set(wpn.pos.x, wpn.pos.y - (1-t)*0.07, wpn.pos.z + (1-t)*0.11 - fwd*0.26);
        r.set(wpn.rot.x + (1-t)*0.22, wpn.rot.y, wpn.rot.z);
        if (fwd >= 0.80 && !wsHit) { wsHit = true; hitCheck(32); }
        if (t >= 1) { ws = WS.IDLE; wsT = 0; wsHit = false; }
      }
      break;
    }
    case WS.FIRE: {
      // Burst mode (Glock): rounds 1-2 use a short interval; the last round holds for
      // the burst cooldown so you can't re-trigger until the whole burst + pause ends.
      let DUR = wpn.fireInterval || 0.12;
      if (wpn._bursting) DUR = wpn._burstLeft > 0 ? (wpn.burstInterval || 0.1) : (wpn.burstCooldown || 0.3);
      const t   = Math.min(wsT / DUR, 1);
      const kick = t < 0.3 ? t/0.3 : 1 - (t-0.3)/0.7;
      p.set(wpn.pos.x + bobX, wpn.pos.y + kick*0.03, wpn.pos.z + kick*0.04 + bobZ);
      r.set(wpn.rot.x - kick*0.08, wpn.rot.y + bobYaw, wpn.rot.z);
      if (!wsHit) {
        wsHit = true;
        // New burst (recoil has recovered) → restart the spray pattern.
        // Works for semi-auto spam too: rapid taps keep advancing the index.
        if (lastShotAge > 0.3) {
          wpn._shotCount  = 0;
          wpn._recoilDir  = Math.random() < 0.5 ? 1 : -1;  // bar may start either side
          wpn._kickDir    = Math.random() < 0.5 ? 1 : 0;   // canon KickBack m_iDirection
        }
        const sc = wpn._shotCount || 0;
        // Bullet scatter cone (does NOT move the screen — that's recoil). Per-weapon canon
        // accuracy; the rolled cone deflects BOTH the wall decal and the target hit ray.
        const spd2d = vel ? Math.hypot(vel[0], vel[1]) : 0;
        let shotSpread;
        const acc = WEAPON_ACCURACY[wpn.id];
        if (acc) {
          // Canon ReGameDLL accuracy: scalar (bloom/decay/fixed) × firing stance. This
          // already encodes the movement penalty, so the legacy move term is skipped.
          shotSpread = _canonSpread(acc, wpn, sc, spd2d, onGround, phyDucked);
        } else {
          // Legacy fallback (weapons not yet converted): static cone + ad-hoc move spread.
          shotSpread = wpn.spread || 0;
          if (wpn.spreadGrow) shotSpread = Math.min(shotSpread + sc * wpn.spreadGrow, wpn.spreadMax ?? shotSpread);
          const moveMult = wpn.moveSpreadMult || 1;
          if (!onGround) shotSpread += 0.05 * moveMult;
          else { let m = (Math.max(0, spd2d - 40) / 250) * 0.035; if (phyDucked) m *= 0.4; shotSpread += m * moveMult; }
        }
        // Roll this shot's scatter once (uniform disc of radius shotSpread) and fire the
        // same deflected trajectory at the wall and the dummy.
        let dyaw = 0, dpitch = 0;
        if (shotSpread) {
          const ang = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * shotSpread;
          dyaw = Math.cos(ang) * rad; dpitch = Math.sin(ang) * rad;
        }
        xhairGap += wpn.xhairKick ?? 5;             // each shot kicks the crosshair open
        // Original gunfire sound (code-driven, like the engine's WeaponSound).
        // Silenced weapons use their own sample; the engine randomises -1/-2 lists.
        const _fireSnd = (wpn.silencer && wpn.fireSoundSil) ? wpn.fireSoundSil : wpn.fireSound;
        // CHAN_WEAPON: each shot cuts the previous one so bursts/fast taps stay
        // crisp instead of overlapping into a drone (matches the engine).
        if (typeof playRandom === 'function') playRandom(_fireSnd, { volume: 1.0, channel: 'weapon' });
        if (wpn.projectile) {
          // HL projectile weapons (RPG/crossbow): launch a travelling rocket/bolt down the
          // aim ray instead of an instant hitscan. No decal/flash/shell here — the rocket
          // explodes (radius dmg) / the bolt sticks on impact (projectiles.js).
          if (typeof _fireProjectile === 'function') _fireProjectile(wpn, dyaw, dpitch);
        } else {
        const _hit = _spawnDecal('bullet', SHOT_RANGE, shotSpread, undefined, [dyaw, dpitch]);
        let _hitBody = false;
        if (typeof enemyTryShoot === 'function')                        // hit the target dummy?
          _hitBody = enemyTryShoot(SHOT_RANGE, {
            damage:   (wpn.silencer && wpn.damageSil   != null) ? wpn.damageSil   : (wpn.damage ?? 30),
            rangeMod: (wpn.silencer && wpn.rangeModSil != null) ? wpn.rangeModSil : (wpn.rangeMod ?? 0.98),
            wid: wpn.id, sil: wpn.silencer,    // for server-side bullet hitreg (netSendShot)
            dyaw, dpitch,
          });
        // Surface impact (ric sound + dust puff) — only when no body was hit (the body
        // plays its own flesh/kevlar/headshot sound, in enemy.js). The wall decal
        // still appears behind a dummy (bodies are excluded from the decal ray).
        if (!_hitBody && _hit) {
          if (typeof playBulletImpact === 'function') playBulletImpact(_hit.mat, _hit.dist);
          if (typeof _spawnImpactPuff === 'function') _spawnImpactPuff(_hit.point, _hit.normal);
        }
        // Enhanced gore: stain the wall behind a hit body with a blood splat.
        if (_hitBody && typeof enhancedGore !== 'undefined' && enhancedGore) _spawnDecal('blood', SHOT_RANGE, 0);
        }
        lastShotAge = 0;           // keep recoil in slow-decay (accumulate) mode through the burst
        if (!wpn.projectile) wpn._pendingFire = true;   // defer flash+eject until _muzzleLocal is current
        wpn._shotCount = sc + 1;
        const kb = KICKBACK[wpn.id];
        if (kb) {
          // Canon KickBack: recoilPitch (+ = up) accumulates the vertical kick; recoilYaw
          // walks left/right and randomly flips. The physics spring (physics.js) recenters
          // it. punchangle is in degrees in the source → ×D into our radians.
          const row = _kickbackRow(kb, spd2d, onGround, phyDucked);
          const shots = sc + 1;                                  // = m_iShotsFired (1-based)
          let upDeg = row[0], latDeg = row[1];
          if (shots > 1) { upDeg += shots * row[2]; latDeg += shots * row[3]; }
          const upMax = row[4] * D, latMax = row[5] * D, dirChg = row[6];
          if (upMax === 0)               recoilPitch += upDeg * D;                         // boundaryless
          else if (recoilPitch < upMax)  recoilPitch = Math.min(recoilPitch + upDeg * D, upMax);
          const dir = wpn._kickDir ? 1 : -1;
          if (latMax === 0)                       recoilYaw += latDeg * D * dir;
          else if (Math.abs(recoilYaw) < latMax)  recoilYaw = dir > 0 ? Math.min(recoilYaw + latDeg * D, latMax)
                                                                      : Math.max(recoilYaw - latDeg * D, -latMax);
          if (dirChg > 0 && Math.floor(Math.random() * (dirChg + 1)) === 0) wpn._kickDir = wpn._kickDir ? 0 : 1;
        } else {
          recoilPitch = Math.min(0.35, recoilPitch + (wpn.recoilKick || 0));   // legacy fallback
        }
        // CS 1.6 sniper: firing while scoped drops the scope (you see the weapon
        // recoil + bolt), then it auto re-zooms to the same level after a beat.
        if (scopeLevel > 0 && wpn.zoomFovs) {
          _scopeResumeLevel = scopeLevel;
          _scopeResumeT     = wpn.scopeResumeDelay || 0.4;
          scopeLevel = 0;
          if (typeof updateFOV === 'function') updateFOV();
          _updateScopeOverlay();
        }
      }
      if (t >= 1) {
        if (wpn._bursting && wpn._burstLeft > 0 && wpn.ammo > 0) {
          // Continue the burst — fires the next round regardless of the LMB state
          // (one trigger pull = the full 3-round burst, as in CS).
          wpn.ammo--; wpn._burstLeft--; wsT = 0; wsHit = false;
        } else if (lmbHeld && wpn.autofire && wpn.ammo > 0) {
          wpn.ammo--; wsT = 0; wsHit = false;
        } else if (wpn._fireQueued && !wpn.autofire && wpn.ammo > 0) {
          // A click arrived during the cooldown (semi-auto buffer) — fire it now.
          wpn._fireQueued = false;
          _beginFire(wpn);
        } else {
          wsHit = false;
          wpn._fireQueued = false;
          wpn._bursting = false; wpn._burstLeft = 0;
          // Don't reset _shotCount here — the spray index is reset on the next
          // shot only if enough time passed (see lastShotAge check above), so
          // fast semi-auto taps continue advancing the pattern.
          if (wpn.ammo === 0 && wpn.reserve > 0) { ws = WS.RELOAD; wsT = 0; }
          else { ws = WS.IDLE; wsT = 0; }
        }
      }
      break;
    }
    case WS.RELOAD: {
      p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
      r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
      if (wsT >= wpn.reloadTime) {
        // Не завершать перезарядку если она была прервана переключением оружия
        if (!wpn._reloadInterrupted) {
          const take = Math.min(wpn.maxAmmo - wpn.ammo, wpn.reserve);
          wpn.ammo += take; wpn.reserve -= take;
        }
        wpn._reloadInterrupted = false;  // Очистить флаг для следующей перезарядки
        // Если LMB зажата во время перезарядки и есть патроны - начать стрельбу
        if (lmbHeld && wpn.ammo > 0) {
          _beginFire(wpn);
        } else {
          ws = WS.IDLE; wsT = 0;
        }
      }
      break;
    }
    case WS.SILENCER: {
      p.set(wpn.pos.x, wpn.pos.y, wpn.pos.z);
      r.set(wpn.rot.x, wpn.rot.y, wpn.rot.z);
      if (wpn.anim?._silAnimDone || wsT >= 4.0) {
        // Не применять изменение глушителя если анимация была прервана переключением оружия
        if (!wpn._silencerInterrupted) {
          _finishSilencer(wpn);
        }
        wpn._silencerInterrupted = false;  // Очистить флаг для следующего переключения
        // Если LMB зажата после смены глушителя и есть патроны - начать стрельбу
        if (lmbHeld && wpn.ammo > 0) {
          _beginFire(wpn);
        } else {
          ws = WS.IDLE; wsT = 0;
        }
      }
      break;
    }
  }

  // Knife auto-repeat: while a mouse button is held, swing at the original
  // CS fire rate (gated by meleeCooldown), interrupting the previous swing.
  if (wpn.type === 'melee' && meleeCooldown <= 0 &&
      (ws === WS.IDLE || ws === WS.SLASH || ws === WS.STAB)) {
    if      (lmbHeld) _startMeleeAttack(wpn, false);
    else if (rmbHeld) _startMeleeAttack(wpn, true);
  }

  // Skeletal animation
  const _gunAnimActive = wpn.type === 'gun' && wpn.anim?._gunAnimPlaying;
  if (wpn.anim && (ws === WS.IDLE || ws === WS.SLASH || ws === WS.STAB || ws === WS.FIRE || ws === WS.RELOAD || ws === WS.DRAW || ws === WS.SILENCER || ws === WS.PULLPIN || ws === WS.THROW || _gunAnimActive)) {
    applySkeletalAnimation(wpn, dt);
  }

  // Fire effects deferred until after animation so _muzzleLocal/_ejectionLocal are current.
  // First person: flash + shell in view-model space (relative to the camera).
  // Third person: eject a shell from the world model's gun (flash is view-model-only).
  if (wpn._pendingFire) {
    wpn._pendingFire = false;
    if (thirdPerson) {
      _muzzleFlashThirdPerson(wpn);
      _ejectShellThirdPerson(wpn);
    } else {
      _showFlash(wpn);
      _ejectShell(wpn);
    }
  }
}

// ── Restore weapon vertices to original idle pose ─────────────────────────
function restoreWeaponVertices(wpn) {
  if (!wpn.originalPositions) return;
  if (wpn.anim) wpn.anim._prevAttackWs = undefined; // reset so next attack starts at frame 0
  wpn.root.children.forEach((mesh, meshIdx) => {
    const origPos = wpn.originalPositions[meshIdx];
    if (!origPos) return;
    const posAttr = mesh.geometry.getAttribute('position');
    const posArr = posAttr.array;
    for (let i = 0; i < origPos.length; i++) {
      posArr[i] = origPos[i];
    }
    posAttr.needsUpdate = true;
  });
}

// ── Skeletal animation (full matrix skinning) ────────────────────────────
// Vertices are baked in world-space at idle frame 0.
// Skinning: v_new = M_cur × M_idle⁻¹ × v_orig  (in GoldSrc space, then axis-swap).

// Effective frame count for non-looping sequences: drops trailing duplicate
// frames so animations don't hold a dead pose before transitioning out.
function _seqActiveLen(seq) {
  if (seq._activeLen !== undefined) return seq._activeLen;
  const F = seq.frames;
  let n = F.length;
  const frameEq = (a, b) =>
    a.length === b.length &&
    a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) < 1e-4));
  while (n > 1 && frameEq(F[n - 1], F[n - 2])) n--;
  seq._activeLen = n;
  return n;
}

function computeBoneWorlds(bones, poseA, poseB, t) {
  const R = [], T = [];
  const n = poseA.length;
  for (let i = 0; i < n; i++) {
    const a = poseA[i];
    let tx, ty, tz;
    let q;
    if (poseB && t > 0) {
      const b = poseB[i];
      tx = a[0] + (b[0] - a[0]) * t;
      ty = a[1] + (b[1] - a[1]) * t;
      tz = a[2] + (b[2] - a[2]) * t;
      // Slerp quaternions (correctly handles ±π euler representation flips,
      // unlike independent per-axis angle lerp which causes "stuck record" glitches)
      boneEulerQuat(a[3], a[4], a[5], _qBoneA);
      boneEulerQuat(b[3], b[4], b[5], _qBoneB);
      q = _qBoneR.copy(_qBoneA).slerp(_qBoneB, t);
    } else {
      tx = a[0]; ty = a[1]; tz = a[2];
      q = boneEulerQuat(a[3], a[4], a[5], _qBoneA);
    }
    const mat   = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const trans = new THREE.Vector3(tx, ty, tz);
    const par = bones[i].parent;
    if (par >= 0 && R[par]) {
      mat.premultiply(R[par]);
      trans.applyMatrix4(R[par]).add(T[par]);
    }
    R.push(mat);
    T.push(trans);
  }
  return { R, T };
}

const _skinVtmp = new THREE.Vector3();
const _qBoneA = new THREE.Quaternion();
const _qBoneB = new THREE.Quaternion();
const _qBoneR = new THREE.Quaternion();

function applySkeletalAnimation(wpn, dt) {
  if (!wpn.anim?.bones || !wpn.anim?.seqs || !wpn.originalPositions) return;
  if (!wpn.boneIndices?.length) return;

  // Determine sequence and handle frame reset per weapon type
  // A gun whose shoot animation outlasts its cycletime keeps animating through
  // the full sequence after the FIRE state already returned to IDLE: the deagle's
  // slide-recovery is 0.6s but its cycletime is 0.225s, so cutting to idle at
  // 0.225s chopped the animation and snapped to the idle pose (looked torn). Let
  // it finish here; the next shot restarts it from frame 0 as before.
  let seqName;
  const _gunFinishing = wpn.type === 'gun' && wpn.anim._gunAnimPlaying;
  if (ws === WS.IDLE && !_gunFinishing) {
    seqName = wpn.idleSeq || 'idle';
    if (wpn.anim._prevAnimWs !== WS.IDLE) {
      wpn.anim.curFrame = 0;
      wpn.anim._prevAttackWs = undefined;
    }
  } else if (wpn.type === 'gun') {
    if (ws === WS.SILENCER) {
      seqName = wpn._silAdding ? 'add_silencer' : 'detach_silencer';
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else if (ws === WS.DRAW) {
      seqName = wpn.drawSeq || (wpn.silencer ? 'draw' : 'draw_unsil');
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else if (ws === WS.RELOAD) {
      seqName = wpn.reloadSeq || (wpn.silencer ? 'reload' : 'reload_unsil');
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else {
      if (ws === WS.FIRE && wsT < dt * 2) {
        const seqs = wpn.silencer
          ? (wpn.fireSeqsSil   || [wpn.fireSeqSil || 'shoot1'])
          : (wpn.fireSeqsUnsil || [wpn.fireSeq    || 'shoot1_unsil']);
        const lastSeq = wpn.silencer ? wpn.fireSeqLastSil : wpn.fireSeqLastUnsil;
        if (wpn.ammo === 0 && lastSeq) {
          wpn.anim._lastFireSeq = lastSeq;
        } else {
          wpn.anim._shootIdx = ((wpn.anim._shootIdx ?? -1) + 1) % seqs.length;
          wpn.anim._lastFireSeq = seqs[wpn.anim._shootIdx];
        }
        wpn.anim.curFrame = 0;
        wpn.anim._gunAnimPlaying = true;
      }
      seqName = wpn.anim._lastFireSeq || wpn.fireSeq || 'shoot1_unsil';
    }
  } else if (wpn.type === 'grenade') {
    if (ws === WS.DRAW) {
      seqName = wpn.drawSeq || 'deploy';
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else if (ws === WS.PULLPIN) {
      seqName = wpn.pullpinSeq || 'pullpin';
      if (wpn.anim._prevAnimWs !== WS.PULLPIN) wpn.anim.curFrame = 0;
    } else if (ws === WS.THROW) {
      seqName = wpn.throwSeq || 'throw';
      if (wpn.anim._prevAnimWs !== WS.THROW) { wpn.anim.curFrame = 0; wpn.anim._grenAnimDone = false; }
    }
  } else {
    if (ws === WS.DRAW) {
      seqName = wpn.drawSeq || 'draw';
      if (wsT < dt * 2) wpn.anim.curFrame = 0;
    } else if (ws !== WS.IDLE) {
      // Hit/miss sequence chosen at attack start by _startMeleeAttack.
      seqName = wpn.anim._attackSeq || (ws === WS.STAB ? 'stab' : 'midslash1');
      if (wpn.anim._prevAttackWs !== ws || wpn.anim._attackSeqPlaying !== seqName) {
        wpn.anim._prevAttackWs = ws;
        wpn.anim._attackSeqPlaying = seqName;
        wpn.anim.curFrame = 0;
        wpn.anim._attackAnimDone = false;
      }
    }
  }

  const seq = wpn.anim.seqs.find(s => s.name === seqName);
  if (!seq?.frames.length) return;

  wpn.anim._prevAnimWs = ws;
  const fps = seq.fps > 0 ? seq.fps : 30;
  // For non-looping sequences, ignore trailing duplicate frames so the weapon
  // doesn't freeze on a dead "held" pose for a fraction of a second at the end.
  const endLen = (ws === WS.IDLE) ? seq.frames.length : _seqActiveLen(seq);
  // Fire MDL sound events (event 5004): reload/deploy/silencer samples play at
  // their original frame as the animation crosses it. A fresh sequence resets the
  // crossing baseline to -1 so a frame-0 event still triggers.
  const _evPrevIF = (seqName === wpn.anim._evSeqName) ? Math.floor(wpn.anim.curFrame) : -1;
  wpn.anim._evSeqName = seqName;
  wpn.anim.curFrame += dt * fps;
  if (typeof _tickAnimEvents === 'function')
    _tickAnimEvents(wpn, seq, _evPrevIF, Math.floor(wpn.anim.curFrame));
  if (wpn.anim.curFrame >= endLen) {
    if (ws === WS.IDLE) { wpn.anim.curFrame %= seq.frames.length; }  // loop
    else wpn.anim.curFrame = endLen - 1;
    if (ws === WS.SILENCER) {
      wpn.anim._silAnimDone = true;
    } else if (ws === WS.DRAW) {
      wpn.anim._drawAnimDone = true;
    } else if (ws === WS.SLASH || ws === WS.STAB) {
      wpn.anim._attackAnimDone = true;
    } else if (ws === WS.THROW) {
      wpn.anim._grenAnimDone = true;   // PULLPIN just holds the last frame (handled above)
    } else if (wpn.type === 'gun') {
      if (ws !== WS.RELOAD) {
        wpn.anim._gunAnimPlaying = false;
        wpn.anim.curFrame = 0;   // so the following idle loop starts at frame 0
        return;  // signal done; restoreWeaponVertices runs next frame
      }
      // RELOAD: hold at last frame until state machine transitions
    }
  }

  const numFrames = seq.frames.length;
  const frameIdx  = Math.floor(wpn.anim.curFrame) % numFrames;
  const frac      = wpn.anim.curFrame - Math.floor(wpn.anim.curFrame);
  const poseA     = seq.frames[frameIdx];
  if (!poseA) return;
  const loops  = ws === WS.IDLE;
  const nextIdx = loops
    ? (frameIdx + 1) % numFrames
    : Math.min(frameIdx + 1, numFrames - 1);
  // Don't interpolate across loop boundary (frame[N-1]→frame[0]) — bad blend if they differ
  const poseB = (frac > 0.0001 && nextIdx > frameIdx) ? seq.frames[nextIdx] : null;

  // Build idle bind-pose world transforms once and cache them
  if (!wpn.anim.idleWorld) {
    const idleSeqName = wpn.idleSeq || 'idle';
    const idleSeq = wpn.anim.seqs.find(s => s.name === idleSeqName);
    wpn.anim.idleWorld = (idleSeq?.frames.length)
      ? computeBoneWorlds(wpn.anim.bones, idleSeq.frames[0], null, 0)
      : null;
  }
  if (!wpn.anim.idleWorld) return;

  const idle = wpn.anim.idleWorld;
  const cur  = computeBoneWorlds(wpn.anim.bones, poseA, poseB, frac);

  // Build per-bone skinning matrices in GoldSrc space.
  // Skinning: v_new_gs = R_cur × R_idle⁻¹ × (v_gs − t_idle) + t_cur
  //         = M_skin × v_gs + (t_cur − M_skin × t_idle)
  const skinM = [], skinT = [];
  for (let b = 0; b < wpn.anim.bones.length; b++) {
    const M = cur.R[b].clone().multiply(idle.R[b].clone().transpose());
    const t = idle.T[b].clone().applyMatrix4(M);
    t.subVectors(cur.T[b], t);
    skinM.push(M);
    skinT.push(t);
  }

  // Apply full rotation + translation skinning to every vertex
  wpn.root.children.forEach((mesh, meshIdx) => {
    const origPos   = wpn.originalPositions[meshIdx];
    const boneIdxArr = wpn.boneIndices[meshIdx];
    if (!origPos || !boneIdxArr) return;

    const posAttr = mesh.geometry.getAttribute('position');
    const posArr  = posAttr.array;

    for (let i = 0; i < origPos.length; i += 3) {
      const b = boneIdxArr[i / 3];
      if (b === undefined || !skinM[b]) {
        posArr[i] = origPos[i]; posArr[i+1] = origPos[i+1]; posArr[i+2] = origPos[i+2];
        continue;
      }
      // Three.js → GoldSrc: (x, y, z)_three = (x, z, −y)_gs  →  gs = (x, −z, y)
      _skinVtmp.set(origPos[i], -origPos[i+2], origPos[i+1]);
      _skinVtmp.applyMatrix4(skinM[b]).add(skinT[b]);
      // GoldSrc → Three.js: (x, z, −y)
      posArr[i]   =  _skinVtmp.x;
      posArr[i+1] =  _skinVtmp.z;
      posArr[i+2] = -_skinVtmp.y;
    }
    posAttr.needsUpdate = true;
  });

  // Cache muzzle and ejection port positions in vmScene-local space.
  // Both come from the MDL attachments (0 = muzzle, 1 = shell port) — no guessing.
  // If a gun has no muzzle/ejection bone configured, the effect is simply skipped
  // (warn once) rather than placed at an invented spot.
  if (wpn.muzzleBone !== undefined && cur.T[wpn.muzzleBone]) {
    const org = (wpn.silencer && wpn.muzzleOrgSil) ? wpn.muzzleOrgSil : wpn.muzzleOrg;
    _muzzleGsTmp.set(org[0], org[1], org[2]).applyMatrix4(cur.R[wpn.muzzleBone]);
    _muzzleGsTmp.add(cur.T[wpn.muzzleBone]);
    if (!wpn._muzzleLocal) wpn._muzzleLocal = new THREE.Vector3();
    wpn._muzzleLocal.set(_muzzleGsTmp.x, _muzzleGsTmp.z, -_muzzleGsTmp.y);
  } else if (wpn.type === 'gun' && !wpn._warnedMuzzle) {
    wpn._warnedMuzzle = true;
    console.warn(`${wpn.id}: no muzzle bone (MDL attachment 0) — muzzle flash disabled`);
  }
  if (wpn.ejectionBone !== undefined && cur.T[wpn.ejectionBone]) {
    const org = wpn.ejectionOrg;
    _muzzleGsTmp.set(org[0], org[1], org[2]).applyMatrix4(cur.R[wpn.ejectionBone]);
    _muzzleGsTmp.add(cur.T[wpn.ejectionBone]);
    if (!wpn._ejectionLocal) wpn._ejectionLocal = new THREE.Vector3();
    wpn._ejectionLocal.set(_muzzleGsTmp.x, _muzzleGsTmp.z, -_muzzleGsTmp.y);
  } else if (wpn.type === 'gun' && wpn.shellType && !wpn._warnedEject) {
    wpn._warnedEject = true;
    console.warn(`${wpn.id}: no ejection bone (MDL attachment 1) — shell ejection disabled`);
  }
}

