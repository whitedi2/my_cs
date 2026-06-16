// autotest.js — headless screenshot harness. ACTIVE ONLY with a ?test=… URL param,
// so it never affects normal play. Bypasses pointer lock (fakes isLocked), joins a
// team, applies debug flags, aims at a dummy and optionally holds fire — so a
// `chrome --headless --screenshot` after a virtual-time budget captures a real
// in-game frame (hitboxes, blood, view-model, etc.).
//
// Query flags: ?test=1 &team=ct|t &model=leet|terror|gign &wpn=m4|usp|knife
//   &hitboxes &gore &tp (third person) &fire=1 &yaw=<deg> &pitch=<deg>
(function () {
  const q = new URLSearchParams(location.search);
  if (!q.has('test')) return;

  function ready() {
    return typeof mapReady !== 'undefined' && mapReady &&
           typeof gameAssetsReady === 'function' && gameAssetsReady();
  }

  function begin() {
    if (typeof loadWeaponModels === 'function') loadWeaponModels();
    if (typeof loadEnemy === 'function') loadEnemy();
    const t = setInterval(() => { if (ready()) { clearInterval(t); run(); } }, 150);
  }

  function run() {
    // Join without the menu.
    hasJoined = true; teamStage = null;
    playerModelName = q.get('model') || (q.get('team') === 't' ? 'leet' : 'gign');
    setTeam(q.get('team') === 't' ? 't' : 'ct');
    ownedWeapons.clear(); ['knife', 'usp', 'm4'].forEach(w => ownedWeapons.add(w));
    if (typeof loadPlayerModel === 'function') loadPlayerModel();

    // Stand at the dummy anchor (CT spawn[0]) facing the dummies.
    if (typeof gsSpawn !== 'undefined' && gsSpawn) { gsPos = [...gsSpawn]; }
    yaw   = (q.has('yaw')   ? +q.get('yaw')   * Math.PI / 180 : (typeof gsSpawnYaw !== 'undefined' ? gsSpawnYaw : 0));
    pitch = (q.has('pitch') ? +q.get('pitch') * Math.PI / 180 : 0);

    // Aim precisely at the nearest dummy if present (overrides yaw/pitch).
    if (!q.has('yaw') && typeof enemies !== 'undefined' && enemies[0] && enemies[0].gsPos) {
      const e = enemies[0].gsPos, dx = e[0] - gsPos[0], dy = e[1] - gsPos[1];
      const L = Math.hypot(dx, dy) || 1;
      yaw = Math.atan2(-dx / L, dy / L);
      const eyeH = (typeof SV !== 'undefined') ? SV.eyestand : 64;
      pitch = Math.atan2((e[2] + 50) - (gsPos[2] + eyeH), L);   // ~chest/head height
    }

    const wid = q.get('wpn');
    if (wid) { ownedWeapons.add(wid); const i = WPNS.findIndex(w => w.id === wid); if (i >= 0) switchWeapon(i); }

    if (q.has('hitboxes')) { showHitboxes = true; if (typeof setHitboxDebug === 'function') setHitboxDebug(true); }
    if (q.has('gore'))     { enhancedGore = true; }
    if (q.has('tp') && typeof toggleThirdPerson === 'function') {
      toggleThirdPerson(true);
      if (typeof orbitYaw !== 'undefined') {
        if (q.has('orbit'))  orbitYaw   = yaw + (+q.get('orbit')) * Math.PI / 180;
        if (q.has('orbitP')) orbitPitch = (+q.get('orbitP')) * Math.PI / 180;
      }
    }

    isLocked = true;                 // make the main loop simulate + render the game
    if (q.has('fire')) lmbHeld = true;

    // Keep the muzzle flash lit so a single screenshot can capture it.
    if (q.has('flash')) setInterval(() => {
      const w = (typeof curW === 'function') ? curW() : null;
      if (w && w.type === 'gun' && typeof _showFlash === 'function') _showFlash(w);
    }, 16);

    // Reveal the game HUD and hide the menu overlay (pointerlockchange won't fire here).
    const show = (id, d) => { const el = document.getElementById(id); if (el) el.style.display = d; };
    show('overlay', 'none'); show('gameload', 'none');
    show('crosshair', 'block'); show('hud', 'block'); show('weapon-hud', 'block');
    show('target-hud', 'flex'); show('money', 'block');

    window.__autotestReady = true;   // marker the screenshot script can poll
  }

  begin();
})();
