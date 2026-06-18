// net_smoke.js — end-to-end transport smoke test for the authoritative server.
//
// Starts the real WebSocket server (server.js) on a throwaway port, connects with a
// hand-rolled WS client (Node has no built-in WS client; the server speaks raw
// RFC-6455), sends a `hello` + a stream of `cmd`s, and verifies we get a `welcome`
// and `snap`s whose `ack` advances and whose position moves as we walk forward.
//
// Run:  node tools/net_smoke.js     (exit code 0 = pass, 1 = fail)

const net    = require('net');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const srv    = require('../server.js');

const PORT = 18099;
const hullData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'maps', 'de_dust2_hull.json'), 'utf8'));
const SP = hullData.spawns.ct[0];                          // real on-ground spawn
const SP_POS = [SP.origin[0], SP.origin[1], SP.origin[2] + 1];
const SP_YAW = ((SP.angle || 0) - 90) * Math.PI / 180;     // walk the way the spawn faces (open space)
let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}
function done() {
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── Minimal WS client framing ────────────────────────────────────────────────
function wsSendText(sock, str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) { header = Buffer.from([0x81, 0x80 | len]); }
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  sock.write(Buffer.concat([header, mask, masked]));
}

// Server→client frames are unmasked. Pull complete text frames out of a buffer.
function readFrames(buf) {
  const out = [];
  let rest = buf;
  for (;;) {
    if (rest.length < 2) break;
    const opcode = rest[0] & 0x0f;
    let len = rest[1] & 0x7f, off = 2;
    if (len === 126) { if (rest.length < 4) break; len = rest.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (rest.length < 10) break; len = Number(rest.readBigUInt64BE(2)); off = 10; }
    if (rest.length < off + len) break;
    const payload = rest.slice(off, off + len);
    rest = rest.slice(off + len);
    if (opcode === 0x1) out.push(payload.toString('utf8'));
  }
  return { frames: out, rest };
}

const server = srv.startServer(PORT);

server.on('listening', () => {
  const sock = net.connect(PORT, '127.0.0.1', () => {
    const key = crypto.randomBytes(16).toString('base64');
    sock.write(
      'GET / HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n');
  });

  let buf = Buffer.alloc(0);
  let handshakeDone = false;
  let gotWelcome = false;
  const snaps = [];
  let seq = 0, sendTimer = null;

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshakeDone) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.slice(0, i).toString('utf8');
      check('server completes WS handshake', /101 Switching Protocols/.test(head));
      buf = buf.slice(i + 4);
      handshakeDone = true;

      // Join at a real on-ground spawn, then walk the way it faces for ~1s @100 Hz.
      wsSendText(sock, JSON.stringify({ t: 'hello', m: 'gign', tm: 'ct', p: SP_POS, y: SP_YAW }));
      sendTimer = setInterval(() => {
        seq++;
        wsSendText(sock, JSON.stringify({ t: 'cmd', seq, dt: 1 / 100, fm: 1, y: SP_YAW, ws: 250 }));
        if (seq >= 100) clearInterval(sendTimer);
      }, 5);
    }
    const r = readFrames(buf); buf = r.rest;
    for (const f of r.frames) {
      let m; try { m = JSON.parse(f); } catch { continue; }
      if (m.t === 'welcome') { gotWelcome = true; check('received welcome with id', m.id > 0, `id=${m.id}`); }
      else if (m.t === 'snap') snaps.push(m);
    }
  });

  // Evaluate after the cmd stream has been processed and a few snapshots arrived.
  setTimeout(() => {
    check('received welcome', gotWelcome);
    check('received snapshots', snaps.length > 0, `count=${snaps.length}`);
    const first = snaps[0] && (snaps[0].players || [])[0];
    const last  = snaps[snaps.length - 1];
    const me = last && (last.players || []).find(p => p.id > 0);
    check('snapshot ack advanced', last && last.ack > 0, last ? `ack=${last.ack}` : '');
    const moved = (first && me) ? Math.hypot(me.p[0] - first.p[0], me.p[1] - first.p[1]) : 0;
    check('walking moved us horizontally', moved > 20, `moved=${moved.toFixed(1)}u`);
    sock.destroy();
    server.close();
    done();
  }, 900);
});

server.on('error', (e) => { console.error('server error', e); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 5000).unref();
