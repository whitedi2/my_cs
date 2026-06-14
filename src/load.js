// load.js — map/asset loading bootstrap (loaded after physics so initPhysics exists).
// Classic script — shares one global scope with the other src/*.js (THREE,
// OBJLoader, MTLLoader are globals set in viewer.html). No imports/exports.

// ── Load assets ───────────────────────────────────────────────────────────
const $load = document.getElementById('loading');
$load.style.display = 'block';

const objPromise = new Promise((res, rej) => {
  // Map lives in maps/ and is self-contained (obj + mtl + maps/textures/).
  // setPath('maps/') makes the .mtl's `textures/…` refs resolve to maps/textures/.
  new MTLLoader().setPath('maps/').load('de_dust2.mtl', mtl => {
    mtl.preload();
    new OBJLoader().setMaterials(mtl).setPath('maps/').load(
      'de_dust2.obj', res,
      xhr => { $load.textContent = `Geometry… ${xhr.total ? Math.round(xhr.loaded/xhr.total*100) : '?'}%`; },
      rej
    );
  });
});

const hullPromise = fetch('maps/de_dust2_hull.json').then(r => r.json());

$load.textContent = 'Loading…';

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
  _rebuildShellRayTargets();

  // ── Init collision + player ───────────────────────────────────────────
  initPhysics(hull);

  $load.style.display = 'none';
  document.getElementById('overlay').style.display = 'flex';

}).catch(err => { $load.textContent = 'Error: ' + err; console.error(err); });

