// grenades.js — throwables: HE / flashbang / smoke.
// Classic script — shares one global scope with the other src/*.js (THREE, scene,
// camera, traceMove, gsPos/yaw/pitch/vel, SV, playSound, enemyRadiusDamage …). No imports.
//
// Flow: weapons.js drives the view-model throw cycle (deploy→idle→pullpin→throw) and
// calls throwGrenade() at the release frame. Here we spawn a w_<type> projectile that
// arcs under gravity and bounces off the BSP (player-hull trace — an approximation, see
// docs/DIFFERENCES.md), counts down a fuse, then detonates per type.

// ── Per-type tuning, from ReGameDLL. All three throw with ThrowGrenade(…, 1.5) →
//    1.5 s fuse. HE: pev->dmg = 100; the blast radius is dmg × 3.5 = 350 (CBaseMonster::
//    RadiusDamage picks ×3.5 when dmg > 80), with linear falloff dmg·(1 − dist/radius). ──
const GRENADE_DEFS = {
  hegrenade:    { fuse: 1.5, damage: 100, radius: 350, w: 'models/w_hegrenade.json',
                  detonate: 'weapons/hegrenade-1.wav' },
  flashbang:    { fuse: 1.5, w: 'models/w_flashbang.json',
                  detonate: 'weapons/flashbang-1.wav' },
  smokegrenade: { fuse: 1.5, w: 'models/w_smokegrenade.json',
                  detonate: 'weapons/sg_explode.wav' },
};

const GREN_ELAST   = 0.5;   // 🔹 bounce restitution across the normal (engine SV_Physics bounce
                            //    coefficient isn't a single exposed constant — kept as approximation)
const GREN_FRICT   = 0.7;   // tangential speed kept per bounce — CS grenade pev->friction = 0.7
const GREN_GRAVITY = 0.55;  // CS sets the grenade entity pev->gravity = 0.55 → falls at ~half
                            // sv_gravity, so it arcs much farther than a full-gravity drop.
// Grenades are traced with the smallest available BSP hull (duck/hull3, ±18 vertical),
// so a resting grenade's CENTER sits ~18u above the floor. Drop the visual mesh by this
// much so the model actually touches the ground (see docs/DIFFERENCES.md 🔹).
const GREN_VIS_DROP = 14;
// Spawn the nade a touch above the eye so it reads as leaving the raised throwing hand
// (the projectile origin in CS is the eye; this is purely the visual "from the hand" lift).
const GREN_SPAWN_LIFT = 12;

const _grenadesInAir = [];
const _explosions = [];
const _smokes = [];
const _wMeshCache = {};     // type → built mesh template (cloned per throw)

// ── Procedural soft round particle (smoke puff / explosion glow) ─────────────
let _puffTex = null;
function _getPuffTex() {
  if (_puffTex) return _puffTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0,   'rgba(255,255,255,1)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1,   'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _puffTex = new THREE.CanvasTexture(c);
  return _puffTex;
}

// The smoke-grenade cloud uses the ORIGINAL CS smoke puff sprite (sprites/gas_puff_01.spr,
// extracted to PNG by tools/extract_spr.py): a soft, irregular, alpha-masked grey blob —
// non-additive so overlapping puffs actually occlude. Falls back to the procedural puff.
let _smokeTex = null;
function _getSmokeTex() {
  if (_smokeTex) return _smokeTex;
  if (typeof _texLoader !== 'undefined' && _texLoader) _smokeTex = _texLoader.load('sprites/gas_puff_01_00.png');
  return _smokeTex || _getPuffTex();
}

// ── Build the thrown grenade mesh from a w_<type>.json (static mesh, world scale) ──
// The w_ models are authored off-origin (their pivot is the player's hand attachment,
// not the body center) — recenter the geometry on its bbox so the grenade spins in
// place and sits exactly at the physics point instead of orbiting an offset pivot.
function _buildWorldMesh(data) {
  const grp = new THREE.Group();
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  data.meshes.forEach(m => {
    for (let i = 0; i < m.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
  });
  const ctr = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  data.meshes.forEach(m => {
    const pos = new Float32Array(m.positions);
    for (let i = 0; i < pos.length; i += 3) { pos[i] -= ctr[0]; pos[i + 1] -= ctr[1]; pos[i + 2] -= ctr[2]; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(m.uvs, 2));
    geo.setIndex(m.indices);
    const mat = new THREE.MeshLambertMaterial({ map: _texLoader.load(m.texFile), side: THREE.DoubleSide });
    grp.add(new THREE.Mesh(geo, mat));
  });
  return grp;
}
function _ensureWMesh(type, cb) {
  if (_wMeshCache[type]) { cb(_wMeshCache[type]); return; }
  fetch(GRENADE_DEFS[type].w).then(r => r.json()).then(data => {
    _wMeshCache[type] = _buildWorldMesh(data);
    cb(_wMeshCache[type]);
  }).catch(() => cb(null));
}

// ── Throw: spawn the projectile at the eye + aim, with an arc ────────────────
// Original CS lob (ggrenade.cpp): the aim pitch is biased ~10° upward and the throw
// speed scales with how far DOWN you look (level aim ≈ 500 u/s, max 1000). GoldSrc
// pitch is +down; our `pitch` is +up, so negate when entering the formula.
function throwGrenade(wpn) {
  if (!gsPos) return;
  const type = wpn.grenadeType;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);

  let gp = -pitch * 180 / Math.PI;                       // GoldSrc-convention pitch (deg, +down)
  if (gp < 0) gp = -10 + gp * ((90 - 10) / 90);
  else        gp = -10 + gp * ((90 + 10) / 90);
  let flVel = (90 - gp) * 5;
  if (flVel > 1000) flVel = 1000;

  const mp = -gp * Math.PI / 180;                        // biased pitch back in our +up convention
  const cp = Math.cos(mp), sp = Math.sin(mp);
  const fwd = [-Math.sin(yaw) * cp, Math.cos(yaw) * cp, sp];   // GoldSrc forward (+z up)

  const eye = [gsPos[0], gsPos[1], gsPos[2] + eyeH + GREN_SPAWN_LIFT];
  let src = [eye[0] + fwd[0] * 16, eye[1] + fwd[1] * 16, eye[2] + fwd[2] * 16];
  // Don't let the 16u muzzle offset poke the projectile through a wall/floor when you
  // throw straight into a surface (otherwise it spawns in solid and falls through).
  const tr0 = _traceGren(eye, src);
  if (tr0.fraction < 1) src = [...tr0.end];

  // Inherit the player's velocity (CS: vecThrow = forward*flVel + pev->velocity) — so a
  // forward run adds range and backpedaling subtracts it (the nade nearly hangs).
  const vx = fwd[0] * flVel + (vel ? vel[0] : 0);
  const vy = fwd[1] * flVel + (vel ? vel[1] : 0);
  const vz = fwd[2] * flVel + (vel ? vel[2] : 0);
  const g = { type, pos: src, vel: [vx, vy, vz], fuse: GRENADE_DEFS[type].fuse, mesh: null,
              spin: [Math.random() * 6, Math.random() * 6, 0], resting: false, bounceT: 0, drop: 0 };
  _ensureWMesh(type, tmpl => {
    if (!tmpl || g._dead) return;
    g.mesh = tmpl.clone();
    g.mesh.position.set(g.pos[0], g.pos[2] - g.drop, -g.pos[1]);
    scene.add(g.mesh);
  });
  _grenadesInAir.push(g);
}

// Swept trace for grenades using the smallest BSP hull (duck/hull3) so they collide
// close to the floor. Mirrors physics.js traceMove but forces the duck hull/entities.
function _traceGren(from, to) {
  const tr = { fraction: 1, end: [...to], plane: null, startsolid: false, allsolid: true };
  _check(gHullHeadDuck, gHullHeadDuck, 0, 1, from, to, tr);
  for (const head of gEntitySolidHeadsDuck) {
    if (head < 0) continue;
    const t2 = { fraction: 1, end: [...to], plane: null, startsolid: false, allsolid: true };
    _check(head, head, 0, 1, from, to, t2);
    if (t2.fraction < tr.fraction) {
      tr.fraction = t2.fraction; tr.end = t2.end;
      tr.plane = t2.plane; tr.startsolid = t2.startsolid; tr.allsolid = t2.allsolid;
    }
  }
  return tr;
}

// ── Per-frame: projectiles (physics + fuse), explosions, smokes, blind ───────
function updateGrenades(dt) {
  _updateBlind(dt);
  for (let i = _grenadesInAir.length - 1; i >= 0; i--) {
    const g = _grenadesInAir[i];
    g.fuse -= dt;
    if (g.bounceT > 0) g.bounceT -= dt;
    if (!g.resting) _moveGrenade(g, dt);
    if (g.mesh) {
      // In flight the mesh sits at the true (collision-center) point so it leaves at
      // hand height; once it settles, ease it down onto the floor (the duck-hull center
      // rests ~18u up). Easing avoids a hard pop when it comes to rest.
      const target = g.resting ? GREN_VIS_DROP : 0;
      g.drop += (target - g.drop) * Math.min(1, dt * 12);
      g.mesh.position.set(g.pos[0], g.pos[2] - g.drop, -g.pos[1]);
      if (!g.resting) { g.mesh.rotation.x += g.spin[0] * dt; g.mesh.rotation.y += g.spin[1] * dt; }
    }
    if (g.fuse <= 0) {
      _detonate(g);
      g._dead = true;
      if (g.mesh) scene.remove(g.mesh);
      _grenadesInAir.splice(i, 1);
    }
  }
  _updateExplosions(dt);
  _updateHEExplosions(dt);
  _updateSmokes(dt);
}

// Gravity + swept BSP collision with reflection off the hit-plane normal.
function _moveGrenade(g, dt) {
  const prev = [...g.pos];                  // last known good (non-solid) position
  g.vel[2] -= SV.gravity * GREN_GRAVITY * dt;
  let timeLeft = dt, hops = 0;
  while (timeLeft > 1e-5 && hops < 4) {
    const to = [g.pos[0] + g.vel[0] * timeLeft, g.pos[1] + g.vel[1] * timeLeft, g.pos[2] + g.vel[2] * timeLeft];
    const tr = _traceGren(g.pos, to);
    if (tr.allsolid) { g.vel = [0, 0, 0]; g.resting = true; return; }
    if (tr.fraction > 0) g.pos = [...tr.end];
    if (tr.fraction >= 1 || !tr.plane) break;
    const n = tr.plane;
    const dot = g.vel[0] * n[0] + g.vel[1] * n[1] + g.vel[2] * n[2];
    g.vel[0] = (g.vel[0] - (1 + GREN_ELAST) * dot * n[0]) * GREN_FRICT;
    g.vel[1] = (g.vel[1] - (1 + GREN_ELAST) * dot * n[1]) * GREN_FRICT;
    g.vel[2] = (g.vel[2] - (1 + GREN_ELAST) * dot * n[2]) * GREN_FRICT;
    if (g.bounceT <= 0 && Math.hypot(g.vel[0], g.vel[1], g.vel[2]) > 80) {
      _grenadeBounceSound(g); g.bounceT = 0.12;
    }
    timeLeft -= timeLeft * tr.fraction;
    hops++;
  }
  // Safety net: if a fast bounce ever lands the center inside geometry, snap back to
  // the last good spot and settle — never let a grenade vanish through the world.
  if (typeof pointContents === 'function' && pointContents(gHullHeadDuck, g.pos) === CONTENTS_SOLID) {
    g.pos = prev; g.vel = [0, 0, 0]; g.resting = true;
  }
  // Settle on a near-flat surface once it's slow (so it doesn't jitter forever).
  if (Math.hypot(g.vel[0], g.vel[1], g.vel[2]) < 30) g.resting = true;
}

// Bounce sound. Canon (ggrenade.cpp / CS assets): the HE grenade has its own
// metallic 'he_bounce-1.wav'; flash/smoke use the soft grenade_hit1-3 set. Pitch is
// jittered (engine uses 98 + rand(0,15)) so repeated bounces don't sound identical.
function _grenadeBounceSound(g) {
  if (typeof playSound !== 'function') return;
  const v = _distVolume(g.pos, 0.55);
  if (v <= 0.02) return;
  const rate = (98 + Math.random() * 15) / 100;
  if (g.type === 'hegrenade') {
    playSound('weapons/he_bounce-1.wav', { volume: v, rate });
  } else {
    playRandom(['weapons/grenade_hit1.wav', 'weapons/grenade_hit2.wav', 'weapons/grenade_hit3.wav'],
               { volume: v, rate });
  }
}

// Crude distance attenuation for world sounds (no positional audio backend here).
function _distVolume(posGs, scale) {
  if (!gsPos) return scale;
  const d = Math.hypot(posGs[0] - gsPos[0], posGs[1] - gsPos[1], posGs[2] - gsPos[2]);
  return Math.max(0, Math.min(1, 1 - d / 1400)) * (scale ?? 1);
}

// ── Detonation dispatch ──────────────────────────────────────────────────────
function _detonate(g) {
  if (g.type === 'hegrenade')        _detonateHE(g);
  else if (g.type === 'flashbang')   _detonateFlash(g);
  else                               _detonateSmoke(g);
}

function _detonateHE(g) {
  const def = GRENADE_DEFS.hegrenade;
  // Canon GoldSrc grenade blast (ggrenade.cpp): the punchy explode3/4/5 boom plus a
  // debris1-3 rubble tail. (cstrike's hegrenade-1/2.wav are byte-identical dupes — not
  // the real explosion variants.)
  if (typeof playRandom === 'function') {
    const v = Math.max(0.3, _distVolume(g.pos, 1));
    playRandom(['weapons/explode3.wav', 'weapons/explode4.wav', 'weapons/explode5.wav'], { volume: v });
    playRandom(['weapons/debris1.wav', 'weapons/debris2.wav', 'weapons/debris3.wav'], { volume: v * 0.55 });
  }
  _spawnHEExplosion(g.pos);
  if (typeof enemyRadiusDamage === 'function')  enemyRadiusDamage(g.pos, def.damage, def.radius);
  if (typeof playerRadiusDamage === 'function') playerRadiusDamage(g.pos, def.damage, def.radius);
}

// HE blast = original CS fireball sprite (sprites/zerogxplode.spr, the model index
// g_sModelIndexFireball used by TE_EXPLOSION in ggrenade.cpp), played as a 15-frame
// additive billboard. Loaded lazily via scene.js's additive-sprite helper.
const _heFrames = [];
const _heExplosions = [];
function _getHEFrames() {
  if (_heFrames.length) return _heFrames;
  for (let i = 0; i < 15; i++)
    _heFrames.push(_loadAdditiveSprite(`sprites/zerogxplode_${String(i).padStart(2, '0')}.png`));
  return _heFrames;
}
// Canon (ggrenade.cpp Explode3 / ExplodeHeGrenade): the HE blast sends TWO additive
// fireball sprites via TE_EXPLOSION — a primary at origin.z+20 (scale*10 = 25) and a
// slightly LARGER secondary jittered by ±64 on x/y and +30..35 on z (scale*10 = 30).
// The original uses three different fireball .spr indices (Fireball/2/3); we only ship
// zerogxplode, so both reuse it (🔹 approximation, see docs/DIFFERENCES.md).
function _spawnHEExplosion(posGs) {
  _spawnHEFireball([posGs[0], posGs[1], posGs[2] + 20], 160);
  const ox = Math.random() * 128 - 64, oy = Math.random() * 128 - 64, oz = 30 + Math.random() * 5;
  _spawnHEFireball([posGs[0] + ox, posGs[1] + oy, posGs[2] + oz], 192);   // 192/160 ≈ 30/25
}
function _spawnHEFireball(posGs, base) {
  const frames = _getHEFrames();
  const mat = new THREE.SpriteMaterial({ map: frames[0] && frames[0].tex, color: 0xffffff, transparent: true,
    opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  s.position.set(posGs[0], posGs[2], -posGs[1]);
  s.scale.setScalar(base);
  scene.add(s);
  _heExplosions.push({ sprite: s, age: 0, life: 0.6, frames, base });
}
function _updateHEExplosions(dt) {
  for (let i = _heExplosions.length - 1; i >= 0; i--) {
    const e = _heExplosions[i]; e.age += dt;
    const t = e.age / e.life;
    if (t >= 1) { scene.remove(e.sprite); e.sprite.material.dispose(); _heExplosions.splice(i, 1); continue; }
    const fi = Math.min(e.frames.length - 1, Math.floor(t * e.frames.length));
    const ref = e.frames[fi];
    if (ref && ref.tex) { e.sprite.material.map = ref.tex; e.sprite.material.needsUpdate = true; }
    const base = e.base || 160;
    e.sprite.scale.setScalar(base + base * 0.44 * t);   // slight expansion over the playback
  }
}

// Preload the explosion frames at startup so the FIRST HE detonation actually shows
// its sprite (image decode is async; otherwise the first blast renders nothing).
// Grenade SOUNDS are warmed from initAudio() (needs the audio context to exist).
_getHEFrames();

function _detonateFlash(g) {
  if (typeof playRandom === 'function')
    playRandom(['weapons/flashbang-1.wav', 'weapons/flashbang-2.wav'],
               { volume: Math.max(0.25, _distVolume(g.pos, 1)) });
  _spawnExplosion(g.pos, true);
  // Blind the player by distance + facing + line-of-sight (🔹 simplified CS model).
  if (!gsPos) return;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const eye = [gsPos[0], gsPos[1], gsPos[2] + eyeH];
  const dx = g.pos[0] - eye[0], dy = g.pos[1] - eye[1], dz = g.pos[2] - eye[2];
  const dist = Math.hypot(dx, dy, dz) || 1;
  const tr = _traceGren(eye, g.pos);                     // point-ish LOS (small hull)
  if (tr.fraction < 0.8) return;                        // wall between you and the flash → no blind
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const fwd = [-Math.sin(yaw) * cp, Math.cos(yaw) * cp, sp];   // +up matches throw/camera fwd
  const facing = (fwd[0] * dx + fwd[1] * dy + fwd[2] * dz) / dist;   // 1 = staring at it
  const prox = Math.max(0, 1 - dist / 1500);            // within ~1500u
  if (prox <= 0) return;
  const face01 = (facing + 1) / 2;                       // 0 (behind) … 1 (ahead)
  // Staring at a close flash → full whiteout; facing away or far → progressively weaker.
  const intensity = Math.min(1, (0.5 + 0.5 * face01) * (0.45 + 0.55 * prox) + 0.05);
  const duration = 0.5 + prox * (facing > 0.3 ? 6 : facing > -0.3 ? 2.5 : 1);
  if (intensity > _blind.intensity || duration > _blind.t) {
    _blind.intensity = Math.max(_blind.intensity, intensity);
    _blind.t = Math.max(_blind.t, duration);
    _blind.max = _blind.t;
  }
}

function _detonateSmoke(g) {
  if (typeof playSound === 'function')
    playSound('weapons/sg_explode.wav', { volume: Math.max(0.25, _distVolume(g.pos, 1)) });
  // A cluster of soft billboards forming an expanding, slowly-drifting cloud — built from
  // the original CS smoke puff sprite. Each puff is randomly rotated and slightly tinted so
  // the irregular blobs don't read as identical stamps.
  const puffs = [];
  const N = 18, tex = _getSmokeTex();
  for (let i = 0; i < N; i++) {
    const g = 0.72 + Math.random() * 0.12;               // subtle grey variation per puff
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true,
                                           opacity: 0, depthWrite: false, fog: true });
    mat.color.setRGB(g, g, g * 1.02);
    mat.rotation = Math.random() * Math.PI * 2;
    const s = new THREE.Sprite(mat);
    const ox = (Math.random() - 0.5), oy = (Math.random() - 0.5), oz = Math.random() * 0.6;
    s.userData.off = [ox, oy, oz];
    scene.add(s);
    puffs.push(s);
  }
  _smokes.push({ pos: [g.pos[0], g.pos[1], g.pos[2] + 20], r: 12, maxR: 150,
                 age: 0, grow: 1.4, life: 15, fade: 2.5, puffs });
}

// ── Explosion glow (HE/flash core) — additive billboard that pops and fades ──
function _spawnExplosion(posGs, white) {
  const mat = new THREE.SpriteMaterial({ map: _getPuffTex(),
    color: white ? 0xffffff : 0xffa030, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  s.position.set(posGs[0], posGs[2] + 8, -posGs[1]);
  s.scale.setScalar(30);
  scene.add(s);
  _explosions.push({ sprite: s, age: 0, life: white ? 0.6 : 0.45, grow: white ? 360 : 240 });
}
function _updateExplosions(dt) {
  for (let i = _explosions.length - 1; i >= 0; i--) {
    const e = _explosions[i]; e.age += dt;
    const t = e.age / e.life;
    e.sprite.scale.setScalar(30 + e.grow * Math.min(1, t * 1.4));
    e.sprite.material.opacity = Math.max(0, 1 - t);
    if (t >= 1) { scene.remove(e.sprite); e.sprite.material.dispose(); _explosions.splice(i, 1); }
  }
}

// ── Smoke clouds — expand, hold, then fade out ───────────────────────────────
function _updateSmokes(dt) {
  for (let i = _smokes.length - 1; i >= 0; i--) {
    const sm = _smokes[i]; sm.age += dt;
    sm.r = Math.min(sm.maxR, sm.r + sm.grow * dt * (sm.r < sm.maxR ? 60 : 0));
    const tLife = sm.age - (sm.life - sm.fade);
    const fadeOut = tLife > 0 ? Math.max(0, 1 - tLife / sm.fade) : 1;
    const fadeIn = Math.min(1, sm.age / 0.8);
    const op = 0.85 * fadeIn * fadeOut;
    for (const s of sm.puffs) {
      const o = s.userData.off;
      s.position.set(sm.pos[0] + o[0] * sm.r, (sm.pos[2] + o[2] * sm.r * 0.7), -(sm.pos[1] + o[1] * sm.r));
      s.scale.setScalar(sm.r * 1.5);
      s.material.opacity = op;
    }
    if (sm.age >= sm.life) { for (const s of sm.puffs) { scene.remove(s); s.material.dispose(); } _smokes.splice(i, 1); }
  }
}

// ── Flashbang blind overlay (white screen, fast onset, slow fade) ────────────
const _blind = { intensity: 0, t: 0, max: 1 };
function _updateBlind(dt) {
  const el = document.getElementById('flash-overlay');
  if (!el) return;
  if (_blind.t > 0) {
    _blind.t -= dt;
    // Hold near-full for the first ~40% of the duration, then fade to clear.
    const frac = Math.max(0, _blind.t / _blind.max);
    const a = _blind.intensity * Math.min(1, frac / 0.6);
    el.style.opacity = a.toFixed(3);
    if (_blind.t <= 0) { _blind.intensity = 0; el.style.opacity = '0'; }
  }
}

// Drop everything on respawn / state reset.
function clearGrenades() {
  for (const g of _grenadesInAir) { g._dead = true; if (g.mesh) scene.remove(g.mesh); }
  _grenadesInAir.length = 0;
  for (const e of _explosions) scene.remove(e.sprite);
  _explosions.length = 0;
  for (const e of _heExplosions) { scene.remove(e.sprite); e.sprite.material.dispose(); }
  _heExplosions.length = 0;
  for (const sm of _smokes) for (const s of sm.puffs) scene.remove(s);
  _smokes.length = 0;
  _blind.intensity = 0; _blind.t = 0;
  const el = document.getElementById('flash-overlay'); if (el) el.style.opacity = '0';
}
