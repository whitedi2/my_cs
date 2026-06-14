// scene.js — renderer, world/view-model/2D-flash scenes, cameras, muzzle flash.
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── Renderer / Scene ──────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.Fog(0x87CEEB, 2000, 8000);

const camera = new THREE.PerspectiveCamera(73.74, innerWidth / innerHeight, 1, 12000);

// FPS camera hierarchy: scene → yawObj (Y rotation) → pitchObj (X rotation) → camera
// This bypasses all Euler↔Quaternion sync issues in Three.js
const yawObj   = new THREE.Object3D();
const pitchObj = new THREE.Object3D();
pitchObj.add(camera);
yawObj.add(pitchObj);
scene.add(yawObj);

// ── View-model scene (knife, rendered on top of world) ────────────────────
const vmScene  = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(49, innerWidth / innerHeight, 0.1, 200);
vmScene.add(new THREE.AmbientLight(0xffffff, 0.55));
const vmSun = new THREE.DirectionalLight(0xffffff, 0.85);
vmSun.position.set(1.5, 3, 2); vmScene.add(vmSun);
renderer.autoClear = false;

// ── Muzzle flash (2D ortho scene rendered before weapon → weapon on top) ────
let _flashStartT = -Infinity;
const _FLASH_MS  = 55;

function _loadAdditiveSprite(src) {
  const ref = { tex: null };
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx2 = c.getContext('2d');
    ctx2.drawImage(img, 0, 0);
    const d = ctx2.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4)
      d.data[i + 3] = Math.max(d.data[i], d.data[i + 1], d.data[i + 2]);
    ctx2.putImageData(d, 0, 0);
    ref.tex = new THREE.CanvasTexture(c);
  };
  img.src = src;
  return ref;
}

const _mflashFrames = {
  m4:    [0,1,2].map(n => _loadAdditiveSprite(`sprites/muzzleflash3_0${n}.png`)),
  m4sil: [0,1,2].map(n => _loadAdditiveSprite(`sprites/muzzleflash2_0${n}.png`)),
  usp:   [0,1,2].map(n => _loadAdditiveSprite(`sprites/muzzleflash2_0${n}.png`)),
};

// Orthographic 2D flash scene — aspect-ratio aware so square plane = square on screen
const _flashScene2D = new THREE.Scene();
const _flashOrtho   = new THREE.OrthographicCamera(
  -innerWidth/innerHeight, innerWidth/innerHeight, 1, -1, 0, 1
);
const _flashMat2D   = new THREE.MeshBasicMaterial({
  transparent: true,
  blending: THREE.CustomBlending,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneFactor,
  blendEquation: THREE.AddEquation,
  depthTest: false,
  depthWrite: false,
  color: 0xffffff,
});
const _flashMesh2D = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), _flashMat2D);
_flashMesh2D.visible = false;
_flashScene2D.add(_flashMesh2D);

const _muzzleGsTmp = new THREE.Vector3();

// Project vmScene world pos → NDC [-1,1] (mirrors X when rightHand)
function _vmProjectNDC(v) {
  const f  = 1.0 / Math.tan(49 * Math.PI / 360);
  const ar = innerWidth / innerHeight;
  const zv = -v.z;
  let xn   = (v.x / zv) * (f / ar);
  const yn = (v.y / zv) * f;
  if (rightHand) xn = -xn;
  return [xn, yn];
}

function _showFlash(wpn) {
  if (wpn.type !== 'gun') return;
  const key = (wpn.id === 'm4' && wpn.silencer) ? 'm4sil' : wpn.id;
  const frames = _mflashFrames[key] ?? _mflashFrames.usp;
  const frame  = frames[Math.floor(Math.random() * frames.length)];
  if (!frame.tex) return;
  _flashMat2D.map = frame.tex;
  _flashMat2D.needsUpdate = true;

  const silScale = wpn.silencer ? (wpn.flashSilScale ?? 0.45) : 1.0;
  const frac = (0.32 + Math.random() * 0.22) * silScale;
  const sz   = frac * 2;   // NDC units; camera has equal pixel density in x and y
  const ar   = innerWidth / innerHeight;

  if (wpn._muzzleLocal) {
    wpn.root.updateMatrixWorld();
    const vmPos = wpn._muzzleLocal.clone();
    wpn.root.localToWorld(vmPos);
    const [nx, ny] = _vmProjectNDC(vmPos);
    _flashMesh2D.position.set(nx * ar, ny, 0);  // scale x by ar for this camera
  } else {
    _flashMesh2D.position.set(0, -0.1, 0);
  }
  _flashMesh2D.scale.set(sz, sz, 1);
  _flashMesh2D.rotation.z = Math.random() * Math.PI * 2;
  _flashMesh2D.visible = true;
  _flashStartT = performance.now();
}

function _tickFlash() {
  const age = performance.now() - _flashStartT;
  if (age >= _FLASH_MS) { _flashMesh2D.visible = false; return; }
  _flashMesh2D.visible = true;
  _flashMat2D.opacity = 1 - age / _FLASH_MS;
}

