// effects.js — shell casings + bullet/knife decals.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── Shell casings ─────────────────────────────────────────────────────────
const SHELLS_MAX  = 12;
const SHELL_LIFE  = 6.0;   // seconds before removal
const SHELL_G     = 800;   // gravity magnitude (GoldSrc units/s²)
const _activeShells  = [];
const _shellMeshSet  = new Set();
const _shellGeos     = {};
const _shellMats     = {};
const _shellRaycaster  = new THREE.Raycaster();
const _shellRayDir     = new THREE.Vector3(0, -1, 0);
const _shellRayOrigin  = new THREE.Vector3();
let   _shellRayTargets = null;   // rebuilt once after map load

function _rebuildShellRayTargets() {
  _shellRayTargets = [];
  // Exclude shells, decals, and the third-person player/weapon rigs (userData
  // .noHitscan) — the latter load before the big map mesh, so without this the
  // bullet/knife ray hits the player's own model and the decal sticks to it.
  scene.traverse(o => {
    if (o.isMesh && !o.userData.noHitscan && !_shellMeshSet.has(o) && !_decalMeshSet.has(o))
      _shellRayTargets.push(o);
  });
}

// ── Bullet hole / knife mark decals ───────────────────────────────────────
const DECAL_MAX         = 64;
const DECAL_SIZE_BULLET = 14;   // GoldSrc units
const DECAL_SIZE_KNIFE  = 28;   // GoldSrc units (slash mark)
const DECAL_SIZE_BLOOD  = 30;   // GoldSrc units (blood splatter)
const _activeDecals     = [];
const _decalMeshSet     = new Set();
const _decalRaycaster   = new THREE.Raycaster();
const _decalRayOrigin   = new THREE.Vector3();
const _decalRayDir      = new THREE.Vector3();
let   _decalRenderOrder = 1;

const _decalTexLoader = new THREE.TextureLoader();
function _loadDecalTex(url) {
  const tex = _decalTexLoader.load(url);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;            // avoid mip-averaged gray square at distance
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const _decalCacheBust = '?v=' + Date.now();   // force fresh PNGs past browser cache

// Procedural knife-slash decal: dark cut strokes on white (white = identity
// under MultiplyBlending, dark = darkens the wall). Each stroke is a filled
// spindle — fat in the middle, tapering to points at both ends — so it reads as
// a real cut rather than a flat line. The decal is oriented to the swing
// direction (see _spawnDecal), not spun randomly.
function _drawTaperedCut(g, x0, y0, x1, y1, sag, maxW, color) {
  const N  = 26;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2 + sag;
  const top = [], bot = [];
  for (let i = 0; i <= N; i++) {
    const t  = i / N, it = 1 - t;
    const px = it*it*x0 + 2*it*t*mx + t*t*x1;
    const py = it*it*y0 + 2*it*t*my + t*t*y1;
    const dx = 2*it*(mx-x0) + 2*t*(x1-mx);
    const dy = 2*it*(my-y0) + 2*t*(y1-my);
    const l  = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    const w  = maxW * Math.pow(Math.sin(Math.PI * t), 0.65) * 0.5;   // 0 at ends, fat mid
    top.push([px + nx*w, py + ny*w]);
    bot.push([px - nx*w, py - ny*w]);
  }
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(top[0][0], top[0][1]);
  for (let i = 1; i < top.length; i++) g.lineTo(top[i][0], top[i][1]);
  for (let i = bot.length - 1; i >= 0; i--) g.lineTo(bot[i][0], bot[i][1]);
  g.closePath();
  g.fill();
}

function _makeSlashTexture(seed) {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
  let r = seed * 9301 + 49297;
  const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
  const cy  = S / 2 + (rnd() - 0.5) * 6;
  const len = S * (0.78 + rnd() * 0.15);
  const x0  = (S - len) / 2, x1 = x0 + len;
  const sag = (rnd() - 0.5) * 7;
  // main cut — single tapered spindle (mid-grey so it darkens the wall gently,
  // matching the bullet decals rather than reading as solid black)
  _drawTaperedCut(g, x0, cy, x1, cy + (rnd() - 0.5) * 4, sag, 3.0 + rnd() * 1.6, 'rgba(78,78,78,1)');
  // occasionally one short, faint nick beside it (kept subtle so it reads as one cut)
  if (rnd() < 0.5) {
    const off = (rnd() - 0.5) * 7;
    _drawTaperedCut(g, x0 + len*0.25, cy + off, x1 - len*0.25, cy + off + (rnd()-0.5)*3,
                    sag * 0.6, 1.0 + rnd() * 0.6, `rgba(120,120,120,${0.3 + rnd()*0.2})`);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace      = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// Procedural blood splat for the wall behind a hit body (enhanced-gore only).
// Red blobs on white → under MultiplyBlending the white is identity and the blobs
// stain the wall red (same scheme as the knife marks).
function _makeBloodSplatTexture(seed) {
  const S = 64, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
  let r = seed * 9301 + 49297;
  const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
  const blob = (x, y, rad, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0.0, `rgba(120,6,6,${a})`);
    gr.addColorStop(0.6, `rgba(150,18,18,${a * 0.8})`);
    gr.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  };
  blob(S/2 + (rnd()-0.5)*6, S/2 + (rnd()-0.5)*6, S * 0.28 * (0.8 + rnd()*0.3), 0.85);
  const k = 4 + Math.floor(rnd() * 4);
  for (let i = 0; i < k; i++) {
    const ang = rnd() * Math.PI * 2, d = S * (0.18 + rnd() * 0.26);
    blob(S/2 + Math.cos(ang)*d, S/2 + Math.sin(ang)*d, S * (0.03 + rnd()*0.06), 0.7 + rnd()*0.25);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}

const _decalTex = {
  bullet: [1,2,3,4,5].map(i => _loadDecalTex('decals/shot' + i + '.png' + _decalCacheBust)),
  knife:  [0,1,2,3,4].map(s => _makeSlashTexture(s * 1000 + 7)),   // experimental cut marks
  blood:  [0,1,2,3].map(s => _makeBloodSplatTexture(s * 1234 + 17)),
};
const _decalMatsCache = {};
const _decalGeo       = new THREE.PlaneGeometry(1, 1);
const _decalZAxis     = new THREE.Vector3(0, 0, 1);
const _decalWorldUp   = new THREE.Vector3(0, 1, 0);

function _getDecalMat(tex) {
  if (!_decalMatsCache[tex.uuid]) {
    // MultiplyBlending: grayscale texture darkens the wall (dark = hole,
    // white = unchanged) — matches GoldSrc gunshot decal rendering.
    _decalMatsCache[tex.uuid] = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending: THREE.MultiplyBlending,
      depthWrite: false, side: THREE.DoubleSide,
      toneMapped: false, fog: false,   // keep white at 1.0 so multiply = identity (no darkened square)
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    });
  }
  return _decalMatsCache[tex.uuid];
}

// type = 'bullet' | 'knife'; raycasts the visual mesh along the current aim
// (matches the camera forward exactly, incl. view kick) so it lands at the crosshair.
// spread = per-shot random cone half-angle (radians), 0 for none.
// roll  = if a number, orient the decal in the wall plane at this angle (cut
//         direction); if undefined, spin it randomly (bullet holes).
function _spawnDecal(type, maxDist, spread, roll) {
  if (!_shellRayTargets || !gsPos) return;

  // Random cone inaccuracy (uniform disc) added on top of the aim
  let dyaw = 0, dpitch = 0;
  if (spread) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    dyaw   = Math.cos(a) * r;
    dpitch = Math.sin(a) * r;
  }

  // Camera world forward: yaw on parent Y, pitch on child X
  const eyeH = SV.eyestand + duckAmount * (SV.eyeduck - SV.eyestand);
  const P    = pitch + punchPitch + recoilPitch + dpitch;
  const Y    = yaw + recoilYaw + dyaw;
  const cp   = Math.cos(P), sp = Math.sin(P);

  _decalRayOrigin.set(gsPos[0], gsPos[2] + eyeH, -gsPos[1]);
  _decalRayDir.set(-cp * Math.sin(Y), sp, -cp * Math.cos(Y)).normalize();
  _decalRaycaster.set(_decalRayOrigin, _decalRayDir);
  _decalRaycaster.far = maxDist;
  const hits = _decalRaycaster.intersectObjects(_shellRayTargets, false);
  if (!hits.length || !hits[0].face) return;

  const hit  = hits[0];
  const norm = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  // Face normal winding is unreliable (DoubleSide mesh) — flip toward the shooter
  if (norm.dot(_decalRayDir) > 0) norm.negate();
  const pos  = hit.point.clone().addScaledVector(norm, 0.5);

  const texArr = _decalTex[type];
  const tex    = texArr[Math.floor(Math.random() * texArr.length)];
  const mat    = _getDecalMat(tex);
  const size   = type === 'knife' ? DECAL_SIZE_KNIFE : type === 'blood' ? DECAL_SIZE_BLOOD : DECAL_SIZE_BULLET;

  const mesh = new THREE.Mesh(_decalGeo, mat);
  mesh.scale.setScalar(size);
  mesh.renderOrder = _decalRenderOrder++;   // newer decals always render on top of older

  if (roll === undefined) {
    // Bullet hole — symmetric, random spin around the surface normal.
    const q = new THREE.Quaternion().setFromUnitVectors(_decalZAxis, norm);
    const r = new THREE.Quaternion().setFromAxisAngle(norm, Math.random() * Math.PI * 2);
    mesh.quaternion.copy(r).multiply(q);
  } else {
    // Knife cut — orient in the wall plane: build a basis from the wall's
    // horizontal (right) and vertical (up), then roll by the swing angle so the
    // cut sits in a consistent plane instead of a random tilt.
    let right = new THREE.Vector3().crossVectors(_decalWorldUp, norm);
    if (right.lengthSq() < 1e-4) right.set(1, 0, 0);   // wall is floor/ceiling
    right.normalize();
    const up = new THREE.Vector3().crossVectors(norm, right).normalize();
    const c = Math.cos(roll), s = Math.sin(roll);
    const rx = right.clone().multiplyScalar(c).addScaledVector(up, s);
    const ry = up.clone().multiplyScalar(c).addScaledVector(right, -s);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(rx, ry, norm));
  }
  mesh.position.copy(pos);

  scene.add(mesh);
  _decalMeshSet.add(mesh);
  _activeDecals.push(mesh);

  if (_activeDecals.length > DECAL_MAX) {
    const old = _activeDecals.shift();
    scene.remove(old);
    _decalMeshSet.delete(old);
  }
}


function _buildShellGeo(data) {
  const m   = data.meshes[0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(m.normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(m.uvs,       2));
  geo.setIndex(m.indices);
  return geo;
}

fetch('models/rshell.json').then(r => r.json()).then(data => {
  _shellGeos.rifle = _buildShellGeo(data);
  _shellMats.rifle = new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load(data.meshes[0].texFile) });
});
fetch('models/pshell.json').then(r => r.json()).then(data => {
  _shellGeos.pistol = _buildShellGeo(data);
  _shellMats.pistol = new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load(data.meshes[0].texFile) });
});

function _ejectShell(wpn) {
  if (wpn.type !== 'gun') return;
  const type = wpn.shellType ?? 'rifle';
  if (!_shellGeos[type] || !_shellMats[type]) return;

  yawObj.updateMatrixWorld(true);
  const eyePos  = new THREE.Vector3();
  camera.getWorldPosition(eyePos);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);

  // Camera basis in world space for unprojection
  const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const camUp    = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const fy = camera.projectionMatrix.elements[5];  // focal_y = 1/tan(fovY/2)
  const ar = innerWidth / innerHeight;
  const SPAWN_DEPTH = 8;   // spawn close to player — shells appear large at birth, shrink as they fly away

  // Spawn at the ejection port's screen position, unprojected to world space.
  // _vmProjectNDC returns the same screen NDC as the world camera projection,
  // so we can use it to find the matching world position at SPAWN_DEPTH.
  let pos;
  // Shell port comes from the MDL attachment 1 (wpn._ejectionLocal). If it isn't
  // resolved, skip the shell rather than ejecting from a guessed offset.
  if (!wpn._ejectionLocal) return;
  wpn.root.updateMatrixWorld();
  const vmPos = wpn._ejectionLocal.clone();
  wpn.root.localToWorld(vmPos);
  const [nx, ny] = _vmProjectNDC(vmPos);
  pos = eyePos.clone()
    .addScaledVector(fwd,      SPAWN_DEPTH)
    .addScaledVector(camRight, nx * ar * SPAWN_DEPTH / fy)
    .addScaledVector(camUp,    ny      * SPAWN_DEPTH / fy);

  // Velocity in camera-local space so shells eject correctly regardless of aim direction
  const ejectSign = rightHand ? -1 : 1;
  const rv = () => (Math.random() - 0.5) * 2;
  const vel = new THREE.Vector3()
    .addScaledVector(camRight, ejectSign * (70 + rv() * 45))
    .addScaledVector(camUp,    75 + rv() * 30)
    .addScaledVector(fwd,      40 + rv() * 35);

  _spawnShell(type, pos, vel);
}

// Spawn a shell mesh at a world position with a world velocity. Shared by the
// first-person eject (camera-space) and the third-person eject (from the model).
function _spawnShell(type, pos, vel) {
  if (!_shellGeos[type] || !_shellMats[type]) return;
  if (_activeShells.length >= SHELLS_MAX) {
    const old = _activeShells.shift();
    scene.remove(old.mesh);
    _shellMeshSet.delete(old.mesh);
  }
  const mesh = new THREE.Mesh(_shellGeos[type], _shellMats[type]);
  mesh.position.copy(pos);
  mesh.rotation.set(Math.random()*Math.PI*2, Math.random()*Math.PI*2, Math.random()*Math.PI*2);
  scene.add(mesh);
  _shellMeshSet.add(mesh);
  const rv = () => (Math.random() - 0.5) * 2;
  _activeShells.push({
    mesh, vel,
    angVel: new THREE.Vector3(rv()*18, rv()*28, rv()*18),
    life: 0, bounces: 0, grounded: false,
  });
}

// ── Blood (dummy hits) ──────────────────────────────────────────────────────
// Two modes, pooled camera-facing sprites either way; amount scales with the HP
// damage dealt (unarmored headshot sprays hard, armored body hit barely bleeds):
//   • default       — original GoldSrc blood sprites (bloodspray.spr animated puff
//                      + blood/blooddrop droplets, grayscale tinted red like the engine).
//   • "Улучшенный урон" (enhancedGore) — our procedural radial-gradient spray + mist.
const BLOOD_MAX = 90;
const BLOOD_G   = 600;
const _bloodPool = [];
const _ZEROV = new THREE.Vector3();

// Original sprite frames (extracted by tools/extract_spr.py from valve/sprites).
// The sprites are grayscale (the engine tints them with the blood color); we bake
// the red in per-pixel at load so the tint never depends on material.color.
function _bloodSpr(name) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const img = new Image();
  img.onload = () => {
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height), a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      // Grayscale → saturated blood red. Floor the red high so dark source pixels
      // (e.g. blooddrop ≈ 11) don't read as near-black; green/blue stay tiny.
      const k = ((a[i] + a[i + 1] + a[i + 2]) / 3) / 255;
      a[i] = Math.min(255, 150 + 105 * k); a[i + 1] = Math.round(16 * k); a[i + 2] = Math.round(16 * k);
    }
    g.putImageData(d, 0, 0);
    tex.needsUpdate = true;
  };
  img.src = 'sprites/' + name + '.png';
  return tex;
}
const _spraySprFrames = Array.from({ length: 10 }, (_, i) => _bloodSpr('bloodspray_0' + i));
const _dropSprTex     = ['blood_03', 'blood_05', 'blooddrop_00', 'blooddrop_01'].map(_bloodSpr);

// Procedural (enhanced) soft droplet.
function _makeBloodTexture() {
  const S = 64, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
  grad.addColorStop(0.0, 'rgba(140,2,2,1)');
  grad.addColorStop(0.55, 'rgba(110,0,0,0.85)');
  grad.addColorStop(1.0, 'rgba(80,0,0,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(S/2, S/2, S/2, 0, Math.PI*2); g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const _bloodTex = _makeBloodTexture();

function _newBloodParticle() {
  const mat = new THREE.SpriteMaterial({
    map: null, color: 0xaa0000, transparent: true,
    depthWrite: false, fog: false, toneMapped: false, opacity: 1,
  });
  const sp = new THREE.Sprite(mat);
  sp.visible = false; sp.frustumCulled = false;
  scene.add(sp);
  const p = { sprite: sp, mat, active: false, vel: new THREE.Vector3(),
              life: 0, ttl: 0, s0: 1, s1: 1, grow: false, gravity: false, fade: 1, frames: null };
  _bloodPool.push(p);
  return p;
}

function _getBloodParticle() {
  for (const p of _bloodPool) if (!p.active) return p;
  if (_bloodPool.length < BLOOD_MAX) return _newBloodParticle();
  let oldest = _bloodPool[0];                 // recycle the longest-lived one
  for (const p of _bloodPool) if (p.life > oldest.life) oldest = p;
  return oldest;
}

// Configure & launch one pooled particle.
function _emitBlood(cfg) {
  const p = _getBloodParticle();
  p.sprite.position.copy(cfg.pos);
  p.vel.copy(cfg.vel || _ZEROV);
  p.life = 0; p.ttl = cfg.ttl;
  p.frames = cfg.frames || null;
  p.grow = !!cfg.grow; p.gravity = !!cfg.gravity;
  p.s0 = cfg.s0; p.s1 = cfg.s1 != null ? cfg.s1 : cfg.s0;
  p.fade = cfg.fade != null ? cfg.fade : 1;
  p.mat.map = p.frames ? p.frames[0] : cfg.tex;
  p.mat.color.setHex(cfg.color != null ? cfg.color : 0xffffff);   // red is baked into the textures
  p.mat.alphaTest = cfg.alphaTest || 0;
  p.mat.opacity = p.fade; p.mat.rotation = cfg.rot || 0; p.mat.needsUpdate = true;
  p.sprite.scale.setScalar(p.s0);
  p.sprite.visible = true; p.active = true;
}

const _backV = new THREE.Vector3();
function _bloodBack(dir) {   // unit vector back toward the shooter
  if (dir) _backV.copy(dir).multiplyScalar(-1); else _backV.set(0, 0, -1);
  return _backV;
}

// Original GoldSrc-style: an animated bloodspray puff + a few falling droplets.
function _spawnBloodOriginal(pos, dir, dmg, hg) {
  const head = hg === 1;
  const back = _bloodBack(dir).clone();
  _emitBlood({
    pos, vel: back.clone().multiplyScalar(14).setY(18),
    ttl: 0.26 + Math.random() * 0.1, frames: _spraySprFrames, grow: true,
    s0: head ? 7 : 4, s1: (head ? 22 : 13) + dmg * 0.06,
    alphaTest: 0.3, rot: Math.random() * 6.28,
  });
  const n = Math.max(2, Math.min(14, Math.round(1 + dmg / 10)));
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(
      back.x + (Math.random() - 0.5), back.y + 0.2 + Math.random() * 0.5, back.z + (Math.random() - 0.5),
    ).normalize().multiplyScalar(50 + Math.random() * 110 + (head ? 60 : 0));
    _emitBlood({
      pos, vel: v, ttl: 0.3 + Math.random() * 0.3, gravity: true,
      tex: _dropSprTex[(Math.random() * _dropSprTex.length) | 0],
      s0: 2 + Math.random() * 2.4, alphaTest: 0.3,
    });
  }
}

// Our procedural version: a denser soft spray + a mist puff.
function _spawnBloodEnhanced(pos, dir, dmg, hg) {
  const head = hg === 1;
  const back = _bloodBack(dir).clone();
  const n = Math.max(2, Math.min(22, Math.round(2 + dmg / 8)));
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(
      back.x + (Math.random() - 0.5) * 1.2, back.y + 0.3 + Math.random() * 0.7, back.z + (Math.random() - 0.5) * 1.2,
    ).normalize().multiplyScalar(55 + Math.random() * 120 + (head ? 70 : 0));
    _emitBlood({
      pos, vel: v, ttl: 0.35 + Math.random() * 0.3, gravity: true, tex: _bloodTex,
      s0: 1.4 + Math.random() * 2.2 + (head ? 1.4 : 0), color: 0xaa0000,
    });
  }
  const base = (head ? 13 : 8);
  _emitBlood({ pos, vel: back.clone().multiplyScalar(18), ttl: 0.2, tex: _bloodTex,
    grow: true, s0: base * 0.5, s1: base * 1.8, color: 0x880000, fade: 0.55 });
}

// pos: world hit point; dir: bullet travel direction (eye→target); dmg: HP damage; hg: hitgroup.
function _spawnBlood(pos, dir, dmg, hg) {
  if (!(dmg > 0)) return;
  if (typeof enhancedGore !== 'undefined' && enhancedGore) _spawnBloodEnhanced(pos, dir, dmg, hg);
  else _spawnBloodOriginal(pos, dir, dmg, hg);
}

function _updateBlood(dt) {
  for (const p of _bloodPool) {
    if (!p.active) continue;
    p.life += dt;
    if (p.life >= p.ttl) { p.active = false; p.sprite.visible = false; continue; }
    const t = p.life / p.ttl;
    if (p.frames) {
      const fi = Math.min(p.frames.length - 1, (t * p.frames.length) | 0);
      if (p.mat.map !== p.frames[fi]) { p.mat.map = p.frames[fi]; p.mat.needsUpdate = true; }
    }
    if (p.gravity) p.vel.y -= BLOOD_G * dt;
    p.sprite.position.addScaledVector(p.vel, dt);
    p.sprite.scale.setScalar(p.grow ? (p.s0 + (p.s1 - p.s0) * t) : p.s0 * (1 - 0.3 * t));
    p.mat.opacity = p.fade * (p.grow ? (1 - t) : (1 - t * t));
  }
}

function _updateShells(dt) {
  const floorApprox = yawObj.position.y - SV.eyestand;

  for (let i = _activeShells.length - 1; i >= 0; i--) {
    const s = _activeShells[i];
    s.life += dt;
    if (s.life > SHELL_LIFE) {
      scene.remove(s.mesh);
      _shellMeshSet.delete(s.mesh);
      _activeShells.splice(i, 1);
      continue;
    }
    if (s.grounded) continue;

    s.vel.y -= SHELL_G * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    s.mesh.rotation.x += s.angVel.x * dt;
    s.mesh.rotation.y += s.angVel.y * dt;
    s.mesh.rotation.z += s.angVel.z * dt;

    if (s.vel.y < 0) {
      // Determine floor once per shell via single downward raycast
      if (s.groundY === undefined && s.mesh.position.y < floorApprox + 150) {
        if (_shellRayTargets) {
          _shellRayOrigin.copy(s.mesh.position).y += 10;
          _shellRaycaster.set(_shellRayOrigin, _shellRayDir);
          const hits = _shellRaycaster.intersectObjects(_shellRayTargets, false);
          s.groundY = hits.length ? hits[0].point.y : floorApprox;
        } else {
          s.groundY = floorApprox;
        }
      }
      const groundY = s.groundY ?? floorApprox;
      if (s.mesh.position.y <= groundY + 1) {
        s.mesh.position.y = groundY;
        s.bounces++;
        const restitution = 0.4 - s.bounces * 0.08;
        if (restitution > 0.05 && s.bounces < 4) {
          s.vel.y  = Math.abs(s.vel.y) * restitution;
          s.vel.x *= 0.75;
          s.vel.z *= 0.75;
          s.angVel.multiplyScalar(0.55);
        } else {
          s.grounded = true;
          s.vel.set(0, 0, 0);
          s.angVel.set(0, 0, 0);
        }
      }
    }
  }
}

