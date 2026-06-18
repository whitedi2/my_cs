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
const CONFIG = require('./config.js');

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

function createWorld() { return { players: new Map() }; }

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
  };
  world.players.set(id, pl);
  return pl;
}

// Re-place a player (team change / respawn). Resets velocity & spawn pose.
function worldRespawn(pl, opts = {}) {
  if (opts.tm) pl.team = opts.tm === 't' ? 't' : 'ct';
  if (opts.m)  pl.model = opts.m;
  if (opts.w)  pl.weapon = opts.w;
  const sp = opts.p ? { pos: opts.p.slice(), yaw: opts.y || 0 } : _pickSpawn(pl.team);
  pl.state = sim.simMakeState(sp.pos);
  pl.yaw = sp.yaw;
}

// Advance one player by a single usercmd. Ignores stale/duplicate seq. dt clamped
// so a client can't fast-forward the sim with a huge dt.
function worldApplyCmd(pl, c) {
  if (!_hull || !c || (c.seq | 0) <= pl.lastSeq) return;
  const dt = Math.max(0, Math.min(c.dt || 0, 0.1));
  pl.yaw = c.y || 0;
  if (c.w) pl.weapon = c.w;
  const cmd = {
    forwardMove: c.fm || 0, sideMove: c.sm || 0,
    jump: !!c.jp, duck: !!c.dk, walk: !!c.wk, yaw: pl.yaw,
  };
  sim.simPlayerMove(_hull, pl.state, cmd, dt, { wpnMax: c.ws || CONFIG.maxspeed });
  pl.lastSeq = c.seq | 0;
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
    m: pl.model, tm: pl.team, w: pl.weapon,
  };
}

function worldSnapshot(world) {
  const players = [];
  for (const pl of world.players.values()) players.push(snapshotEntry(pl));
  return players;
}

// ── WebSocket transport (only when run directly) ─────────────────────────────
function startServer(port) {
  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const SNAP_MS = 50;                      // 20 Hz authoritative snapshots
  const world = createWorld();
  const sockets = new Map();               // id → socket
  let _nextId = 1;

  const broadcast = (str) => { for (const s of sockets.values()) _send(s, str); };

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
      world.players.delete(id);
      broadcast(JSON.stringify({ t: 'leave', id }));
      console.log(`[mp] client ${id} left (${sockets.size} online)`);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  function _onMsg(id, msg) {
    const pl = world.players.get(id);
    if (!pl) return;
    switch (msg.t) {
      case 'hello':                                       // join / team change / respawn
        worldRespawn(pl, { tm: msg.tm, m: msg.m, w: msg.w, p: msg.p, y: msg.y });
        break;
      case 'cmd':
        if (Array.isArray(msg.cmds)) for (const c of msg.cmds) worldApplyCmd(pl, c);
        else worldApplyCmd(pl, msg);
        break;
      case 'hit': {                                        // shooter-reported hit → forward to victim
        const tgt = sockets.get(msg.target | 0);
        if (tgt && (msg.target | 0) !== id)
          _send(tgt, JSON.stringify({ t: 'hit', dmg: msg.dmg | 0, hg: msg.hg | 0, from: id }));
        break;
      }
    }
  }

  // Broadcast authoritative snapshots; each client gets its own `ack`.
  const timer = setInterval(() => {
    if (sockets.size === 0) return;
    const players = worldSnapshot(world);
    for (const [cid, socket] of sockets) {
      const pl = world.players.get(cid);
      _send(socket, JSON.stringify({ t: 'snap', ack: pl ? pl.lastSeq : 0, players }));
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
  snapshotEntry, startServer,
};
