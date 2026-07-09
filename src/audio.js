// audio.js — original CS 1.6 sound playback (WebAudio).
// Classic script — shares one global scope with the other src/*.js. No imports.
//
// Sounds live under sounds/<goldsrc-subpath> (see tools/extract_sounds.py).
// Two playback paths, both driven by original data — nothing invented:
//   • gunfire / knife       → played from code (weapons.js), filenames in WPNS.
//   • reload/deploy/silencer → played by MDL animation events (event 5004),
//     embedded per sequence as `events:[{frame,sound}]` and fired frame-accurately
//     by applySkeletalAnimation (see _tickAnimEvents).

const SOUND_DIR = 'sounds/';

// AudioContext is created lazily on the first user gesture (Start button), since
// browsers block audio until then. decodeAudioData works on a suspended context,
// so buffers can warm up immediately after.
let _actx = null;
let _masterGain = null;
let masterVolume = 0.7;                       // 0..1, adjustable in the settings panel
const _channels = new Map();                   // channel name → { src, gain } currently playing

function initAudio() {
  if (!_actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _actx = new AC();
    _masterGain = _actx.createGain();
    _masterGain.gain.value = masterVolume;
    _masterGain.connect(_actx.destination);
  }
  if (_actx.state === 'suspended') _actx.resume();
  _loadMaterials();
  ['pl_step1', 'pl_step2', 'pl_step3', 'pl_step4'].forEach(s => _loadSound('player/' + s + '.wav'));
  // Grenade world sounds (bounce/detonation) — warm up front so the first throw's
  // bounce and blast play without an async decode gap.
  ['weapons/explode3.wav', 'weapons/explode4.wav', 'weapons/explode5.wav',
   'weapons/debris1.wav', 'weapons/debris2.wav', 'weapons/debris3.wav', 'weapons/he_bounce-1.wav',
   'weapons/grenade_hit1.wav', 'weapons/grenade_hit2.wav', 'weapons/grenade_hit3.wav',
   'weapons/flashbang-1.wav', 'weapons/flashbang-2.wav', 'weapons/sg_explode.wav',
   'weapons/c4_plant.wav', 'weapons/c4_click.wav', 'weapons/c4_explode1.wav',
   'weapons/c4_beep1.wav', 'weapons/c4_beep2.wav', 'weapons/c4_beep3.wav', 'weapons/c4_beep4.wav', 'weapons/c4_beep5.wav',
   'weapons/c4_disarm.wav', 'weapons/c4_disarmed.wav',
   // Bullet impacts (surface ricochets + victim hits) — warm so the first hit is crisp.
   ...['weapons/ric_conc-1.wav', 'weapons/ric_metal-1.wav', 'weapons/ric_metal-2.wav',
       'player/bhit_flesh-1.wav', 'player/bhit_flesh-2.wav', 'player/bhit_flesh-3.wav',
       'player/bhit_kevlar-1.wav', 'player/bhit_helmet-1.wav',
       'player/headshot1.wav', 'player/headshot2.wav', 'player/headshot3.wav',
       'weapons/ric1.wav', 'weapons/ric2.wav', 'weapons/ric3.wav', 'weapons/ric4.wav', 'weapons/ric5.wav',
       'player/pl_shell1.wav', 'player/pl_shell2.wav', 'player/pl_shell3.wav',
       'items/gunpickup2.wav']]   // spawn "gear-up" + weapon pickup
    .forEach(s => _loadSound(s));
}

function setMasterVolume(v) {
  masterVolume = Math.max(0, Math.min(1, v));
  if (_masterGain) _masterGain.gain.value = masterVolume;
}

// Decoded-buffer cache. Once a sound is decoded it lives in _bufReady (or null if
// it failed / is missing). _bufPromise tracks the in-flight decode so we fetch once.
const _bufReady   = new Map();   // rel → AudioBuffer | null (ready for synchronous play)
const _bufPromise = new Map();   // rel → Promise (in-flight decode)

// Kick off (or reuse) the fetch+decode for a sound; resolves into _bufReady.
function _loadSound(rel) {
  if (_bufPromise.has(rel)) return _bufPromise.get(rel);
  const p = fetch(SOUND_DIR + rel)
    .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error('404 ' + rel)))
    .then(buf => _actx.decodeAudioData(buf))
    .then(b => { _bufReady.set(rel, b); return b; })
    .catch(err => { console.warn('sound load failed:', rel, err.message); _bufReady.set(rel, null); return null; });
  _bufPromise.set(rel, p);
  return p;
}

// Stop whatever is playing on a channel. Mirrors GoldSrc: a new sound on a channel
// (e.g. CHAN_WEAPON gunfire) replaces the previous one — so bursts/fast taps stay
// crisp instead of summing into a drone. A ~4 ms fade avoids a click on the cut
// while staying close to the engine's hard overwrite.
function _stopChannel(ch) {
  const cur = _channels.get(ch);
  if (!cur) return;
  _channels.delete(ch);
  try {
    const now = _actx.currentTime;
    cur.gain.gain.cancelScheduledValues(now);
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, now);
    cur.gain.gain.linearRampToValueAtTime(0, now + 0.002);
    cur.src.stop(now + 0.003);
  } catch (e) { /* already ended */ }
}

// Start a decoded buffer on the optional channel (cutting the previous one there).
function _playBuffer(buf, opts) {
  const ch = opts.channel;
  if (ch) _stopChannel(ch);
  const src = _actx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = opts.rate ?? 1;
  const g = _actx.createGain();
  g.gain.value = opts.volume ?? 1;
  src.connect(g).connect(_masterGain);
  src.start(_actx.currentTime + (opts.delay || 0));   // opts.delay (s): scheduled later (e.g. impact travel)
  if (ch) {
    const entry = { src, gain: g };
    _channels.set(ch, entry);
    src.onended = () => { if (_channels.get(ch) === entry) _channels.delete(ch); };
  }
}

// Play a sound. opts: { volume=1, rate=1, channel }. If the buffer is already
// decoded it plays SYNCHRONOUSLY — so rapid fire cuts in the exact call order and
// never drifts into an overlapping drone. First-ever use of a sound decodes async.
function playSound(rel, opts = {}) {
  if (!rel || !_actx) return;
  const ready = _bufReady.get(rel);
  if (ready !== undefined) { if (ready) _playBuffer(ready, opts); return; }
  _loadSound(rel).then(b => { if (b) _playBuffer(b, opts); });
}

// Decode every weapon's gunfire/knife sample up front (called at game start) so the
// very first burst is already synchronous — no first-shot decode hitch or overlap.
function warmAllWeaponSounds() {
  if (!_actx || typeof WPNS === 'undefined') return;
  WPNS.forEach(warmWeaponSounds);
}

// Pick a random entry (the original randomises -1/-2 gunfire and knife hits).
function playRandom(list, opts) {
  if (!list || !list.length) return;
  playSound(list[(Math.random() * list.length) | 0], opts);
}

// Warm a weapon's sound buffers so the first shot/reload has no decode hitch.
// Pulls gunfire names from the config and reload/deploy/silencer names from the
// loaded animation events — exactly the files that will actually be played.
function warmWeaponSounds(wpn) {
  if (!_actx || !wpn) return;
  const add = s => { if (s) _loadSound(s); };
  [wpn.fireSound, wpn.fireSoundSil].forEach(arr => (arr || []).forEach(add));
  [wpn.deploySound, wpn.slashSound, wpn.stabSound,
   wpn.hitFleshSound, wpn.hitWallSound].forEach(s => {
    if (Array.isArray(s)) s.forEach(add); else add(s);
  });
  wpn.anim?.seqs?.forEach(seq => (seq.events || []).forEach(ev => add(ev.sound)));
}

// Drive MDL sound events for the currently animating sequence. Called from
// applySkeletalAnimation with the integer frame range crossed this tick; plays
// each event whose frame falls in (prevFrame, curFrame], so it fires once at the
// original frame regardless of framerate.
function _tickAnimEvents(wpn, seq, prevFrame, curFrame) {
  if (!seq?.events || !seq.events.length) return;
  for (const ev of seq.events) {
    if (ev.frame > prevFrame && ev.frame <= curFrame) playSound(ev.sound, { volume: 0.9 });
  }
}

// ── Footsteps / landing (GoldSrc pm_shared.c: PM_UpdateStepSound / PM_PlayStepSound /
// PM_CheckFalling). Surface is chosen from materials.txt by the texture under the
// player; cadence and volume come from speed. Nothing here is invented — constants
// and sample ordering match the engine. de_dust2's sand textures aren't tagged in
// materials.txt, so they fall to the default concrete pl_step set, as in the original.

const _materials = {};                          // first-12-chars(texture) UPPER → material char
function _loadMaterials() {
  if (_materials._loaded) return;
  _materials._loaded = true;
  fetch(SOUND_DIR + 'materials.txt').then(r => r.text()).then(txt => {
    for (let line of txt.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('//')) continue;
      const m = line.match(/^([A-Za-z])\s+(\S+)/);
      if (m) _materials[m[2].toUpperCase().slice(0, 12)] = m[1].toUpperCase();
    }
  }).catch(() => {});
}

// material char → { step-sound base, variant count, [walkVol, runVol] }.
// Chars handled by PM_MapTextureTypeStepType; everything else → concrete default.
const _STEP_DEFS = {
  C: { base: 'pl_step',  n: 4, vol: [0.20, 0.50] },   // concrete / default
  M: { base: 'pl_metal', n: 4, vol: [0.20, 0.50] },
  D: { base: 'pl_dirt',  n: 4, vol: [0.25, 0.55] },
  V: { base: 'pl_duct',  n: 4, vol: [0.40, 0.70] },   // vent
  G: { base: 'pl_grate', n: 4, vol: [0.20, 0.50] },
  T: { base: 'pl_tile',  n: 5, vol: [0.20, 0.50] },   // 5 variants
  S: { base: 'pl_slosh', n: 4, vol: [0.20, 0.50] },   // shallow liquid
  N: { base: 'pl_snow',  n: 6, vol: [0.20, 0.50] },
};

// ── Bullet impact sounds (original CS) ──────────────────────────────────────
// Surface ricochet by material (TEXTURETYPE_PlaySound / EV_HLDM texture sound):
// metal-ish surfaces ring (ric_metal), everything else thuds like concrete
// (ric_conc) — the only two bullet-ric sets the game ships. de_dust2's untagged
// sand falls to the concrete default, as in the original.
// Ricochet "zing" pools (~50% of hits, random). Concrete pools ric_conc-1 with the
// generic ric1-5 (all ricochets, varied); metal uses ric_metal. ric_conc-2 is the cut
// shield-block hit (not a wall sound), so it's excluded.
const _RIC_CONC  = ['weapons/ric_conc-1.wav', 'weapons/ric1.wav', 'weapons/ric2.wav',
                    'weapons/ric3.wav', 'weapons/ric4.wav', 'weapons/ric5.wav'];        // 6 files
const _RIC_METAL = [..._RIC_CONC, 'weapons/ric_metal-1.wav', 'weapons/ric_metal-2.wav']; // + metal = 8
const _RIC_CHANCE = 0.5;
// The impact sound reaches the shooter a touch after the muzzle blast — the farther
// the hit, the longer (≈ sound travelling back to the ear). Tiny up close, ~0.1s far.
const _SND_TRAVEL = 12000;   // GoldSrc units/s (≈ speed of sound). + a small base so even
function _impactDelay(dist) { return Math.min(0.025 + (dist || 0) / _SND_TRAVEL, 0.2); }   // close hits read as "after the shot"
// Distance attenuation: FULL volume up close (no fade within ~600u — near hits sound
// exactly as before), then fades with range to a faint floor by ~2600u.
function _distAtten(dist) {
  const d = dist || 0;
  if (d <= 600) return 1;
  return Math.max(0.1, 1 - (d - 600) / 2000);
}

function playBulletImpact(materialName, dist) {
  const ch = _materials[(materialName || '').toUpperCase().slice(0, 12)] || 'C';
  const delay = _impactDelay(dist), att = _distAtten(dist);
  // Base impact: the material's own thud (HLSDK TEXTURETYPE_PlaySound reuses the
  // footstep samples — concrete→pl_step, metal→pl_metal, …). Quiet: barely audible
  // under the gunshot, but present on every hit. Delayed by travel so it lands after the shot.
  const def = _STEP_DEFS[ch] || _STEP_DEFS.C;
  playSound(`player/${def.base}${1 + ((Math.random() * def.n) | 0)}.wav`, { volume: 0.15 * att, delay });
  // ~50%: a random ricochet zing over the thud.
  if (Math.random() < _RIC_CHANCE) {
    const list = (ch === 'M' || ch === 'V' || ch === 'G') ? _RIC_METAL : _RIC_CONC;
    playRandom(list, { volume: 0.45 * att, delay });
  }
}

// Ejected-brass landing "tink" (engine TE_BOUNCE_SHELL → pl_shell*). Light and varied.
const _SHELL_DROP = ['player/pl_shell1.wav', 'player/pl_shell2.wav', 'player/pl_shell3.wav'];
function playShellDrop() { playRandom(_SHELL_DROP, { volume: 0.25 }); }

// Victim hit (CBasePlayer::TraceAttack), bullets only — the knife has its own hits.
//   head + helmet → helmet ting; head, no helmet → headshot; torso/arm under armor
//   → kevlar; otherwise flesh.
const _BHIT_FLESH = ['player/bhit_flesh-1.wav', 'player/bhit_flesh-2.wav', 'player/bhit_flesh-3.wav'];
const _HEADSHOT   = ['player/headshot1.wav', 'player/headshot2.wav', 'player/headshot3.wav'];
function playVictimHit(hg, armorAbsorbed, helmet, dist) {
  const delay = _impactDelay(dist), att = _distAtten(dist);   // later + quieter with range
  if (hg === 1) {
    if (helmet) playSound('player/bhit_helmet-1.wav', { volume: 0.9 * att, delay });
    else        playRandom(_HEADSHOT, { volume: 0.95 * att, delay });
  } else if (armorAbsorbed) {
    playSound('player/bhit_kevlar-1.wav', { volume: 0.85 * att, delay });
  } else {
    playRandom(_BHIT_FLESH, { volume: 0.85 * att, delay });
  }
}

const _footRay    = new THREE.Raycaster();
const _footDir    = new THREE.Vector3(0, -1, 0);
const _footOrigin = new THREE.Vector3();
let   _iStepLeft  = 0;
let   _stepTimerMs = 0;        // PM's flTimeStepSound countdown
let   _wasOnGround = true;
let   _peakFall    = 0;        // peak downward speed while airborne (for landing volume)

// Trace down to the floor and resolve its step-sound set from materials.txt.
function _floorStepDef() {
  let ch = 'C';
  if (_shellRayTargets && typeof gsPos !== 'undefined' && gsPos) {
    _footOrigin.set(gsPos[0], gsPos[2] + 10, -gsPos[1]);     // GoldSrc (x,y,z) → three (x,z,−y)
    _footRay.set(_footOrigin, _footDir);
    _footRay.far = 200;
    const hits = _footRay.intersectObjects(_shellRayTargets, false);
    if (hits.length) {
      const name = (hits[0].object.material && hits[0].object.material.name) || '';
      ch = _materials[name.toUpperCase().slice(0, 12)] || 'C';
    }
  }
  return _STEP_DEFS[ch] || _STEP_DEFS.C;
}

// Play one footstep: alternate feet, pick a variant (engine's 1,3,2,4 ordering;
// tile has a 5th with 20% chance), at the given volume.
function _playStep(def, fvol) {
  _iStepLeft = _iStepLeft ? 0 : 1;
  const irand = (Math.random() < 0.5 ? 0 : 1) + _iStepLeft * 2;   // 0..3
  let v = [1, 3, 2, 4][irand];
  if (def.base === 'pl_tile' && ((Math.random() * 5) | 0) === 0) v = 5;
  if (v > def.n) v = 1 + ((Math.random() * def.n) | 0);
  playSound(`player/${def.base}${v}.wav`, { volume: fvol });
}

// ── Remote-player (bot) world sounds ─────────────────────────────────────────
// Other players' sounds are heard from THEIR position — 2D playback (no panning, like
// everything else here) but attenuated by distance to the local player. Only the
// "outward" sounds are emitted for remotes (footsteps, landing, gunfire, knife deploy);
// reload / silencer / gun deploy are first-person-only in the original, so net.js
// doesn't call these for them.
// Distance attenuation from the LISTENER (the camera anchor yawObj — valid even while
// spectating/dead, unlike gsPos which is null then). posGs is GoldSrc; convert to Three
// to match yawObj. Linear falloff to silence at `range`.
function _worldVol(posGs, base, range) {
  const ears = (typeof yawObj !== 'undefined' && yawObj) ? yawObj.position : null;
  if (!ears || !posGs) return base * 0.4;                 // no listener → quiet, never full
  const dx = posGs[0] - ears.x, dy = posGs[2] - ears.y, dz = -posGs[1] - ears.z;   // gs→three
  const d = Math.hypot(dx, dy, dz);
  return Math.max(0, Math.min(1, 1 - d / (range || 1300))) * base;
}

// Floor step-sound set at an arbitrary GoldSrc position (for a remote's feet).
const _rFootOrigin = new THREE.Vector3();
function _floorStepDefAt(posGs) {
  let ch = 'C';
  if (_shellRayTargets && posGs) {
    _rFootOrigin.set(posGs[0], posGs[2] + 10, -posGs[1]);
    _footRay.set(_rFootOrigin, _footDir); _footRay.far = 200;
    const hits = _footRay.intersectObjects(_shellRayTargets, false);
    if (hits.length) {
      const name = (hits[0].object.material && hits[0].object.material.name) || '';
      ch = _materials[name.toUpperCase().slice(0, 12)] || 'C';
    }
  }
  return _STEP_DEFS[ch] || _STEP_DEFS.C;
}

function playRemoteStep(posGs, running) {
  const def = _floorStepDefAt(posGs);
  const vol = _worldVol(posGs, def.vol[running ? 1 : 0], 1100);   // footsteps fade fast
  if (vol > 0.02) _playStep(def, vol);
}

// A remote's gunfire at their position (cut per-remote so their own burst stays crisp).
function playRemoteFire(list, posGs, chan) {
  const vol = _worldVol(posGs, 1.0, 2600);                        // gunfire carries farther
  if (vol > 0.02) playRandom(list, { volume: vol, channel: chan });
}

// A remote one-shot at their position (landing step, knife deploy).
function playRemoteSound(rel, posGs, base) {
  const vol = _worldVol(posGs, base != null ? base : 1.0, 1300);
  if (vol > 0.02) (Array.isArray(rel) ? playRandom(rel, { volume: vol }) : playSound(rel, { volume: vol }));
}

// Per-frame: running footsteps on the ground + a footstep on landing. Call from the
// main loop after playerMove.
//
// CS 1.6: only RUNNING makes footstep sounds. Walking (Shift) and crouch-moving are
// silent — that's their whole tactical point — so they're gated out here. Landing from
// a jump or fall plays a footstep (PM_CheckFalling), independent of the walk/crouch
// gate — so a crouch-jump still thumps a step on touchdown; the harder the drop the
// louder it is, and a dangerous fall (>580) adds the pain grunt.
function updateMovementSounds(dt) {
  if (!_actx || typeof gsPos === 'undefined' || !gsPos || !vel) return;
  _stepTimerMs -= dt * 1000;

  const jumpvel = (typeof SV !== 'undefined' && SV.jumpvel) || 245;
  const landMin = jumpvel * 0.8;                 // ≈ PLAYER_MIN_BOUNCE_SPEED → a full jump lands a step
  if (!onGround) {
    _peakFall = Math.max(_peakFall, -vel[2]);    // track peak downward speed while airborne
  } else {
    if (!_wasOnGround && _peakFall >= landMin) {
      const def = _floorStepDef();
      let fvol = def.vol[1];                                     // normal jump = a run-volume footstep
      if (_peakFall > 580)      { fvol = 1.0; playSound('player/pl_fallpain1.wav', { volume: 0.9 }); }
      else if (_peakFall > 290) { fvol = 0.85; }                 // PLAYER_MAX_SAFE_FALL_SPEED/2 → harder
      _playStep(def, fvol);
      _stepTimerMs = 300;
    }
    _peakFall = 0;
  }
  _wasOnGround = onGround;
  if (!onGround) return;

  // Running cadence — silent while walking (Shift) or ducking, as in the original.
  const walking = typeof keys !== 'undefined' && (keys['ShiftLeft'] || keys['ShiftRight']);
  const ducking = (typeof phyDucked !== 'undefined' && phyDucked) || duckAmount > 0.5;
  if (walking || ducking) return;

  const speed = Math.hypot(vel[0], vel[1]);
  if (speed < 120 || _stepTimerMs > 0) return;                  // PM velwalk: must be moving at run pace

  const def = _floorStepDef();
  _playStep(def, def.vol[1]);                                   // run volume for this surface
  _stepTimerMs = 300;
}
