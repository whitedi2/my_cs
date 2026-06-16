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
  src.start();
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
