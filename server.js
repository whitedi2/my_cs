// server.js — minimal multiplayer relay for the CS 1.6 clone (Phase 5, step 1).
//
// ZERO dependencies (keeps the project's "no npm" rule): a hand-rolled RFC-6455
// WebSocket server on top of Node's built-in http/crypto. It is a dumb RELAY — clients
// send their own state snapshots and the server rebroadcasts them to everyone else
// (non-authoritative; trusts clients). Good enough to see/【shoot】 other players move;
// authoritative physics / server-side hit-reg is a later step (see docs/PLAN.md).
//
// Run:  node server.js        (listens on ws://localhost:8081 by default)
// The game page is still served by python serve.py on :8080 — this is a separate process.

const http   = require('http');
const crypto = require('crypto');

const PORT = process.env.MP_PORT ? Number(process.env.MP_PORT) : 8081;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let _nextId = 1;
const clients = new Map();   // id → { socket, alive }

const server = http.createServer((req, res) => { res.writeHead(426); res.end('WebSocket only'); });

// ── HTTP→WS upgrade (compute Sec-WebSocket-Accept and switch protocols) ──────
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
  clients.set(id, { socket });
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);

  _send(socket, JSON.stringify({ t: 'welcome', id }));
  _broadcast(id, JSON.stringify({ t: 'join', id }));
  // Tell the newcomer who is already here, so existing players pop in immediately.
  for (const otherId of clients.keys())
    if (otherId !== id) _send(socket, JSON.stringify({ t: 'join', id: otherId }));
  console.log(`[mp] client ${id} connected (${clients.size} online)`);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let frame;
    while ((frame = _readFrame(buf))) {
      buf = frame.rest;
      if (frame.opcode === 0x8) { socket.end(); return; }          // close
      if (frame.opcode === 0x9) { _send(socket, frame.payload, 0xA); continue; } // ping→pong
      if (frame.opcode === 0x1 && frame.payload.length) {          // text
        // Re-stamp with the sender id and relay verbatim to everyone else.
        let msg;
        try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
        msg.id = id;
        _broadcast(id, JSON.stringify(msg));
      }
    }
  });

  const drop = () => {
    if (!clients.has(id)) return;
    clients.delete(id);
    _broadcast(id, JSON.stringify({ t: 'leave', id }));
    console.log(`[mp] client ${id} left (${clients.size} online)`);
  };
  socket.on('close', drop);
  socket.on('error', drop);
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

function _broadcast(exceptId, str) {
  for (const [cid, c] of clients) if (cid !== exceptId) _send(c.socket, str);
}

server.listen(PORT, () => console.log(`[mp] relay listening on ws://localhost:${PORT}`));
