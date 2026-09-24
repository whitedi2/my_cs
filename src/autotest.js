// autotest.js — headless harness. ACTIVE ONLY with a ?test=… URL param, so it never
// affects normal play. Bypasses pointer lock (fakes isLocked), joins a team, applies
// debug flags, aims at a dummy — so a headless Chrome run drives the REAL game.
//
// Two modes:
//   1. SCREENSHOT — `chrome --headless --screenshot` after a virtual-time budget
//      captures a real in-game frame (hitboxes, blood, view-model, …).  tools/shot.sh
//   2. SCENARIO   — `&scenario=<name>` scripts a usercmd timeline (hold/tap/mouse/fire),
//      records a per-frame state trace into window.__autotestLog and dumps it as JSON
//      into <pre id="autotest-out">, so `chrome --headless --dump-dom` can read it back
//      and assert on client physics/weapons numerically.  tools/client_test.js
//
// Query flags: ?test=1 &team=ct|t &model=leet|terror|gign &wpn=m4|usp|knife
//   &hitboxes &gore &tp (third person) &fire=1 &yaw=<deg> &pitch=<deg>
//   &scenario=<name> &settle=<s> &dur=<s> &pos=x,y,z
(function () {
  const q = new URLSearchParams(location.search);
  if (!q.has('test')) return;

  const scenarioName = q.get('scenario') || null;
  // Real-time milestones (ms since the script loaded) — shows whether a slow run is
  // asset loading, the pump, or Chrome winding down after it.
  const T0 = Date.now();
  const timing = { ready: null, pump: null, done: null };

  // ── Scripted scenarios ─────────────────────────────────────────────────────
  // tl = [[t seconds, action], …], t relative to the end of the settle period.
  //   hold: [...KeyboardEvent.code]  — the FULL set of held keys (replaces the previous set)
  //   tap:  'KeyR'                   — one-shot keydown+keyup (runs the real handlers)
  //   lmb / rmb: true|false          — mouse button down/up (real events)
  //   look: [yawDeg, pitchDeg]       — absolute view angles
  //   mouse: [dYawDeg, dPitchDeg]    — one-frame mouse delta (via pendingYaw/pendingPitch)
  const SCENARIOS = {
    // ── movement ──
    walk:      { waitFor: 'ground', wpn: 'knife', dur: 2.5, tl: [[0, { hold: ['KeyW'] }], [2.0, { hold: [] }]] },
    walk_m4:   { waitFor: 'ground', wpn: 'm4',    dur: 2.5, tl: [[0, { hold: ['KeyW'] }], [2.0, { hold: [] }]] },
    shiftwalk: { waitFor: 'ground', wpn: 'knife', dur: 2.5, tl: [[0, { hold: ['KeyW', 'ShiftLeft'] }], [2.0, { hold: [] }]] },
    strafe:    { waitFor: 'ground', wpn: 'knife', dur: 2.0, tl: [[0, { hold: ['KeyD'] }], [1.6, { hold: [] }]] },
    duck:      { waitFor: 'ground', wpn: 'knife', dur: 2.5, tl: [[0, { hold: ['ControlLeft'] }], [0.6, { hold: ['ControlLeft', 'KeyW'] }], [2.0, { hold: [] }]] },
    jump:      { waitFor: 'ground', wpn: 'knife', dur: 2.0, tl: [[0.3, { hold: ['Space'] }], [0.35, { hold: [] }]] },
    // ── weapons ──
    fire:      { wpn: 'm4',    dur: 2.5, tl: [[0.3, { lmb: true }], [1.3, { lmb: false }]] },
    // USP is semi-auto — holding the trigger gives ONE shot, so the clip has to be
    // emptied with real clicks (which also exercises the queued-click buffer).
    dryfire:   { wpn: 'usp',   dur: 9.0, tl: (() => { const tl = []; for (let i = 0; i < 14; i++) { const t = 0.3 + i * 0.35; tl.push([t, { lmb: true }], [t + 0.12, { lmb: false }]); } return tl; })() },
    reload:    { wpn: 'm4',    dur: 5.0, tl: [[0.2, { lmb: true }], [0.6, { lmb: false }], [1.0, { tap: 'KeyR' }]] },
    switch:    { wpn: 'knife', dur: 4.0, tl: [[0.5, { tap: 'Digit1' }], [1.8, { tap: 'Digit2' }], [3.0, { tap: 'Digit3' }]] },
    silencer:  { wpn: 'usp',   dur: 4.0, tl: [[0.5, { tap: 'KeyF' }]] },
    // ── knife (ReGameDLL CKnife: slash 0.35 miss / 0.4 hit; stab 1.0 / 1.1; stab after a slash waits 0.5) ──
    knife:     { wpn: 'knife', dur: 2.2, tl: [[0.0, { lmb: true }], [2.0, { lmb: false }]] },
    knife_mix: { wpn: 'knife', dur: 3.0, tl: [[0.0, { lmb: true }], [0.04, { lmb: false }], [0.1, { rmb: true }], [2.8, { rmb: false }]] },
    // ── fall damage: small lift + a downward kick (de_dust2's sky is only ~170 u above the spawns,
    //    too low to reach a damaging speed by gravity alone); FlPlayerFallDamage only reads the
    //    touchdown speed, so the source of that speed doesn't matter ──
    // ── AWP (ReGameDLL CAWP): no-scope shot +0.08 cone; zoom 90→40→10 with 0.3 s between steps and
    //    locked for the 1.45 s cycle after a shot; a scoped shot drops to 90 and re-zooms at cycle end ──
    awp:       { wpn: 'awp', dur: 4.6, tl: [
      [0.00, { lmb: true }], [0.04, { lmb: false }],   // no-scope shot
      [0.50, { rmb: true }], [0.52, { rmb: false }],    // RMB mid-cycle → must be ignored
      [1.60, { rmb: true }], [1.62, { rmb: false }],    // → 40
      [1.70, { rmb: true }], [1.72, { rmb: false }],    // < 0.3 s later → ignored
      [2.00, { rmb: true }], [2.02, { rmb: false }],    // → 10
      [2.40, { lmb: true }], [2.44, { lmb: false }],    // scoped shot → 90, back to 10 at ~3.85
    ] },
    // reload ready at AWP_RELOAD_TIME 2.5 while the 2.93 s anim plays on; a shot in that tail fires
    awp_reload: { wpn: 'awp', dur: 4.8, tl: [
      [0.0, { lmb: true }], [0.04, { lmb: false }],
      [1.6, { tap: 'KeyR' }],
      [4.2, { lmb: true }], [4.24, { lmb: false }],   // ready (1.6+2.5=4.1) but anim runs to ~4.53
    ] },
    // HE thrown level (spawn angle faces open space): (90+10)·6 = 600 u/s at 10° up, fuse 1.5 s
    nade:      { wpn: 'hegrenade', nades: { hegrenade: 1 }, dur: 2.4, tl: [[0.0, { lmb: true }], [0.2, { lmb: false }]] },
    // ammo packs (',' primary / '.' secondary) — ReGameDLL BuyGunAmmo, one calibre pack per press
    ammo:      { wpn: 'm4', phase: 'buy', money: 1000, dur: 0.9, tl: [
      [0.0, { setReserve: { m4: 0, usp: 90 } }],
      [0.1, { tap: 'Comma' }], [0.2, { tap: 'Comma' }], [0.3, { tap: 'Comma' }],
      [0.4, { tap: 'Comma' }],                            // full (90) → refused, no charge
      [0.5, { tap: 'Period' }],                           // USP 90 → 100 (+10 of a 12 pack, full $25)
      [0.6, { tap: 'Period' }],                           // full → refused
    ] },
    awp_speed: { wpn: 'awp', dur: 3.4, tl: [
      [0.0, { hold: ['KeyW'] }], [1.1, { hold: [] }],   // unscoped: cap 210
      [1.6, { rmb: true }], [1.62, { rmb: false }],     // scope in
      [1.9, { hold: ['KeyW'] }], [3.1, { hold: [] }],   // scoped: cap 150
    ] },
    fall:      { waitFor: 'ground', wpn: 'knife', dur: 1.5, tl: [[0.0, { lift: 60, vz: -700 }]] },
  };

  // ── Output plumbing (read back by tools/client_test.js via --dump-dom) ─────
  const errors = [];
  const pushErr = m => { if (errors.length < 40) errors.push(String(m)); };
  addEventListener('error', e => pushErr('onerror: ' + (e.message || e.error)));
  addEventListener('unhandledrejection', e => pushErr('reject: ' + ((e.reason && e.reason.message) || e.reason)));
  const _origConsoleError = console.error.bind(console);
  console.error = (...a) => { pushErr('console.error: ' + a.map(String).join(' ')); _origConsoleError(...a); };

  function emit(obj) {
    obj.errors = errors;
    let el = document.getElementById('autotest-out');
    if (!el) { el = document.createElement('pre'); el.id = 'autotest-out'; el.style.display = 'none'; document.body.appendChild(el); }
    el.textContent = '#AUTOTEST#' + JSON.stringify(obj) + '#/AUTOTEST#';
    window.__autotestOut  = obj;
    window.__autotestDone = true;
    document.title = 'AUTOTEST_DONE';
  }
  // A scenario that never finishes (asset failure, exception) still reports something.
  if (scenarioName) setTimeout(() => {
    if (!window.__autotestDone) emit({ scenario: scenarioName, ok: false, why: 'timeout: scenario never finished', samples: window.__autotestLog || [] });
  }, 120000);

  function ready() {
    return typeof mapReady !== 'undefined' && mapReady &&
           typeof gameAssetsReady === 'function' && gameAssetsReady();
  }

  function begin() {
    if (typeof loadWeaponModels === 'function') loadWeaponModels();
    if (typeof loadEnemy === 'function') loadEnemy();
    const t = setInterval(() => { if (ready()) { clearInterval(t); timing.ready = Date.now() - T0; run(); } }, 150);
  }

  function run() {
    const sc = scenarioName ? SCENARIOS[scenarioName] : null;
    if (scenarioName && !sc) { emit({ scenario: scenarioName, ok: false, why: 'unknown scenario' }); return; }

    // Join without the menu.
    hasJoined = true; teamStage = null;
    playerModelName = q.get('model') || (q.get('team') === 't' ? 'leet' : 'gign');
    setTeam(q.get('team') === 't' ? 't' : 'ct');
    ownedWeapons.clear(); ['knife', 'usp', 'm4'].forEach(w => ownedWeapons.add(w));
    if (typeof loadPlayerModel === 'function') loadPlayerModel();

    // Stand at the dummy anchor (CT spawn[0]) facing the dummies.
    if (typeof gsSpawn !== 'undefined' && gsSpawn) { gsPos = [...gsSpawn]; }
    if (q.has('pos')) { const p = q.get('pos').split(',').map(Number); if (p.length === 3 && p.every(isFinite)) gsPos = p; }
    yaw   = (q.has('yaw')   ? +q.get('yaw')   * Math.PI / 180 : (typeof gsSpawnYaw !== 'undefined' ? gsSpawnYaw : 0));
    pitch = (q.has('pitch') ? +q.get('pitch') * Math.PI / 180 : 0);

    // Aim precisely at the nearest dummy if present (overrides yaw/pitch).
    // Scenarios keep the spawn angle instead — it faces open space, so a movement
    // script gets room to run before it walks into anything.
    if (!sc && !q.has('yaw') && typeof enemies !== 'undefined' && enemies[0] && enemies[0].gsPos) {
      const e = enemies[0].gsPos, dx = e[0] - gsPos[0], dy = e[1] - gsPos[1];
      const L = Math.hypot(dx, dy) || 1;
      yaw = Math.atan2(-dx / L, dy / L);
      const eyeH = (typeof SV !== 'undefined') ? SV.eyestand : 64;
      pitch = Math.atan2((e[2] + 50) - (gsPos[2] + eyeH), L);   // ~chest/head height
    }

    if (sc && sc.nades && typeof grenadeCounts !== 'undefined')
      for (const [k, n] of Object.entries(sc.nades)) { grenadeCounts[k] = n; ownedWeapons.add(k); }
    if (sc && sc.phase && typeof roundPhase !== 'undefined') roundPhase = sc.phase;   // e.g. 'buy' so purchases are open
    if (sc && sc.money != null && typeof playerMoney !== 'undefined') playerMoney = sc.money;
    const wid = q.get('wpn') || (sc && sc.wpn);
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
    show('money', 'block');

    window.__autotestReady = true;   // marker the screenshot script can poll
    if (sc) drive(scenarioName, sc);
  }

  // ── Scenario driver ────────────────────────────────────────────────────────
  // Wraps the global `animate` so scripted input lands BEFORE the frame simulates and
  // the state sample is taken AFTER it. (`function animate` is a window property, and
  // the loop's own `requestAnimationFrame(animate)` resolves that property — so
  // reassigning it keeps the wrapper installed for every later frame.)
  function drive(name, sc) {
    // The timeline starts when the game is actually READY, not after a fixed wait:
    // the player has to be standing on the floor and the weapon out of its draw
    // animation (ws IDLE), or a scripted click lands while the gun is still coming up
    // and is silently dropped. `settle` is the minimum; 8 s of game time is the bail-out.
    const settle = q.has('settle') ? +q.get('settle') : 0.3;
    const dur    = q.has('dur')    ? +q.get('dur')    : sc.dur;
    const log  = window.__autotestLog = [];
    const held = new Set();
    let t0 = null, gameT = 0, lastDt = 0, idx = 0, finished = false;
    let started = false, startT = 0;
    const settleTrace = [];   // [gameT, ws, onGround] while waiting to start — shows why a settle dragged

    const setHeld = codes => {
      const want = new Set(codes);
      for (const c of held) if (!want.has(c)) { keys[c] = false; held.delete(c); }
      for (const c of want) { keys[c] = true; held.add(c); }
    };
    const tap = code => {
      keys[code] = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      setTimeout(() => { document.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); keys[code] = false; }, 30);
    };
    const mouseBtn = (button, down) =>
      document.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', { button, bubbles: true }));

    function apply(a) {
      if (a.hold)  setHeld(a.hold);
      if (a.tap)   tap(a.tap);
      if ('lmb' in a) mouseBtn(0, a.lmb);
      if ('rmb' in a) mouseBtn(2, a.rmb);
      if (a.look)  { yaw = a.look[0] * Math.PI / 180; pitch = a.look[1] * Math.PI / 180; }
      if (a.mouse) { pendingYaw += a.mouse[0] * Math.PI / 180; pendingPitch += a.mouse[1] * Math.PI / 180; }
      // lift: teleport straight up by N units at rest (a scripted drop; the pump then simulates the fall)
      if (a.setReserve) for (const [id, n] of Object.entries(a.setReserve)) { const g = WPNS.find(x => x.id === id); if (g) g.reserve = n; }
      if (a.lift)  { gsPos = [gsPos[0], gsPos[1], gsPos[2] + a.lift]; vel = [0, 0, a.vz || 0]; onGround = false; }
    }

    function sample(t) {
      const w = (typeof curW === 'function') ? curW() : null;
      const r = n => +(+n).toFixed(4);
      return {
        t: r(t), dt: r(lastDt),
        pos: gsPos.map(r), vel: vel.map(r),
        spd: r(Math.hypot(vel[0], vel[1])),
        ground: !!onGround,
        duck: r(duckAmount), ducked: !!phyDucked,
        yaw: r(yaw), pitch: r(pitch),
        ws, wsT: r(typeof wsT !== 'undefined' ? wsT : 0), vm: !!(w && w.root),
        wpn: w ? w.id : null,
        ammo: (w && w.ammo    !== undefined) ? w.ammo    : null,
        res:  (w && w.reserve !== undefined) ? w.reserve : null,
        sil:  w ? !!w.silencer : false,
        hp: (typeof playerHealth !== 'undefined') ? playerHealth : null,
        ar: (typeof playerArmor  !== 'undefined') ? playerArmor  : null,
        rp: r(recoilPitch), ry: r(recoilYaw), roll: r(punchRoll),
        // gameplay eye (shot/throw origin) and the rendered camera height, GoldSrc Z
        eyeZ: (typeof playerEyeH === 'function') ? r(gsPos[2] + playerEyeH()) : null,
        camZ: (typeof smoothCamY === 'number') ? r(smoothCamY) : null,
        fov: (typeof scopeFov === 'function') ? (scopeFov() || 90) : 90,   // scope FOV (90 = unscoped)
        spr: (w && w._lastSpread != null) ? r(w._lastSpread) : null,       // last shot's cone
        seq: (w && w.anim) ? (w.anim._evSeqName || null) : null,          // view-model sequence playing
        // first live grenade (solo: the real one; its fuse runs in updateGrenades)
        money: (typeof playerMoney !== 'undefined') ? playerMoney : null,
        rsv: (typeof WPNS !== 'undefined' && typeof ownedWeapons !== 'undefined')
          ? Object.fromEntries(WPNS.filter(x => x.type === 'gun' && ownedWeapons.has(x.id)).map(x => [x.id, x.reserve])) : null,
        nades: (typeof _grenadesInAir !== 'undefined') ? _grenadesInAir.length : 0,
        nade: (typeof _grenadesInAir !== 'undefined' && _grenadesInAir[0])
          ? { pos: _grenadesInAir[0].pos.map(r), vel: _grenadesInAir[0].vel.map(r), rest: !!_grenadesInAir[0].resting,
              fuse: r(_grenadesInAir[0].fuse) } : null,
        gap: (typeof xhairGap !== 'undefined') ? r(xhairGap) : null,
        vmod: (typeof velMod !== 'undefined') ? r(velMod) : 1,
      };
    }

    function finish(why) {
      if (finished) return;
      finished = true;
      setHeld([]); mouseBtn(0, false); mouseBtn(2, false);
      const first = log[0] || null, last = log[log.length - 1] || null;
      // Ship the numbers the behaviour is supposed to obey, so the asserter can check
      // "does the game actually honour its own (ReGameDLL-sourced) config" instead of
      // hardcoding constants in a second place that can drift.
      const w = (typeof curW === 'function') ? curW() : null;
      emit({
        scenario: name, ok: !why, why: why || null,
        cfg: (typeof CONFIG !== 'undefined') ? CONFIG : null,
        wcfg: w ? {
          id: w.id, type: w.type, maxSpeed: w.maxSpeed, maxAmmo: w.maxAmmo,
          fireInterval: w.fireInterval, reloadTime: w.reloadTime, recoilP: w.recoilP,
        } : null,
        settle, settledAt: +startT.toFixed(3), settleTrace, vmWaitMs,
        timing: Object.assign({}, timing, { done: Date.now() - T0 }), dur, wpn: sc.wpn || null, frames: log.length,
        fps: (log.length && last) ? +(log.length / Math.max(last.t, 1e-6)).toFixed(1) : 0,
        start: first, end: last,
        samples: log,
      });
    }

    // Scenarios assert on numbers, not pixels — and the headless GPU is SwiftShader, a
    // MULTI-THREADED software rasteriser that saturates every core drawing de_dust2. So
    // stub the draw calls out: the whole game still simulates (physics, weapon state,
    // animation, raycasts — none of it reads back from the framebuffer), it just doesn't
    // paint. Pass &norender=0 to keep the picture (e.g. to eyeball a scenario live).
    if (q.get('norender') !== '0' && typeof renderer !== 'undefined' && renderer) {
      const noop = () => {};
      renderer.render = noop; renderer.clear = noop; renderer.clearDepth = noop;
    }

    // Give the weapon model a moment to land before pumping: updateWeapon() bails out on
    // `!wpn.root`, so the weapon state machine is frozen until it does. Note this is NOT a
    // real-time wait — under --virtual-time-budget timers fire as fast as the clock can be
    // advanced — it just yields a bounded number of turns to the loaders. The rest of the
    // settling (deploy animation, landing on the floor) happens inside the pump below,
    // before the timeline clock starts, so it costs game time rather than wall time.
    let vmWaitMs = 0;
    (function waitForWeapon() {
      const w = (typeof curW === 'function') ? curW() : null;
      if ((w && w.root) || vmWaitMs >= 2000) { startPump(); return; }
      vmWaitMs += 50;
      setTimeout(waitForWeapon, 50);
    })();

    function startPump() {
      timing.pump = Date.now() - T0;
      const hz     = q.has('hz') ? +q.get('hz') : 50;          // a normal client tick
      const stepMs = 1000 / Math.max(1, Math.min(100, hz));
      const orig = window.animate;
      window.animate = function (t) {
        if (t0 === null) t0 = t;
        const dt = lastDt = Math.min((t - t0) / 1000, 0.05);
        t0 = t; gameT += dt;
        if (!started) {
          if (settleTrace.length < 200 && (!settleTrace.length || gameT - settleTrace[settleTrace.length - 1][0] >= 0.25))
            settleTrace.push([+gameT.toFixed(2), ws, !!onGround]);
          // Weapon scripts also need the skeletal anim JSON (multi-MB, streams in after the
          // mesh): until it lands applySkeletalAnimation() returns early, so draw/reload/
          // silencer never report "anim done" and only their long fallback timers end them.
          const cw = (typeof curW === 'function') ? curW() : null;
          const animReady = !!(cw && cw.anim && cw.anim.bones && cw.anim.seqs);
          const need = (sc.waitFor === 'ground') || (ws === 0 /* WS.IDLE */ && animReady);
          if (gameT >= 60 || (gameT >= settle && onGround && need)) { started = true; startT = gameT; }
        }
        const tt = started ? gameT - startT : -1;
        if (!finished && tt >= 0) {
          try { while (idx < sc.tl.length && sc.tl[idx][0] <= tt) apply(sc.tl[idx++][1]); }
          catch (e) { pushErr('apply: ' + e.message); }
        }
        // Pin the game's own frame clock to the pump step. A real rAF callback that was
        // already queued when the pump took over still fires once with a REAL timestamp
        // (behind our synthetic one) and leaves `lastT` off; re-anchoring every frame
        // keeps each pumped frame at exactly 1/hz.
        lastT = t - stepMs;
        orig(t);
        if (!finished && tt >= 0) {
          try {
            log.push(sample(tt));
            if (tt >= dur) finish(null);
          } catch (e) { pushErr('sample: ' + e.message); finish('sample threw: ' + e.message); }
        }
      };

      // ── Deterministic pump ───────────────────────────────────────────────────
      // Headless frame timing is useless for a physics script: SwiftShader draws a few
      // frames per second, and Chrome's virtual clock jumps between them, so "2 seconds
      // of walking" came out as ~20 wildly-spaced frames. So take over rAF and drive the
      // loop ourselves with synthetic timestamps at a fixed rate: every frame gets
      // dt = 1/hz exactly, the run is reproducible, and it costs render time only.
      const realRAF = window.requestAnimationFrame.bind(window);
      let vt = performance.now(), pending = [];
      window.requestAnimationFrame = cb => { pending.push(cb); return pending.length; };

      let pumped = 0;
      function pump() {
        // Watchdog. NB: Date.now() follows Chrome's VIRTUAL clock here (it barely moves
        // while the pump runs), so this counts frames, not seconds — 120 k frames is far
        // past any scenario and means the run is stuck.
        if (!finished && pumped > 120000) finish('frame watchdog (120k frames)');
        // Batch big: under a virtual-time budget every yield back to the event loop costs
        // real seconds (Chrome re-negotiates frame production), so 12-frame batches made a
        // 2.5 s scenario take minutes. 250 frames per batch = a few hops per scenario,
        // while still handing control back often enough not to wedge the machine.
        let steps = 0;
        while (!finished && steps++ < 250) {
          const cbs = [...new Set(pending)];   // the loop re-registers itself each frame
          pending = [];
          if (!cbs.length) break;
          vt += stepMs;
          pumped++;
          for (const cb of cbs) { try { cb(vt); } catch (e) { pushErr('frame: ' + e.message); } }
        }
        // 1 ms, not 0: under --virtual-time-budget a zero-delay timer chain advances the
        // virtual clock by nothing, so the budget never expires and a stalled run hangs
        // instead of ending. A 1 ms tick per batch keeps Chrome's own timeout alive.
        if (!finished) { setTimeout(pump, 1); return; }
        // Done. Do NOT hand the loop back: rendering every remaining frame until Chrome's
        // virtual-time budget expires is what made a 2.5 s scenario cost minutes of real
        // time. Swallow further rAF registrations and idle on cheap timers instead — the
        // clock then runs out in milliseconds and Chrome dumps the DOM we came for.
        window.requestAnimationFrame = () => 0;
        pending = [];
        // Long idle ticks: each hop advances Chrome's virtual clock by its delay, so a
        // coarse tick burns the leftover budget in a few hops instead of ~1200 — that
        // wind-down was costing ~24 s of the ~26 s a scenario took.
        (function idle() { setTimeout(idle, 10000); })();
      }
      // Cancel whatever the REAL scheduler still has queued. The game loop (the only rAF user
      // — input.js animate) registered itself before the pump took over; if that callback
      // fires later it runs one un-sampled game step on a real timestamp, which showed up as a
      // reload finishing a frame or three "early". rAF ids are sequential, so cancel them all.
      const lastId = realRAF(() => {});
      for (let id = 1; id <= lastId; id++) cancelAnimationFrame(id);
      // Seed the pump with the loop itself.
      pending.push(window.animate);
      setTimeout(pump, 0);
    }
  }

  begin();
})();
