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
  scene.traverse(o => { if (o.isMesh && !_shellMeshSet.has(o) && !_decalMeshSet.has(o)) _shellRayTargets.push(o); });
}

// ── Bullet hole / knife mark decals ───────────────────────────────────────
const DECAL_MAX         = 64;
const DECAL_SIZE_BULLET = 14;   // GoldSrc units
const DECAL_SIZE_KNIFE  = 28;   // GoldSrc units (slash mark)
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

const _decalTex = {
  bullet: [1,2,3,4,5].map(i => _loadDecalTex('decals/shot' + i + '.png' + _decalCacheBust)),
  knife:  [0,1,2,3,4].map(s => _makeSlashTexture(s * 1000 + 7)),   // experimental cut marks
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
  const size   = type === 'knife' ? DECAL_SIZE_KNIFE : DECAL_SIZE_BULLET;

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
  if (wpn._ejectionLocal) {
    wpn.root.updateMatrixWorld();
    const vmPos = wpn._ejectionLocal.clone();
    wpn.root.localToWorld(vmPos);
    const [nx, ny] = _vmProjectNDC(vmPos);
    pos = eyePos.clone()
      .addScaledVector(fwd,      SPAWN_DEPTH)
      .addScaledVector(camRight, nx * ar * SPAWN_DEPTH / fy)
      .addScaledVector(camUp,    ny      * SPAWN_DEPTH / fy);
  } else {
    const ejectSign = rightHand ? -1 : 1;
    pos = eyePos.clone()
      .addScaledVector(fwd, SPAWN_DEPTH)
      .addScaledVector(camRight, ejectSign * 5)
      .addScaledVector(camUp, -6);
  }

  // Velocity in camera-local space so shells eject correctly regardless of aim direction
  const ejectSign = rightHand ? -1 : 1;
  const rv = () => (Math.random() - 0.5) * 2;
  const vel = new THREE.Vector3()
    .addScaledVector(camRight, ejectSign * (70 + rv() * 45))
    .addScaledVector(camUp,    75 + rv() * 30)
    .addScaledVector(fwd,      40 + rv() * 35);

  if (_activeShells.length >= SHELLS_MAX) {
    const old = _activeShells.shift();
    scene.remove(old.mesh);
    _shellMeshSet.delete(old.mesh);
  }

  const mesh = new THREE.Mesh(_shellGeos[type], _shellMats[type]);
  mesh.position.copy(pos);
  mesh.rotation.set(Math.random()*Math.PI*2, Math.random()*Math.PI*2, Math.random()*Math.PI*2);
  // no manual scale — model is already in GoldSrc world units
  scene.add(mesh);
  _shellMeshSet.add(mesh);

  _activeShells.push({
    mesh, vel,
    angVel: new THREE.Vector3((rv())*18, (rv())*28, (rv())*18),
    life: 0, bounces: 0, grounded: false,
  });
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

