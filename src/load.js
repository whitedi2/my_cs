// load.js — map loading bootstrap (loaded after physics so initPhysics exists).
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.
//
// The menu shows immediately; the map streams in the background (progress shown
// on the Play button) and becomes the rotating backdrop when ready. Other assets
// (player/weapon models) load at "Start" — see input.js.

let mapReady = false;
const $play = document.getElementById('btn-play');
$play.disabled = true;
$play.textContent = 'Загрузка карты…';

const objPromise = new Promise((res, rej) => {
  // Map lives in maps/ and is self-contained (obj + mtl + maps/textures/).
  // setPath('maps/') makes the .mtl's `textures/…` refs resolve to maps/textures/.
  new MTLLoader().setPath('maps/').load('de_dust2.mtl', mtl => {
    mtl.preload();
    new OBJLoader().setMaterials(mtl).setPath('maps/').load(
      'de_dust2.obj', res,
      xhr => { if (xhr.total) $play.textContent = `Загрузка карты ${Math.round(xhr.loaded / xhr.total * 100)}%`; },
      rej
    );
  });
});

const hullPromise = fetch('maps/de_dust2_hull.json').then(r => r.json());

Promise.all([objPromise, hullPromise]).then(([obj, hull]) => {

  // ── Apply lightmap materials ──────────────────────────────────────────
  obj.traverse(child => {
    if (!child.isMesh) return;
    const old = Array.isArray(child.material) ? child.material[0] : child.material;
    const mat = new THREE.MeshBasicMaterial({
      map: old && old.map ? old.map : null,
      vertexColors: !!child.geometry.attributes.color,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    if (mat.map) { mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping; }
    child.material = mat;
  });
  scene.add(obj);
  frameMenuCamera(new THREE.Box3().setFromObject(obj));   // rotating menu backdrop
  _rebuildShellRayTargets();

  // ── Init collision + player ───────────────────────────────────────────
  initPhysics(hull);

  mapReady = true;
  $play.disabled = false;
  $play.textContent = 'Начать игру';

}).catch(err => { $play.textContent = 'Ошибка загрузки'; console.error(err); });
