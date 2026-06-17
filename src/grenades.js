// grenades.js — throwables: HE / flashbang / smoke.
// Classic script — shares one global scope with the other src/*.js (THREE, scene,
// camera, traceMove, gsPos/yaw/pitch/vel, SV, playSound, enemyRadiusDamage …). No imports.
//
// Flow: weapons.js drives the view-model throw cycle (deploy→idle→pullpin→throw) and
// calls throwGrenade() at the release frame. Here we spawn a w_<type> projectile that
// arcs under gravity and bounces off the BSP (player-hull trace — an approximation, see
// docs/DIFFERENCES.md), counts down a fuse, then detonates per type.

// ── Per-type tuning. Geometry/timings approximated (🔹) — exact ReGameDLL fuse/radius
//    values weren't on hand; damage model is linear falloff with LOS + armor soak. ──
const GRENADE_DEFS = {
  hegrenade:    { fuse: 1.6, damage: 100, radius: 340, w: 'models/w_hegrenade.json',
                  detonate: 'weapons/hegrenade-1.wav' },
  flashbang:    { fuse: 1.6, w: 'models/w_flashbang.json',
                  detonate: 'weapons/flashbang-1.wav' },
  smokegrenade: { fuse: 1.6, w: 'models/w_smokegrenade.json',
                  detonate: 'weapons/sg_explode.wav' },
};

const THROW_FORCE = 750;   // 🔹 forward throw speed (CS scales by pitch; we use the aim dir)
const THROW_LIFT  = 200;   // 🔹 extra upward (GoldSrc +Z) so it lobs
const GREN_ELAST  = 0.5;   // bounce energy kept across the surface normal
const GREN_FRICT  = 0.8;   // tangential speed kept per bounce

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

// ── Build the thrown grenade mesh from a w_<type>.json (static mesh, world scale) ──
function _buildWorldMesh(data) {
  const grp = new THREE.Group();
  data.meshes.forEach(m => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(m.positions), 3));
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
function throwGrenade(wpn) {
  if (!gsPos) return;
  const type = wpn.grenadeType;
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const fwd = [-Math.sin(yaw) * cp, Math.cos(yaw) * cp, -sp];        // GoldSrc aim forward
  const src = [gsPos[0] + fwd[0] * 16, gsPos[1] + fwd[1] * 16, gsPos[2] + eyeH + fwd[2] * 16];
  const vx = fwd[0] * THROW_FORCE + (vel ? vel[0] : 0);
  const vy = fwd[1] * THROW_FORCE + (vel ? vel[1] : 0);
  const vz = fwd[2] * THROW_FORCE + THROW_LIFT + (vel ? vel[2] : 0);
  const g = { type, pos: src, vel: [vx, vy, vz], fuse: GRENADE_DEFS[type].fuse,
              mesh: null, spin: [Math.random() * 6, Math.random() * 6, 0], resting: false, bounceT: 0 };
  _ensureWMesh(type, tmpl => {
    if (!tmpl || g._dead) return;
    g.mesh = tmpl.clone();
    g.mesh.position.set(g.pos[0], g.pos[2], -g.pos[1]);
    scene.add(g.mesh);
  });
  _grenadesInAir.push(g);
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
      g.mesh.position.set(g.pos[0], g.pos[2], -g.pos[1]);
      g.mesh.rotation.x += g.spin[0] * dt; g.mesh.rotation.y += g.spin[1] * dt;
    }
    if (g.fuse <= 0) {
      _detonate(g);
      g._dead = true;
      if (g.mesh) scene.remove(g.mesh);
      _grenadesInAir.splice(i, 1);
    }
  }
  _updateExplosions(dt);
  _updateSmokes(dt);
}

// Gravity + swept BSP collision with reflection off the hit-plane normal.
function _moveGrenade(g, dt) {
  g.vel[2] -= SV.gravity * dt;
  let timeLeft = dt, hops = 0;
  while (timeLeft > 1e-5 && hops < 4) {
    const to = [g.pos[0] + g.vel[0] * timeLeft, g.pos[1] + g.vel[1] * timeLeft, g.pos[2] + g.vel[2] * timeLeft];
    const tr = traceMove(g.pos, to);
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
  // Settle on a near-flat surface once it's slow (so it doesn't jitter forever).
  if (Math.hypot(g.vel[0], g.vel[1], g.vel[2]) < 30) g.resting = true;
}

function _grenadeBounceSound(g) {
  if (typeof playRandom !== 'function') return;
  const v = _distVolume(g.pos, 0.55);
  if (v <= 0.02) return;
  playRandom(['weapons/grenade_hit1.wav', 'weapons/grenade_hit2.wav', 'weapons/grenade_hit3.wav'],
             { volume: v });
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
  if (typeof playRandom === 'function')
    playRandom(['weapons/hegrenade-1.wav', 'weapons/hegrenade-2.wav'],
               { volume: Math.max(0.25, _distVolume(g.pos, 1)) });
  _spawnExplosion(g.pos);
  if (typeof enemyRadiusDamage === 'function') enemyRadiusDamage(g.pos, def.damage, def.radius);
}

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
  const tr = traceMove(eye, g.pos);
  if (tr.fraction < 0.92) return;                       // wall between you and the flash → no blind
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const fwd = [-Math.sin(yaw) * cp, Math.cos(yaw) * cp, -sp];
  const facing = (fwd[0] * dx + fwd[1] * dy + fwd[2] * dz) / dist;   // 1 = staring at it
  const prox = Math.max(0, 1 - dist / 1300);            // within ~1300u
  if (prox <= 0) return;
  const face01 = (facing + 1) / 2;                       // 0 (behind) … 1 (ahead)
  const intensity = Math.min(1, prox * (0.35 + 0.65 * face01) + 0.1);
  const duration = 0.4 + prox * (facing > 0.3 ? 5.5 : facing > -0.3 ? 2.2 : 0.7);
  if (intensity > _blind.intensity || duration > _blind.t) {
    _blind.intensity = Math.max(_blind.intensity, intensity);
    _blind.t = Math.max(_blind.t, duration);
    _blind.max = _blind.t;
  }
}

function _detonateSmoke(g) {
  if (typeof playSound === 'function')
    playSound('weapons/sg_explode.wav', { volume: Math.max(0.25, _distVolume(g.pos, 1)) });
  // A cluster of soft billboards forming an expanding, slowly-drifting cloud.
  const puffs = [];
  const N = 14, tex = _getPuffTex();
  for (let i = 0; i < N; i++) {
    const mat = new THREE.SpriteMaterial({ map: tex, color: 0xbfc3c7, transparent: true,
                                           opacity: 0, depthWrite: false, fog: true });
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
  for (const sm of _smokes) for (const s of sm.puffs) scene.remove(s);
  _smokes.length = 0;
  _blind.intensity = 0; _blind.t = 0;
  const el = document.getElementById('flash-overlay'); if (el) el.style.opacity = '0';
}
