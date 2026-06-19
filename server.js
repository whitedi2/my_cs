// server.js — AUTHORITATIVE multiplayer server for the CS 1.6 clone (Phase 5, step B).
//
// The server owns the simulation: clients send only USERCMDS (movement input +
// view yaw + a sequence number), the server advances each player with the SAME
// deterministic core the client predicts with (src/sim-core.js), and broadcasts
// authoritative snapshots ~20×/s. Each snapshot carries an `ack` = the last
// usercmd seq the server processed from that recipient, so the client can do
// prediction + reconciliation (replay unacked cmds on top of the server state).
//
// Transport is still a hand-rolled RFC-6455 WebSocket (ZERO npm deps for the wire);
// WebRTC DataChannel is a later step (see docs/PHASE5_HANDOFF.md). The world logic
// is exported for the headless test (tools/net_test.js); the network server only
// starts when this file is run directly (`node server.js`).
//
// Run:  node server.js        (listens on ws://localhost:8081 by default)

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const sim    = require('./src/sim-core.js');
const combat = require('./src/combat-core.js');
const match  = require('./src/match-core.js');
const CONFIG = require('./config.js');

const LAG_HISTORY_MS = 1000;   // how far back we keep position history for lag compensation

// ── World (authoritative simulation) — pure, testable without the network ────
const _hullPath = path.join(__dirname, 'maps', 'de_dust2_hull.json');
let _hullData = null, _hull = null;
try {
  _hullData = JSON.parse(fs.readFileSync(_hullPath, 'utf8'));
  _hull = sim.simMakeHull(_hullData);
} catch (e) {
  console.warn('[mp] could not load hull (' + _hullPath + '):', e.message,
               '\n[mp] players will float — run tools/bsp_phys.py to generate it.');
}

// GoldSrc entity yaw (deg, 0=+X) → our yaw (forward = (-sin,cos)).
function _angleToYaw(deg) { return (deg - 90) * Math.PI / 180; }

function _pickSpawn(team) {
  const spawns = _hullData && _hullData.spawns;
  const list = (spawns && spawns[team] && spawns[team].length) ? spawns[team]
             : (spawns && spawns.ct) || [];
  const sp = list.length ? list[Math.floor(Math.random() * list.length)] : null;
  if (sp) return { pos: [sp.origin[0], sp.origin[1], sp.origin[2] + 1], yaw: _angleToYaw(sp.angle || 0) };
  return { pos: [0, 0, 200], yaw: 0 };
}

// Place a player at a spawn point (resets velocity/stance + the lag-comp history so a shot
// right after respawn can't rewind to the pre-teleport spot).
function _placeAtSpawn(pl, sp) {
  pl.state = sim.simMakeState([sp.origin[0], sp.origin[1], sp.origin[2] + 1]);
  pl.yaw = _angleToYaw(sp.angle || 0);
  pl.hist.length = 0;
}

// Server-authoritative round spawns (Phase 6E): hand each joined player a DISTINCT spawn from
// their team's list (cycles if there are more players than pads), so nobody overlaps and the
// client no longer has to pick + push its own spawn.
function _assignSpawns(world) {
  const spawns = _hullData && _hullData.spawns;
  if (!spawns) return;
  const idx = { t: 0, ct: 0 };
  for (const pl of world.players.values()) {
    if (!pl.joined) continue;
    const list = (spawns[pl.team] && spawns[pl.team].length) ? spawns[pl.team] : (spawns.ct || []);
    if (!list.length) continue;
    _placeAtSpawn(pl, list[idx[pl.team]++ % list.length]);
  }
}

function createWorld() { return { players: new Map(), match: match.matchCreate(), droppedC4: null }; }

function worldAddPlayer(world, id, opts = {}) {
  const sp = _pickSpawn(opts.tm === 't' ? 't' : 'ct');
  const pl = {
    id,
    state:   sim.simMakeState(opts.p || sp.pos),
    yaw:     (opts.p ? (opts.y || 0) : sp.yaw),
    team:    opts.tm === 't' ? 't' : 'ct',
    model:   opts.m || 'gign',
    weapon:  opts.w || 'usp',
    lastSeq: 0,
    hp:      100, armor: 0, helmet: false,   // authoritative health (Phase 6B)
    alive:   true,
    money:   match.MATCH_START_MONEY,        // authoritative economy (Phase 6C)
    weapons: new Set(['knife', 'usp']),
    nades:   { hegrenade: 0, flashbang: 0, smokegrenade: 0 },
    dk:      false,
    carryingC4: false, plantProg: 0, use: false,   // C4 (Phase 6D): carrier flag + plant hold + E-held
    kills:   0, deaths: 0,  // scoreboard / kill feed (Phase 6E)
    hist:    [],            // lag-comp ring: [{ svt, pos:[x,y,z], dk }]
    // Not broadcast until the client sends its real identity (hello). A bare connection
    // (no team/model/pos yet) sits in the team menu — don't render it as the default
    // gign/ct, which would flash the wrong (CT) model on other screens.
    joined:  !!(opts.m || opts.tm || opts.p),
  };
  world.players.set(id, pl);
  return pl;
}

// Re-place a player (team change / respawn). Resets velocity & spawn pose.
function worldRespawn(pl, opts = {}) {
  pl.joined = true;                 // a hello (join / team change / respawn) means they're in
  pl.hp = 100; pl.armor = 0; pl.helmet = false; pl.alive = true;   // fresh body on (re)join
  // Fresh economy on join / team change (CS resets money on team switch).
  pl.money = match.MATCH_START_MONEY;
  pl.weapons = new Set(['knife', 'usp']);
  pl.nades = { hegrenade: 0, flashbang: 0, smokegrenade: 0 };
  pl.dk = false;
  pl.carryingC4 = false; pl.plantProg = 0;     // carrier is (re)assigned at round start
  pl.kills = 0; pl.deaths = 0;                  // team change / fresh join resets the scoreline
  if (opts.tm) pl.team = opts.tm === 't' ? 't' : 'ct';
  if (opts.m)  pl.model = opts.m;
  if (opts.w)  pl.weapon = opts.w;
  const sp = opts.p ? { pos: opts.p.slice(), yaw: opts.y || 0 } : _pickSpawn(pl.team);
  pl.state = sim.simMakeState(sp.pos);
  pl.yaw = sp.yaw;
}

// Advance one player by a single usercmd. Ignores stale/duplicate seq. dt clamped
// so a client can't fast-forward the sim with a huge dt. Dead players don't move.
// Returns a fall-damage event { dealt, died } when landing hurts, else null.
function worldApplyCmd(pl, c) {
  if (!_hull || !c || (c.seq | 0) <= pl.lastSeq) return null;
  pl.lastSeq = c.seq | 0;
  pl.yaw = c.y || 0;
  if (c.w) pl.weapon = c.w;
  // Presentation-only state we relay so other clients can render this player's
  // third-person avatar (look pitch + weapon state machine). Not used by the sim.
  pl.pitch = c.pi || 0;
  if (c.wsv !== undefined) { pl.ws = c.wsv; pl.wsT = c.wsp || 0; }
  pl.use = !!c.u;                                   // E held (plant / defuse intent, Phase 6D)
  if (!pl.alive) return null;                       // a corpse doesn't move
  const dt = Math.max(0, Math.min(c.dt || 0, 0.1));
  const cmd = {
    forwardMove: c.fm || 0, sideMove: c.sm || 0,
    jump: !!c.jp, duck: !!c.dk, walk: !!c.wk, yaw: pl.yaw,
  };
  const ev = sim.simPlayerMove(_hull, pl.state, cmd, dt, { wpnMax: c.ws || CONFIG.maxspeed });
  if (ev.landed) {                                  // authoritative fall damage
    const fd = match.matchFallDamage(ev.fallVel);
    if (fd > 0) {
      const r = match.matchApplyDamage(pl, fd, 0);
      if (r.dealt > 0) return { dealt: r.dealt, died: r.died };
    }
  }
  return null;
}

// Compact authoritative entry for one player (keys kept short).
function snapshotEntry(pl) {
  const s = pl.state;
  return {
    id: pl.id,
    p: [s.pos[0], s.pos[1], s.pos[2]],
    v: [s.vel[0], s.vel[1], s.vel[2]],
    y: pl.yaw,
    og: s.onGround ? 1 : 0, dk: s.phyDucked ? 1 : 0,
    da: s.duckAmount, wj: s.wasJump ? 1 : 0, pz: s.prevVelZ,
    m: pl.model, tm: pl.team, w: pl.weapon, al: pl.alive ? 1 : 0,
    pi: pl.pitch || 0, wsv: pl.ws || 0, wsp: pl.wsT || 0,   // presentation: look pitch + weapon state
  };
}

function worldSnapshot(world) {
  const players = [];
  for (const pl of world.players.values()) if (pl.joined) players.push(snapshotEntry(pl));
  return players;
}

// ── Match flow (authoritative, Phase 6A) ─────────────────────────────────────
// Tick the round state machine against the live roster and apply its events. On a new
// round every player is marked alive again (clients respawn when they see the round
// number bump). Returns the events for the caller (e.g. to log).
function worldTickMatch(world, dt) {
  const roster = [];
  for (const pl of world.players.values()) roster.push({ team: pl.team, alive: pl.alive, joined: pl.joined });
  const ev = match.matchTick(world.match, roster, dt);          // phases / clock / C4 fuse → detonate
  if (ev.roundStart) {                                          // fresh round: respawn + revive + reassign C4
    _assignSpawns(world);                                       // authoritative distinct spawns (6E)
    world.droppedC4 = null;                                     // clear any loose bomb from last round
    const ts = [];
    for (const pl of world.players.values()) {
      match.matchRevive(pl);
      pl.carryingC4 = false; pl.plantProg = 0;
      if (pl.joined && pl.team === 't') ts.push(pl);
    }
    if (ts.length) ts[Math.floor(Math.random() * ts.length)].carryingC4 = true;   // one random T gets the bomb
  }
  worldTickBomb(world, dt, ev);                                 // plant / defuse (geometry) — may end the round
  if (ev.bombDetonate) ev.bombDmg = worldC4Damage(world, ev.bombDetonate.pos);   // blast → dmg events
  if (ev.roundEnd) {                                            // round reward (win/loss bonus)
    const win = ev.roundEnd.winner;
    for (const pl of world.players.values()) if (pl.joined)
      pl.money = Math.min(match.MATCH_MONEY_CAP, pl.money + (pl.team === win ? match.MATCH_WIN_REWARD : match.MATCH_LOSS_REWARD));
  }
  return ev;
}

// Is a player inside their team's buy zone? (Server-side validation of buy intents.)
function _inBuyZone(pl) {
  const zones = _hullData && _hullData.buyzones;
  if (!zones) return true;                       // no zone data → don't block
  const p = pl.state.pos;
  for (const z of zones) {
    if (z.team !== pl.team) continue;
    if (p[0] >= z.min[0] && p[0] <= z.max[0] && p[1] >= z.min[1] && p[1] <= z.max[1] &&
        p[2] >= z.min[2] - 64 && p[2] <= z.max[2] + 64) return true;
  }
  return false;
}

// ── C4 bomb (Phase 6D) ───────────────────────────────────────────────────────
// Which bombsite (if any) a player is standing in. Bombsites come from the BSP hull
// (`bombsites:[{min,max,site}]`) with the same ±64 Z tolerance the client uses.
function _bombSiteAt(pl) {
  const sites = _hullData && _hullData.bombsites;
  if (!sites) return null;
  const p = pl.state.pos;
  for (const s of sites) {
    if (p[0] >= s.min[0] && p[0] <= s.max[0] && p[1] >= s.min[1] && p[1] <= s.max[1] &&
        p[2] >= s.min[2] - 64 && p[2] <= s.max[2] + 64) return s;
  }
  return null;
}
// Is a CT close enough to the planted bomb to defuse it? (same thresholds as the client)
function _nearBomb(pl, bomb) {
  const p = pl.state.pos, b = bomb.pos;
  return Math.hypot(p[0] - b[0], p[1] - b[1]) < 64 && Math.abs(p[2] - b[2]) < 80;
}
// Is a T close enough to a dropped C4 to pick it up? (walk-over radius)
function _nearDrop(pl, drop) {
  const p = pl.state.pos, b = drop.pos;
  return Math.hypot(p[0] - b[0], p[1] - b[1]) < 40 && Math.abs(p[2] - b[2]) < 72;
}

// C4 carrier drop + pickup (Phase 6D drop): if the carrier dies the bomb falls where they
// stood; any live T walking over it picks it up (becomes the new carrier). Runs every tick
// (a carrier can die in buy or live).
function _tickC4Carry(world) {
  if (world.match.bomb) { world.droppedC4 = null; return; }   // already planted → nothing loose
  for (const pl of world.players.values()) {
    if (pl.carryingC4 && !pl.alive) { pl.carryingC4 = false; world.droppedC4 = { pos: pl.state.pos.slice() }; }
  }
  if (world.droppedC4) {
    for (const pl of world.players.values()) {
      if (pl.team === 't' && pl.alive && _nearDrop(pl, world.droppedC4)) { pl.carryingC4 = true; world.droppedC4 = null; break; }
    }
  }
}

// Plant / defuse accumulation (server-authoritative, geometry-checked). Driven from the
// usercmd `use` (E) flag once per tick. Mutates the match bomb state; fills `ev` with
// roundEnd on a completed defuse (so the caller awards round money).
function worldTickBomb(world, dt, ev) {
  const ms = world.match;
  _tickC4Carry(world);                 // drop on death / pickup by a nearby T (any phase)
  if (ms.phase !== 'live') return;
  // PLANT: a T carrying C4, alive, on the ground, holding E inside a bombsite.
  if (!ms.bomb) {
    for (const pl of world.players.values()) {
      if (pl.team !== 't' || !pl.carryingC4 || !pl.alive) continue;
      const site = _bombSiteAt(pl);
      if (pl.use && pl.state.onGround && site) {
        pl.plantProg = (pl.plantProg || 0) + dt;
        if (pl.plantProg >= match.MATCH_PLANT_TIME) {
          pl.plantProg = 0; pl.carryingC4 = false;
          match.matchBombPlant(ms, pl.state.pos, site.site);
          pl.money = Math.min(match.MATCH_MONEY_CAP, pl.money + match.MATCH_PLANT_REWARD);
          ev.bombPlanted = true;     // force an immediate gstate so the bomb/sound appear at once
          break;
        }
      } else pl.plantProg = 0;
    }
  }
  // DEFUSE: while the bomb is live, a CT alive, on the ground, holding E next to it.
  if (ms.bomb && ms.bomb.live) {
    let defuser = null;
    for (const pl of world.players.values()) {
      if (pl.team === 'ct' && pl.alive && pl.use && pl.state.onGround && _nearBomb(pl, ms.bomb)) { defuser = pl; break; }
    }
    if (defuser) {
      ms.bomb.defuseProg = (ms.bomb.defuseProg || 0) + dt;
      ms.bomb._kit = !!defuser.dk;
      const need = defuser.dk ? match.MATCH_DEFUSE_KIT : match.MATCH_DEFUSE_TIME;
      if (ms.bomb.defuseProg >= need) match.matchBombDefuse(ms, ev);
    } else {
      ms.bomb.defuseProg = 0;
    }
  }
}

// C4 detonation blast: radius damage with linear falloff + a wall LOS check (same model as the
// client/HE grenades). Returns dmg events for the caller to broadcast. hg=2 → kevlar absorbs.
function worldC4Damage(world, origin) {
  const out = [];
  for (const pl of world.players.values()) {
    if (!pl.alive) continue;
    const c = [pl.state.pos[0], pl.state.pos[1], pl.state.pos[2] + 36];
    const dist = Math.hypot(c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]);
    if (dist > match.MATCH_C4_RADIUS) continue;
    if (_hull) { const tr = sim.simTraceMove(_hull, false, origin, c); if (tr.fraction < 0.7) continue; }
    const dmg = match.MATCH_C4_DAMAGE * (1 - dist / match.MATCH_C4_RADIUS);
    const r = match.matchApplyDamage(pl, dmg, 2);
    if (r.dealt > 0) out.push({ tid: pl.id, hg: 0, dealt: r.dealt, hp: pl.hp, died: r.died });
  }
  return out;
}

// Authoritative match state for a given recipient: shared bits (map/phase/timer/score/
// online) + that player's own HP/armor/alive (`me`).
function gameState(world, pl) {
  const ms = world.match;
  let online = 0;
  for (const p of world.players.values()) if (p.joined) online++;
  const gs = {
    t: 'gstate', map: ms.map, phase: ms.phase, round: ms.round,
    timer: Math.max(0, ms.timer), scoreT: ms.scoreT, scoreCT: ms.scoreCT,
    winner: ms.winner, reason: ms.reason, online, bombResult: ms.bombResult,
    bomb: ms.bomb ? {
      pos: ms.bomb.pos, site: ms.bomb.site, timer: Math.max(0, ms.bomb.timer),
      defuseProg: ms.bomb.defuseProg || 0,
      defuseNeed: ms.bomb._kit ? match.MATCH_DEFUSE_KIT : match.MATCH_DEFUSE_TIME,
    } : null,
    dropC4: world.droppedC4 ? world.droppedC4.pos : null,   // loose bomb on the ground (6D drop)
    roster: [],   // connected players for the scoreboard / kill feed (Phase 6E)
  };
  for (const p of world.players.values()) if (p.joined)
    gs.roster.push({ id: p.id, team: p.team, alive: !!p.alive, kills: p.kills, deaths: p.deaths });
  if (pl) gs.me = {
    hp: pl.hp, armor: pl.armor, helmet: !!pl.helmet, alive: !!pl.alive, team: pl.team,
    money: pl.money, weapons: [...pl.weapons], nades: pl.nades, dk: !!pl.dk,
    c4: !!pl.carryingC4, plantProg: pl.plantProg || 0,
  };
  return gs;
}

// ── Player-vs-player collision (solid bodies) ────────────────────────────────
// GoldSrc clips a player's move against other players' bboxes inside PM_Move. We
// approximate that with an authoritative separation pass: any two overlapping player
// AABBs get pushed apart along the axis of least penetration (half each). Players
// don't tunnel — a body is 32u wide and the per-tick step (≤~11u at run speed) is
// smaller — so this reads as solid. 🔹 Approximation vs. the original: soft (both
// shoved) rather than the mover stopping dead, and client-side it rubber-bands a touch
// until step D adds client player-solids. See docs/DIFFERENCES.md.
const _P_HW = 32;                                   // combined horizontal half-width (16+16)
function _pHullZ(ducked) { return ducked ? [-18, 18] : [-36, 36]; }

// Slide a player along one horizontal axis by delta, BSP-clamped so the push can't
// shove them through a wall, and kill any velocity heading into the contact.
function _pushPlayer(pl, axis, delta) {
  const st = pl.state;
  const to = [st.pos[0], st.pos[1], st.pos[2]];
  to[axis] += delta;
  const tr = sim.simTraceMove(_hull, st.phyDucked, st.pos, to);
  st.pos = tr.end;
  if (st.vel[axis] * delta < 0) st.vel[axis] = 0;
}

function resolveCollisions(world) {
  if (!_hull) return;
  const list = [...world.players.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].state, b = list[j].state;
      const dx = a.pos[0] - b.pos[0], dy = a.pos[1] - b.pos[1];
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax >= _P_HW || ay >= _P_HW) continue;            // no horizontal overlap
      const [az0, az1] = _pHullZ(a.phyDucked);
      const [bz0, bz1] = _pHullZ(b.phyDucked);
      if (a.pos[2] + az0 >= b.pos[2] + bz1 ||               // a stands on b's head
          a.pos[2] + az1 <= b.pos[2] + bz0) continue;       // a is under b
      const penX = _P_HW - ax, penY = _P_HW - ay;
      if (penX <= penY) {
        const s = dx >= 0 ? 1 : -1, push = penX / 2;
        _pushPlayer(list[i], 0,  s * push);
        _pushPlayer(list[j], 0, -s * push);
      } else {
        const s = dy >= 0 ? 1 : -1, push = penY / 2;
        _pushPlayer(list[i], 1,  s * push);
        _pushPlayer(list[j], 1, -s * push);
      }
    }
  }
}

// ── Lag compensation (server-side hitreg, step D) ────────────────────────────
// Each snapshot tick we record every player's authoritative origin + stance, tagged
// with the server time `svt`. A shot carries the `svt` the shooter was rendering its
// targets at (newestSnapshotSvt − interpolation delay), so we rewind targets to that
// exact moment before testing the ray — the shooter hits what they actually saw.
function worldRecordHistory(world, svt) {
  for (const pl of world.players.values()) {
    const s = pl.state;
    pl.hist.push({ svt, pos: [s.pos[0], s.pos[1], s.pos[2]], dk: s.phyDucked ? 1 : 0 });
    while (pl.hist.length && svt - pl.hist[0].svt > LAG_HISTORY_MS) pl.hist.shift();
  }
}

// Interpolate a player's recorded origin/stance back to server time `svt`.
function _rewindPlayer(pl, svt) {
  const h = pl.hist;
  if (!h.length) return { pos: pl.state.pos.slice(), dk: pl.state.phyDucked ? 1 : 0 };
  if (svt >= h[h.length - 1].svt) { const e = h[h.length - 1]; return { pos: e.pos.slice(), dk: e.dk }; }
  if (svt <= h[0].svt) return { pos: h[0].pos.slice(), dk: h[0].dk };
  for (let i = h.length - 1; i > 0; i--) {
    const b = h[i], a = h[i - 1];
    if (svt >= a.svt && svt <= b.svt) {
      const span = b.svt - a.svt;
      const f = span > 0 ? (svt - a.svt) / span : 0;
      return {
        pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * f,
              a.pos[1] + (b.pos[1] - a.pos[1]) * f,
              a.pos[2] + (b.pos[2] - a.pos[2]) * f],
        dk: f < 0.5 ? a.dk : b.dk,
      };
    }
  }
  const e = h[h.length - 1];
  return { pos: e.pos.slice(), dk: e.dk };
}

// Authoritative bullet hitreg for one shot. `msg` = { o:[x,y,z] gs origin, d:[x,y,z] gs
// dir, w:weaponId, s:silenced, svt:render time }. Rewinds every live target to `svt`,
// ray-tests the lag-comp box stack, orders hits by distance, applies penetration falloff
// AND the damage to each victim's authoritative HP. Returns [{ tid, hg, dealt, hp, died }].
function worldProcessShot(world, shooterId, msg) {
  const out = [];
  const o = msg && msg.o, d = msg && msg.d;
  if (!Array.isArray(o) || o.length !== 3 || !Array.isArray(d) || d.length !== 3) return out;
  const svt = (typeof msg.svt === 'number') ? msg.svt : Infinity;   // Infinity → latest (no rewind)
  const hits = [];
  for (const [tid, tp] of world.players) {
    if (tid === shooterId || !tp.alive) continue;
    const rp = _rewindPlayer(tp, svt);
    const r = combat.combatRayHitPlayer(o, d, rp.pos, !!rp.dk);
    if (r) hits.push({ tid, tp, hg: r.hg, dist: r.dist });
  }
  hits.sort((a, b) => a.dist - b.dist);
  let pen = 1;
  for (const h of hits) {
    const dmg = combat.combatDamage(msg.w, h.dist, h.hg, !!msg.s) * pen;
    const r = match.matchApplyDamage(h.tp, dmg, h.hg);
    if (r.dealt > 0) out.push({ tid: h.tid, hg: h.hg, dealt: r.dealt, hp: h.tp.hp, died: r.died });
    pen *= combat.COMBAT_PEN_MULT;
  }
  return out;
}

// ── WebSocket transport (only when run directly) ─────────────────────────────
function startServer(port) {
  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const SNAP_MS = 50;                      // 20 Hz authoritative snapshots
  const world = createWorld();
  const sockets = new Map();               // id → socket
  let _nextId = 1;

  const broadcast = (str) => { for (const s of sockets.values()) _send(s, str); };
  // Broadcast a damage/death event so the victim updates HP + others flinch/animate death.
  // On a death also tally K/D (scoreboard + kill feed, Phase 6E): victim +death, killer +kill
  // (only a different live player — fall/C4/world deaths credit no one).
  const dmgEvent = (vId, hg, by, dealt, hp, died, w) => {
    if (died) {
      const v = world.players.get(vId); if (v) v.deaths++;
      const k = world.players.get(by);  if (k && by !== vId) k.kills++;
    }
    broadcast(JSON.stringify({ t: 'dmg', id: vId, hg, by, dealt, hp, died, w }));
  };
  const _award = (pl, amount) => { pl.money = Math.min(match.MATCH_MONEY_CAP, pl.money + amount); };

  const server = http.createServer((req, res) => { res.writeHead(426); res.end('WebSocket only'); });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    _onClient(socket);
  });

  function _onClient(socket) {
    const id = _nextId++;
    sockets.set(id, socket);
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);

    worldAddPlayer(world, id, {});
    _send(socket, JSON.stringify({ t: 'welcome', id }));
    console.log(`[mp] client ${id} connected (${sockets.size} online)`);

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let frame;
      while ((frame = _readFrame(buf))) {
        buf = frame.rest;
        if (frame.opcode === 0x8) { socket.end(); return; }                  // close
        if (frame.opcode === 0x9) { _send(socket, frame.payload, 0xA); continue; } // ping→pong
        if (frame.opcode === 0x1 && frame.payload.length) {                  // text
          let msg; try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
          _onMsg(id, msg);
        }
      }
    });

    const drop = () => {
      if (!sockets.has(id)) return;
      sockets.delete(id);
      const lp = world.players.get(id);
      if (lp && lp.carryingC4 && !world.match.bomb) world.droppedC4 = { pos: lp.state.pos.slice() };   // carrier left → drop the bomb
      world.players.delete(id);
      broadcast(JSON.stringify({ t: 'leave', id }));
      console.log(`[mp] client ${id} left (${sockets.size} online)`);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  function _onMsg(id, msg) {
    if (msg.t === 'ping') {                               // app-level latency probe (works pre-join)
      const sk = sockets.get(id);
      if (sk) _send(sk, JSON.stringify({ t: 'pong', ts: msg.ts }));
      return;
    }
    const pl = world.players.get(id);
    if (!pl) return;
    switch (msg.t) {
      case 'hello': {                                     // join / team change / respawn
        let tm = msg.tm === 't' ? 't' : 'ct', model = msg.m;
        // Team-balance backstop (Phase 6E): never let a team get 2+ ahead. Honest clients already
        // balance in the menu; this catches the rest (reassign + a team-appropriate default model).
        let nt = 0, nct = 0;
        for (const p of world.players.values()) { if (!p.joined || p.id === id) continue; if (p.team === 't') nt++; else nct++; }
        const cur = tm === 't' ? nt : nct, oth = tm === 't' ? nct : nt;
        if ((cur + 1) - oth >= 2) { tm = tm === 't' ? 'ct' : 't'; model = tm === 't' ? 'leet' : 'gign'; }
        worldRespawn(pl, { tm, m: model, w: msg.w, p: msg.p, y: msg.y });
        break;
      }
      case 'cmd': {
        const apply = (c) => { const fe = worldApplyCmd(pl, c); if (fe) dmgEvent(id, 0, id, fe.dealt, pl.hp, fe.died, 'fall'); };
        if (Array.isArray(msg.cmds)) for (const c of msg.cmds) apply(c);
        else apply(msg);
        break;
      }
      case 'hit': {                                        // KNIFE: shooter-reported dmg, applied to server HP
        const tp = world.players.get(msg.target | 0);
        if (tp && (msg.target | 0) !== id && tp.alive) {
          const r = match.matchApplyDamage(tp, msg.dmg | 0, msg.hg | 0);
          if (r.dealt > 0) dmgEvent(tp.id, msg.hg | 0, id, r.dealt, tp.hp, r.died, 'knife');
          if (r.died) _award(pl, match.matchKillReward('knife'));
        }
        break;
      }
      case 'shot': {                                       // BULLETS: authoritative, lag-compensated hitreg
        const hits = worldProcessShot(world, id, msg);
        for (const h of hits) {
          dmgEvent(h.tid, h.hg, id, h.dealt, h.hp, h.died, msg.w);
          if (h.died) _award(pl, match.matchKillReward(msg.w));
        }
        break;
      }
      case 'buy': {                                        // server-validated purchase (Phase 6C)
        const sk = sockets.get(id);                        // _onMsg has no `socket` in scope — look it up
        if (!sk) break;
        if (world.match.phase !== 'buy') { _send(sk, JSON.stringify({ t: 'bought', ok: false, reason: 'Время закупки вышло' })); break; }
        if (!_inBuyZone(pl))             { _send(sk, JSON.stringify({ t: 'bought', ok: false, reason: 'Вы не в зоне закупки' })); break; }
        const r = match.matchBuy(pl, String(msg.id || ''));
        _send(sk, JSON.stringify({ t: 'bought', ok: r.ok, reason: r.reason || '', id: r.id, kind: r.kind, money: pl.money }));
        break;
      }
    }
  }

  // Broadcast authoritative snapshots; each client gets its own `ack`. Each tick stamps
  // a monotonic server time `svt` (for client interpolation + lag-comp rewind), records
  // lag-comp history, advances the match clock and broadcasts the game state.
  let _svt = 0, _lastMs = Date.now(), _gstateAcc = 0;
  const timer = setInterval(() => {
    if (sockets.size === 0) { _lastMs = Date.now(); return; }
    const now = Date.now();
    const dt = Math.min(0.25, Math.max(0, (now - _lastMs) / 1000));   // real elapsed (round clock accuracy)
    _lastMs = now;
    _svt += SNAP_MS;
    resolveCollisions(world);                 // solid bodies: separate overlapping players
    worldRecordHistory(world, _svt);          // lag-comp position history
    const ev = worldTickMatch(world, dt);     // round phases / timers / score / bomb
    if (ev.bombDmg) for (const h of ev.bombDmg) dmgEvent(h.tid, h.hg, 0, h.dealt, h.hp, h.died, 'c4');   // C4 blast
    const players = worldSnapshot(world);
    for (const [cid, socket] of sockets) {
      const pl = world.players.get(cid);
      _send(socket, JSON.stringify({ t: 'snap', ack: pl ? pl.lastSeq : 0, svt: _svt, players }));
    }
    // Game state ~5×/s, plus immediately on any round transition. Per-recipient (carries
    // that player's own HP/armor/alive in `me`).
    _gstateAcc += dt;
    if (ev.roundStart || ev.roundEnd || ev.bombPlanted || _gstateAcc >= 0.2) {
      _gstateAcc = 0;
      for (const [cid, socket] of sockets) _send(socket, JSON.stringify(gameState(world, world.players.get(cid))));
    }
  }, SNAP_MS);
  if (timer.unref) timer.unref();

  server.listen(port, () => console.log(`[mp] authoritative server on ws://localhost:${port}`));
  return server;
}

// ── Frame parsing (client→server frames are always masked) ───────────────────
// Returns { opcode, payload(Buffer), rest(Buffer) } for the first complete frame, or null.
function _readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;               // frame not fully arrived yet
  let payload;
  if (masked) {
    const mask = buf.slice(off, off + 4);
    payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
  } else {
    payload = buf.slice(off, off + len);
  }
  return { opcode, payload, rest: buf.slice(off + maskLen + len) };
}

// ── Frame writing (server→client frames are unmasked) ────────────────────────
function _send(socket, data, opcode = 0x1) {
  if (socket.destroyed) return;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

// Start the network server only when executed directly; `require` (tests) gets the
// pure world API instead.
if (require.main === module) {
  const PORT = process.env.MP_PORT ? Number(process.env.MP_PORT) : 8081;
  startServer(PORT);
}

module.exports = {
  createWorld, worldAddPlayer, worldRespawn, worldApplyCmd, worldSnapshot,
  snapshotEntry, resolveCollisions, worldRecordHistory, worldProcessShot,
  worldTickMatch, gameState, startServer,
};
