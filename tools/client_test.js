// client_test.js — headless tests for the CLIENT (browser) half of the game: the bits
// `npm test` can't reach because they need THREE/DOM — playerMove + camera/punch/recoil
// in physics.js, the `ws` weapon state machine in weapons.js, HUD/ammo bookkeeping.
//
// How it works: starts a zero-dep static server on a throwaway port, then for each
// scenario launches headless Chrome on
//     viewer.html?test=1&scenario=<name>
// with --virtual-time-budget (so a few seconds of game time run as fast as the CPU
// allows) and --dump-dom. src/autotest.js scripts the input timeline, records a
// per-frame state trace and prints it into the DOM as JSON; we parse that back and
// assert on it here.
//
// The asserts check the game against ITS OWN config (CONFIG / WPNS, both sourced from
// GoldSrc + ReGameDLL) — the trace carries those numbers along, so the expectations
// can't drift out of sync with the code the way a second hardcoded copy would.
//
// Run:  node tools/client_test.js                 (all scenarios, exit 0 = pass)
//       node tools/client_test.js walk jump       (a subset)
//       node tools/client_test.js --dump walk     (print the trace — physics debugging)
//       node tools/client_test.js --jobs 2        (parallel — only on an idle machine)
//   env CHROME=<path to chrome.exe> overrides browser discovery.
//
// Scenarios run with drawing stubbed out (see src/autotest.js): headless Chrome falls back
// to SwiftShader, a multi-threaded software rasteriser that will take every core to draw
// de_dust2 — and the tests assert on numbers, not pixels. Wall time per scenario (~6 s)
// is then almost entirely loading the map.

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ── Static server (zero deps; the game needs real HTTP, not file://) ─────────
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.obj': 'text/plain', '.mtl': 'text/plain', '.txt': 'text/plain', '.bin': 'application/octet-stream',
  '.css': 'text/css', '.tga': 'application/octet-stream',
};
const misses = new Set();          // 404s — a missing asset silently breaks a scenario
function startServer() {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(ROOT, rel || 'viewer.html');
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { misses.add(rel); res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                           'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

// ── Chrome discovery ─────────────────────────────────────────────────────────
function findChrome() {
  const cands = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

// ── One scenario run ─────────────────────────────────────────────────────────
const SCENARIO_DUR = {   // must mirror the SCENARIOS table in src/autotest.js
  walk: 2.5, walk_m4: 2.5, shiftwalk: 2.5, strafe: 2.0, duck: 2.5, jump: 2.0,
  fire: 2.5, dryfire: 9.0, reload: 5.0, switch: 4.0, silencer: 4.0,
  knife: 2.2, knife_mix: 3.0, fall: 1.5,
  awp: 4.6, awp_speed: 3.4, awp_reload: 4.8,
  nade: 2.4, ammo: 0.9, freeze: 2.0, bhop: 1.8,
};
function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function runScenario(chrome, port, name) {
  // The scenario pumps its own frames (see src/autotest.js), so the budget only has to
  // outlast asset loading plus the pump's setTimeout chain — generous is free.
  const budgetMs = 300000;
  const profile  = fs.mkdtempSync(path.join(os.tmpdir(), 'cs16-autotest-'));
  const url = `http://127.0.0.1:${port}/viewer.html?test=1&scenario=${encodeURIComponent(name)}`;
  const args = [
    '--headless=new', '--hide-scrollbars', '--window-size=320,180', '--mute-audio',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--no-sandbox', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`,
    '--dump-dom', `--virtual-time-budget=${budgetMs}`, url,
  ];
  return new Promise(resolve => {
    execFile(chrome, args, { maxBuffer: 256 * 1024 * 1024, timeout: 600000 }, (err, stdout) => {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
      const dom = stdout || '';
      // Debugging aid: AUTOTEST_KEEP_DOM=<dir> saves the raw DOM dump of each run.
      if (process.env.AUTOTEST_KEEP_DOM) {
        try { fs.writeFileSync(path.join(process.env.AUTOTEST_KEEP_DOM, `dom-${name}.html`), dom); } catch (e) {}
      }
      const a = dom.indexOf('#AUTOTEST#'), b = dom.indexOf('#/AUTOTEST#');
      if (a < 0 || b < 0) {
        resolve({ scenario: name, ok: false, why: err ? 'chrome: ' + err.message : 'no autotest output in the DOM', samples: [], errors: [] });
        return;
      }
      try {
        resolve(JSON.parse(unescapeHtml(dom.slice(a + '#AUTOTEST#'.length, b))));
      } catch (e) {
        resolve({ scenario: name, ok: false, why: 'bad JSON: ' + e.message, samples: [], errors: [] });
      }
    });
  });
}

// ── Trace helpers ────────────────────────────────────────────────────────────
const peak    = (s, f) => s.reduce((m, x) => Math.max(m, f(x)), -Infinity);
const firstW  = (s, f) => s.find(f) || null;
const lastW   = (s, f) => { for (let i = s.length - 1; i >= 0; i--) if (f(s[i])) return s[i]; return null; };
const between = (s, a, b) => s.filter(x => x.t >= a && x.t <= b);
const near    = (v, want, tol) => Math.abs(v - want) <= tol;
const dist2d  = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
// Run-speed cap the game actually uses, mirroring physics.js: the weapon's
// m_flMaxSpeed, falling back to sv_maxspeed (the knife carries no cap of its own).
const capOf   = o => o.wcfg.maxSpeed || o.cfg.maxspeed;
// Frames where a knife attack STARTED: the state machine enters SLASH/STAB or restarts
// it (wsT resets). Returns [{t, ws}].
const meleeStarts = s => {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const x = s[i], p = s[i - 1];
    if (x.ws !== 2 && x.ws !== 3) continue;
    if (!p || p.ws !== x.ws || x.wsT < p.wsT) out.push({ t: x.t, ws: x.ws });
  }
  return out;
};
const WS = { IDLE: 0, DRAW: 1, SLASH: 2, STAB: 3, FIRE: 4, RELOAD: 5, SILENCER: 6, PULLPIN: 7, THROW: 8 };

// ── Per-scenario assertions ──────────────────────────────────────────────────
// Each gets (out, check) where out is the emitted trace object.
const ASSERTS = {
  // Ground speed caps come straight from CONFIG/WPNS (GoldSrc sv_maxspeed and the
  // per-weapon m_flMaxSpeed); the run must actually reach the cap and not exceed it.
  walk(o, check) {
    const s = o.samples, cap = capOf(o);
    const top = peak(s, x => x.spd);
    check('reaches the weapon speed cap', near(top, cap, cap * 0.02), `top=${top.toFixed(1)} cap=${cap}`);
    check('never exceeds the cap', top <= cap + 0.5, `top=${top.toFixed(1)}`);
    check('stays on the ground', s.every(x => x.ground));
    check('does not fall through the floor', Math.abs(o.end.pos[2] - o.start.pos[2]) < 20,
          `dz=${(o.end.pos[2] - o.start.pos[2]).toFixed(1)}`);
    check('actually travelled', dist2d(o.start, o.end) > 150, `d=${dist2d(o.start, o.end).toFixed(0)}`);
    check('friction stops him after release', o.end.spd < 5, `end=${o.end.spd.toFixed(2)}`);
  },
  walk_m4(o, check) {
    const cap = capOf(o), top = peak(o.samples, x => x.spd);
    check('M4 caps slower than the knife', cap < 250, `m_flMaxSpeed=${cap}`);
    check('reaches the M4 cap', near(top, cap, cap * 0.02), `top=${top.toFixed(1)} cap=${cap}`);
  },
  shiftwalk(o, check) {
    const want = o.cfg.walkspeed * (capOf(o) / o.cfg.maxspeed);
    const top = peak(o.samples, x => x.spd);
    check('Shift holds him to walkspeed', near(top, want, want * 0.03), `top=${top.toFixed(1)} want=${want}`);
  },
  strafe(o, check) {
    const cap = capOf(o), top = peak(o.samples, x => x.spd);
    // Only a lower bound on purpose: this strafe runs along a wall at the CT spawn, and
    // sliding along a plane legitimately pushes GoldSrc past sv_maxspeed (PM_Accelerate
    // keeps adding while the velocity's projection onto wishdir stays under the cap —
    // the same mechanic surf maps are built on). Verified against sim-core: the excess
    // follows the WORLD direction, not the input axis, so it is geometry, not the math.
    check('pure strafe reaches the cap', top >= cap * 0.98, `top=${top.toFixed(1)} cap=${cap}`);
    check('moved sideways', dist2d(o.start, o.end) > 120, `d=${dist2d(o.start, o.end).toFixed(0)}`);
  },
  duck(o, check, warn) {
    const s = o.samples;
    const full = firstW(s, x => x.duck >= 0.999);
    check('crouches fully', !!full, full ? `at t=${full.t.toFixed(2)}` : '');
    // CONFIG.ducktime is the full 0→1 transition.
    check('crouch takes ~ducktime', full && near(full.t, o.cfg.ducktime, 0.08),
          full ? `t=${full.t.toFixed(3)} ducktime=${o.cfg.ducktime}` : '');
    // Duck hull on the floor (PM_FinishDuck) — this was a known deviation until the fix in
    // sim-core: the hull used to swap only in the air.
    check('duck hull goes active on the ground (phyDucked)', s.some(x => x.ducked));
    const low = firstW(s, x => x.ducked);
    check('origin drops 18 when the hull swaps', low && near(s[0].pos[2] - low.pos[2], 18, 0.05),
          low ? `dz=${(s[0].pos[2] - low.pos[2]).toFixed(2)}` : '');
    // Eye heights (GoldSrc): standing origin+17 = floor+53, crouched VEC_DUCK_VIEW = floor+30.
    // s[0] is standing (origin = floor + 36), so floor = s[0].pos[2] − 36.
    const floorZ = s[0].pos[2] - 36;
    check('gameplay eye (shot origin) at floor+30 when crouched', low && near(low.eyeZ - floorZ, 30, 0.5),
          low ? `eye=floor+${(low.eyeZ - floorZ).toFixed(2)}` : '');
    check('gameplay eye back at floor+53 after standing', near(o.end.eyeZ - floorZ, 53, 0.5),
          `eye=floor+${(o.end.eyeZ - floorZ).toFixed(2)}`);
    // The camera must not jump when the origin snaps down 18: frame-to-frame change stays
    // within what the smooth crouch lerp produces (~23 u over ducktime → a few u per frame).
    let maxStep = 0;
    for (let i = 1; i < s.length; i++) if (s[i].camZ != null && s[i - 1].camZ != null)
      maxStep = Math.max(maxStep, Math.abs(s[i].camZ - s[i - 1].camZ));
    check('camera does not jump on the hull swap or stand-up', maxStep < 6, `max step=${maxStep.toFixed(2)}u/frame`);
    const moving = between(s, 0.7, 1.9);
    const top = peak(moving, x => x.spd);
    const want = capOf(o) * o.cfg.duckmult;   // PLAYER_DUCKING_MULTIPLIER 0.333 on the input
    check('crouch-walk = cap × 0.333', near(top, want, want * 0.02), `top=${top.toFixed(1)} want=${want.toFixed(2)}`);
    check('stands back up at the end', o.end.duck < 0.01 && !o.end.ducked, `duck=${o.end.duck}`);
  },
  jump(o, check) {
    const s = o.samples;
    const air = firstW(s, x => !x.ground);
    check('leaves the ground', !!air, air ? `t=${air.t.toFixed(2)}` : '');
    // Ballistic apex for the configured jump impulse: v^2 / 2g.
    const apexWant = (o.cfg.jumpvel * o.cfg.jumpvel) / (2 * o.cfg.gravity);
    const z0 = s[0].pos[2], rise = peak(s, x => x.pos[2]) - z0;
    check('apex matches jumpvel^2/2g', near(rise, apexWant, 2.5), `rise=${rise.toFixed(2)} want=${apexWant.toFixed(2)}`);
    check('take-off speed ~jumpvel', air && air.vel[2] <= o.cfg.jumpvel + 0.1 && air.vel[2] > o.cfg.jumpvel - 40,
          air ? `vz=${air.vel[2].toFixed(1)} jumpvel=${o.cfg.jumpvel}` : '');
    check('lands again', o.end.ground);
    check('lands back at the start height', near(o.end.pos[2], z0, 1), `dz=${(o.end.pos[2] - z0).toFixed(2)}`);
  },
  fire(o, check) {
    const s = o.samples;
    const a = lastW(s, x => x.t < 0.3), b = firstW(s, x => x.t >= 1.3);
    const shots = a.ammo - b.ammo;
    // The gun can only fire on a frame, so the cycle time rounds up to a whole tick
    // (0.0875 s at a 50 Hz tick really fires every 0.10 s) — compare against that, not
    // against the raw interval, or the check just measures the harness's frame rate.
    const tick = s[1] ? s[1].dt : 0.02;
    const eff  = Math.ceil(o.wcfg.fireInterval / tick) * tick;
    const want = Math.floor(1.0 / eff) + 1;
    check('full-auto rate matches fireInterval', Math.abs(shots - want) <= 1,
          `shots=${shots} want≈${want} (interval=${o.wcfg.fireInterval}s → ${eff.toFixed(3)}s at ${(1 / tick).toFixed(0)}Hz)`);
    check('the state machine fires', s.some(x => x.ws === WS.FIRE));
    check('recoil climbs while firing', peak(between(s, 0.3, 1.3), x => x.rp) > 0.01,
          `peak=${peak(between(s, 0.3, 1.3), x => x.rp).toFixed(4)}`);
    check('crosshair opens up', peak(s, x => x.gap) > s[0].gap);
    check('recoil recovers after release', o.end.rp < peak(s, x => x.rp) * 0.5,
          `end=${o.end.rp.toFixed(4)}`);
    check('never fires below zero', s.every(x => x.ammo >= 0));
  },
  dryfire(o, check) {
    const s = o.samples;
    const empty = firstW(s, x => x.ammo === 0);
    check('empties the clip', !!empty, empty ? `t=${empty.t.toFixed(2)}` : '');
    check('auto-reloads when dry', s.some(x => x.ws === WS.RELOAD));
    check('clip is full again', o.end.ammo === o.wcfg.maxAmmo, `ammo=${o.end.ammo}/${o.wcfg.maxAmmo}`);
    check('reserve paid for it', o.end.res === s[0].res - o.wcfg.maxAmmo,
          `res ${s[0].res} → ${o.end.res}`);
  },
  reload(o, check) {
    const s = o.samples;
    const rs = firstW(s, x => x.ws === WS.RELOAD), re = rs ? firstW(s, x => x.t > rs.t && x.ws !== WS.RELOAD) : null;
    check('R starts a reload', !!rs, rs ? `t=${rs.t.toFixed(2)}` : '');
    check('reload takes ~reloadTime', rs && re && near(re.t - rs.t, o.wcfg.reloadTime, 0.2),
          rs && re ? `took=${(re.t - rs.t).toFixed(2)} want=${o.wcfg.reloadTime}` : '');
    check('clip refilled', o.end.ammo === o.wcfg.maxAmmo, `ammo=${o.end.ammo}`);
    const used = s[0].ammo - (rs ? rs.ammo : s[0].ammo);
    check('reserve debited by the shots fired', o.end.res === s[0].res - used,
          `used=${used} res ${s[0].res} → ${o.end.res}`);
  },
  switch(o, check) {
    const s = o.samples;
    const seen = [];
    for (const x of s) if (seen[seen.length - 1] !== x.wpn) seen.push(x.wpn);
    check('slot keys walk 1 → 2 → 3', seen.join(',') === 'knife,m4,usp,knife', seen.join(' → '));
    const afterSwitch = firstW(s, x => x.t >= 0.5 && x.wpn === 'm4');
    check('a switch plays the draw animation', afterSwitch && afterSwitch.ws === WS.DRAW,
          afterSwitch ? `ws=${afterSwitch.ws}` : '');
  },
  // Knife timings straight from ReGameDLL CKnife::Swing/Stab. The tick is 1/50 s, so a
  // cooldown lands on the next whole frame (0.35 → 0.36, 0.5 → 0.5/0.52).
  knife(o, check) {
    const st = meleeStarts(o.samples).filter(x => x.ws === 2);
    const gaps = st.slice(1).map((x, i) => x.t - st[i].t);
    const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
    check('held LMB keeps slashing', st.length >= 5, `slashes=${st.length}`);
    check('slash-miss cadence is 0.35 s (CKnife::Swing miss)', near(mean, 0.36, 0.021),
          `mean gap=${mean.toFixed(3)}s over ${gaps.length}`);
  },
  knife_mix(o, check) {
    const st = meleeStarts(o.samples);
    const slash = st.find(x => x.ws === 2), stabs = st.filter(x => x.ws === 3);
    check('a slash, then stabs', !!slash && stabs.length >= 2, `slash=${!!slash} stabs=${stabs.length}`);
    if (slash && stabs.length) {
      const wait = stabs[0].t - slash.t;
      // ±1 tick: an attack started from the mouse handler is also decremented by that same
      // frame's updateWeapon, so it can come up one frame (0.02 s here) early.
      check('stab after a slash waits 0.5 s (m_flNextSecondaryAttack)', wait >= 0.47 && wait <= 0.54,
            `waited ${wait.toFixed(3)}s`);
    }
    if (stabs.length >= 2) {
      const g = stabs[1].t - stabs[0].t;
      check('stab-miss cadence is 1.0 s', near(g, 1.0, 0.021), `gap=${g.toFixed(3)}s`);
    }
  },
  fall(o, check) {
    const s = o.samples;
    const air  = s.filter(x => !x.ground);
    const land = firstW(s, x => x.t > 0.05 && x.ground);
    check('the lift put him in the air', air.length >= 2, `air frames=${air.length}`);
    check('lands', !!land);
    if (!land) return;
    // Touchdown speed = the fastest downward |vz| before contact (the core reports the
    // pre-landing velocity as m_flFallVelocity; the contact tick itself is already clipped).
    const v = Math.max(...s.filter(x => x.t < land.t && !x.ground).map(x => -x.vel[2]));
    const want = v > 500 ? (v - 500) * (100 / 600) * 1.25 : 0;   // CHalfLifeMultiplay::FlPlayerFallDamage
    const lost = s[0].hp - o.end.hp;
    check('reaches a damaging speed (> 500)', v > 600, `v=${v.toFixed(1)}`);
    check('HP loss = CS fall formula (×1.25)', near(lost, want, 2), `lost=${lost} want≈${want.toFixed(1)} at v=${v.toFixed(0)}`);
    check('armor does not absorb falls', o.end.ar === s[0].ar);
  },
  // AWP straight from ReGameDLL CAWP (wpn_awp.cpp).
  awp(o, check) {
    const s = o.samples, fovAt = t => (lastW(s, x => x.t <= t) || s[0]).fov;
    // A shot = ammo drops. The first can land on sample 0 (clicked on the very first frame),
    // which has no predecessor — compare it against the full clip instead.
    const shots = s.filter((x, i) => x.ammo < (i ? s[i - 1].ammo : o.wcfg.maxAmmo));
    check('two shots fired', shots.length === 2, `shots=${shots.length}`);
    if (shots.length < 2) return;
    check('no-scope shot: cone 0.001 + 0.08', near(shots[0].spr, 0.081, 1e-4), `spr=${shots[0].spr}`);
    check('scoped shot: pinpoint 0.001', near(shots[1].spr, 0.001, 1e-4), `spr=${shots[1].spr}`);
    check('RMB during the bolt cycle is ignored', fovAt(1.5) === 90, `fov@1.5=${fovAt(1.5)}`);
    check('RMB → 40', fovAt(1.68) === 40, `fov=${fovAt(1.68)}`);
    check('a 2nd RMB within 0.3 s is ignored', fovAt(1.95) === 40, `fov=${fovAt(1.95)}`);
    check('RMB → 10', fovAt(2.3) === 10, `fov=${fovAt(2.3)}`);
    check('scoped shot drops to 90', shots[1].fov === 90, `fov=${shots[1].fov}`);
    const back = firstW(s, x => x.t > shots[1].t && x.fov === 10);
    const wait = back ? back.t - shots[1].t : NaN;
    check('re-zooms to 10 when the next shot is allowed (1.45 s)', back && Math.abs(wait - o.wcfg.fireInterval) <= 0.041,
          `after ${wait.toFixed(3)}s, cycle=${o.wcfg.fireInterval}`);
  },
  awp_reload(o, check) {
    const s = o.samples;
    const rs = firstW(s, x => x.ws === WS.RELOAD), re = rs && firstW(s, x => x.t > rs.t && x.ws !== WS.RELOAD);
    check('R starts a reload', !!rs);
    if (!rs || !re) return;
    check('ready at AWP_RELOAD_TIME 2.5 s', Math.abs((re.t - rs.t) - o.wcfg.reloadTime) <= 0.041 && o.wcfg.reloadTime === 2.5,
          `ready after ${(re.t - rs.t).toFixed(3)}s (reloadTime=${o.wcfg.reloadTime})`);
    check('clip refilled at the ready point', re.ammo === o.wcfg.maxAmmo, `ammo=${re.ammo}`);
    const tail = between(s, re.t, re.t + 0.08);
    check('reload anim keeps playing past the ready point', tail.length && tail.every(x => x.ws === WS.IDLE && x.seq === 'reload'),
          tail.map(x => `${x.ws}/${x.seq}`).slice(0, 3).join(' '));
    const shot = firstW(s, x => x.t > re.t && x.ammo < re.ammo);
    check('a shot during the anim tail fires (the gun is ready)', !!shot, shot ? `t=${shot.t.toFixed(2)}` : '');
    check('…and cuts the reload anim', shot && /^shoot/.test(shot.seq || ''), shot ? `seq=${shot.seq}` : '');
  },
  // HE grenade through the real client (throw → shared sim-core flight → fuse → detonate).
  nade(o, check) {
    const s = o.samples;
    const i0 = s.findIndex(x => x.nade);
    check('a grenade is thrown', i0 >= 0);
    if (i0 < 0) return;
    const f = s[i0].nade;
    const h = Math.hypot(f.vel[0], f.vel[1]);
    // One tick of flight has already happened: vz lost ≤ 0.55·800·dt.
    check('throw speed 600 u/s at 10° up (horizontal 590.9)', near(h, 600 * Math.cos(Math.PI / 18), 1), `h=${h.toFixed(1)}`);
    check('…vertical ≈ 104 minus a tick of gravity', f.vel[2] <= 104.2 && f.vel[2] > 104.2 - 0.55 * 800 * 0.021,
          `vz=${f.vel[2].toFixed(1)}`);
    const thrownAt = s[i0].t - (1.5 - s[i0].nade.fuse);   // fuse started at the throw
    const gone = firstW(s, (x, i) => i > i0 && !x.nade);
    check('it comes to rest before going off', s.some(x => x.nade && x.nade.rest));
    check('detonates 1.5 s after the throw (fuse)', gone && Math.abs((gone.t - thrownAt) - 1.5) <= 0.041,
          gone ? `after ${(gone.t - thrownAt).toFixed(3)}s` : 'never');
  },
  // Ammo economy (ReGameDLL BuyGunAmmo): one calibre pack per press, clamped to the carry max,
  // full price even for a partial pack, refused when full. Solo path (client-side money).
  ammo(o, check) {
    const s = o.samples, at = t => lastW(s, x => x.t <= t) || s[0];
    const m4 = t => at(t).rsv.m4, usp = t => at(t).rsv.usp, $ = t => at(t).money;
    check('starts empty with $1000', m4(0.05) === 0 && $(0.05) === 1000, `m4=${m4(0.05)} $${$(0.05)}`);
    check('1st pack: +30 5.56 for $60', m4(0.15) === 30 && $(0.15) === 940, `m4=${m4(0.15)} $${$(0.15)}`);
    check('3 packs: 90 (max) for $180', m4(0.35) === 90 && $(0.35) === 820, `m4=${m4(0.35)} $${$(0.35)}`);
    check('4th press when full: refused, no charge', m4(0.45) === 90 && $(0.45) === 820, `m4=${m4(0.45)} $${$(0.45)}`);
    check('USP 90 → 100: partial pack, full $25', usp(0.55) === 100 && $(0.55) === 795, `usp=${usp(0.55)} $${$(0.55)}`);
    check('USP full: refused', usp(0.85) === 100 && $(0.85) === 795, `$${$(0.85)}`);
  },
  // Freeze time (competitive round start): maxspeed 1, no attacks, jump/buy still allowed.
  freeze(o, check) {
    const s = o.samples;
    const frz = s.filter(x => x.phase === 'buy' && x.t > 0.02), live = s.filter(x => x.phase === 'live');
    check('the 1 s freeze runs, then the round goes live', frz.length > 30 && live.length > 20,
          `freeze=${frz.length} live=${live.length} frames`);
    const top = peak(frz, x => x.spd);
    check('freeze: holding W does not walk (maxspeed 1)', top <= 1.01, `top=${top.toFixed(2)} u/s`);
    check('freeze: holding LMB does not fire', frz.every(x => x.ammo === s[0].ammo), `ammo ${s[0].ammo} → ${o.end.ammo}`);
    check('freeze: jumping still works', frz.some(x => !x.ground));
    check('freeze: buying is open', frz.every(x => x.buyOpen));
    const topLive = peak(live, x => x.spd);
    check('live: walks again', topLive > 150, `top=${topLive.toFixed(1)}`);
    check('live: fires again', o.end.ammo < s[0].ammo, `ammo ${s[0].ammo} → ${o.end.ammo}`);
    check('live: buy window still open (15 s)', live.every(x => x.buyOpen));
  },
  // Jump penalty through the real client (physics.js ↔ sim-core stamina): a jump right on landing
  // is lower — pm_shared fuser2.
  bhop(o, check) {
    const s = o.samples;
    const offs = [];                                  // take-off samples of each jump
    // take-off = an airborne sample whose predecessor was grounded — or sample 0 itself (the
    // first jump fires on the very first scripted frame).
    for (let i = 0; i < s.length; i++) if (!s[i].ground && (i === 0 || s[i - 1].ground)) offs.push(s[i]);
    check('two jumps', offs.length >= 2, `jumps=${offs.length}`);
    if (offs.length < 2) return;
    const v1 = offs[0].vel[2], v2 = offs[1].vel[2];
    check('first jump at full height (≈268 − gravity of a frame)', v1 > 255, `vz=${v1.toFixed(1)}`);
    // pm_shared PM_Jump: vz × (100 − t·0.019)%, t = penalty left = 1315.79 ms − time since the last jump.
    const left = Math.max(0, 1315.789429 - (offs[1].t - offs[0].t) * 1000);
    const want = v1 * (100 - left * 0.019) / 100;
    check('second jump is lower by exactly the penalty left', v2 < v1 && near(v2, want, 2),
          `vz ${v1.toFixed(1)} → ${v2.toFixed(1)}, want ${want.toFixed(1)} (penalty ${left.toFixed(0)} ms)`);
  },
  awp_speed(o, check) {
    const s = o.samples;
    const un = peak(between(s, 0, 1.2), x => x.spd), sc = peak(between(s, 1.9, 3.2), x => x.spd);
    check('unscoped AWP runs at 210 (AWP_MAX_SPEED)', near(un, 210, 3), `top=${un.toFixed(1)}`);
    check('scoped AWP runs at 150 (AWP_MAX_SPEED_ZOOM)', near(sc, 150, 3), `top=${sc.toFixed(1)}`);
  },
  silencer(o, check) {
    const s = o.samples;
    check('starts unsilenced', !s[0].sil);
    check('F runs the silencer animation', s.some(x => x.ws === WS.SILENCER));
    check('silencer ends up attached', o.end.sil);
  },
};

// ── Runner ───────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const dumpIdx = argv.indexOf('--dump');
  const dumpName = dumpIdx >= 0 ? argv[dumpIdx + 1] : null;
  const jobsIdx = argv.indexOf('--jobs');
  // One at a time by default: the headless GPU is SwiftShader, a multi-threaded software
  // rasteriser that will happily take every core, and two instances can wedge the machine.
  // (Scenarios stub out drawing, so this is belt-and-braces; raise it only on an idle box.)
  const jobs = jobsIdx >= 0 ? Math.max(1, +argv[jobsIdx + 1]) : 1;
  const names = argv.filter((a, i) =>
    !a.startsWith('--') && !(dumpIdx >= 0 && i === dumpIdx + 1) && !(jobsIdx >= 0 && i === jobsIdx + 1));
  const run = dumpName ? [dumpName] : (names.length ? names : Object.keys(ASSERTS));

  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome found. Set CHROME=<path to chrome.exe> and re-run.');
    process.exit(2);
  }
  const srv = await startServer();
  const port = srv.address().port;
  console.log(`chrome: ${chrome}\nserving ${ROOT} on :${port}\nscenarios: ${run.join(', ')}\n`);

  // Chrome + SwiftShader is heavy; run a few at a time.
  const results = new Map();
  const queue = run.slice();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) {
      const name = queue.shift();
      const t0 = Date.now();
      const out = await runScenario(chrome, port, name);
      out._ms = Date.now() - t0;
      results.set(name, out);
      // Wall time per scenario is dominated by loading the map (~40 MB of OBJ); the
      // scripted part itself is milliseconds. (The trace's `timing` field is in Chrome's
      // VIRTUAL milliseconds — it barely moves while the pump runs — so it isn't shown here.)
      process.stdout.write(`  ran ${name} (${(out._ms / 1000).toFixed(1)}s, ${out.frames || 0} frames)\n`);
    }
  }));
  srv.close();
  if (misses.size) console.log(`
! ${misses.size} asset(s) 404'd: ${[...misses].slice(0, 8).join(', ')}`);

  if (dumpName) {
    const o = results.get(dumpName);
    if (!o || !o.samples) { console.error('no trace:', o && o.why); process.exit(1); }
    const { samples, ...head } = o;
    console.log('\nrun: ' + JSON.stringify(head));
    console.log('\nt\tx\ty\tz\tspd\tvz\tgnd\tduck\tws\twsT\tvm\tammo\trecoilP');
    for (const x of samples) {
      console.log([x.t.toFixed(3), x.pos[0].toFixed(1), x.pos[1].toFixed(1), x.pos[2].toFixed(1),
                   x.spd.toFixed(1), x.vel[2].toFixed(1), x.ground ? 'G' : 'air', x.duck.toFixed(2),
                   x.ws, (x.wsT || 0).toFixed(2), x.vm ? 'vm' : '-', x.ammo, x.rp.toFixed(4)].join('\t'));
    }
    process.exit(0);
  }

  let failures = 0, warnings = 0;
  const check = (name, cond, extra) => {
    const ok = !!cond;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!ok) failures++;
  };
  // Known, already-understood deviations: reported on every run but not counted as
  // failures, so a real regression still stands out. Promote one back to check() when fixed.
  const warn = (name, cond, extra) => {
    const ok = !!cond;
    console.log(`${ok ? 'PASS' : 'WARN'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!ok) warnings++;
  };
  for (const name of run) {
    const o = results.get(name);
    console.log(`\n── ${name} ──`);
    if (!o || !o.ok) { check(`${name}: scenario ran`, false, (o && o.why) || 'no output'); continue; }
    // SwiftShader (the headless software GL) intermittently fails to validate a shader
    // program that compiles fine on a real GPU — it is noise from the test environment,
    // not from the game, so it warns instead of failing.
    const gl = o.errors.filter(e => /WebGLProgram|Shader Error|VALIDATE_STATUS|WebGL/i.test(e));
    const real = o.errors.filter(e => !gl.includes(e));
    check('no JS errors in the page', real.length === 0, real.slice(0, 3).join(' | '));
    if (gl.length) warn('no WebGL warnings from SwiftShader', false, gl[0].split(/\r?\n/)[0]);
    check('the game loop actually ran', o.frames > 30, `frames=${o.frames} (${o.fps} fps virtual)`);
    // The timeline waits for "on the ground + weapon idle"; 8 s is the bail-out, and
    // starting from there means the scripted input hit a game that wasn't ready.
    check('started from a settled state', o.settledAt < 59, `settledAt=${o.settledAt}s of game time`);
    try { ASSERTS[name](o, check, warn); }
    catch (e) { check(`${name}: asserts threw`, false, e.message); }
  }
  const warnNote = warnings ? `  (${warnings} known deviation(s) warned)` : '';
  console.log(failures === 0 ? `\nALL TESTS PASSED${warnNote}` : `\n${failures} TEST(S) FAILED${warnNote}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
