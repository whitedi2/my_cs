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
let liveAt = null, liveIdx = 0, phase = null;
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

      // Join at a real on-ground spawn and hold "forward" the whole time @100 Hz. The round opens
      // with the freeze (MATCH_FREEZE_TIME): the server must NOT move us then; once gstate says
      // 'live' the same input has to walk us.
      wsSendText(sock, JSON.stringify({ t: 'hello', m: 'gign', tm: 'ct', p: SP_POS, y: SP_YAW }));
      sendTimer = setInterval(() => {
        seq++;
        wsSendText(sock, JSON.stringify({ t: 'cmd', seq, dt: 1 / 100, fm: 1, y: SP_YAW, ws: 250 }));
      }, 10);
    }
    const r = readFrames(buf); buf = r.rest;
    for (const f of r.frames) {
      let m; try { m = JSON.parse(f); } catch { continue; }
      if (m.t === 'welcome') { gotWelcome = true; check('received welcome with id', m.id > 0, `id=${m.id}`); }
      else if (m.t === 'gstate') { if (m.phase === 'live' && liveAt === null) { liveAt = Date.now(); liveIdx = snaps.length; } phase = m.phase; }
      else if (m.t === 'snap') { m._phase = phase; snaps.push(m); }
    }
  });

  // Evaluate ~1 s after the freeze ends (or give up after 12 s).
  const t0 = Date.now();
  const evalTimer = setInterval(() => {
    const ready = liveAt !== null && Date.now() - liveAt > 1000;
    if (!ready && Date.now() - t0 < 12000) return;
    clearInterval(evalTimer); clearInterval(sendTimer);
    check('received welcome', gotWelcome);
    check('received snapshots', snaps.length > 0, `count=${snaps.length}`);
    const myPos = sn => { const p = sn && (sn.players || []).find(q => q.id > 0); return p && p.p; };
    // gstate (phase) arrives at 5 Hz vs 20 Hz snapshots, so the last few 'buy'-tagged snaps are
    // already live — drop that 0.25 s tail. What remains may creep ≪1 u: CS freeze is maxspeed 1.
    const frz = snaps.filter(sn => sn._phase === 'buy' && myPos(sn)).slice(0, -5);
    const frzMoved = frz.length > 1 ? Math.hypot(myPos(frz[frz.length - 1])[0] - myPos(frz[0])[0], myPos(frz[frz.length - 1])[1] - myPos(frz[0])[1]) : 0;
    let maxStep = 0, stepAt = -1;
    for (let i = 1; i < frz.length; i++) { const d = Math.hypot(myPos(frz[i])[0] - myPos(frz[i - 1])[0], myPos(frz[i])[1] - myPos(frz[i - 1])[1]); if (d > maxStep) { maxStep = d; stepAt = i; } }
    check('freeze time: holding forward does not move us', frz.length > 1 && frzMoved < 1, `moved=${frzMoved.toFixed(2)}u over ${frz.length} snaps (max step ${maxStep.toFixed(2)} at #${stepAt})`);
    check('the round goes live after the freeze', liveAt !== null);
    const last = snaps[snaps.length - 1];
    check('snapshot ack advanced', last && last.ack > 0, last ? `ack=${last.ack}` : '');
    const a = myPos(snaps[liveIdx]), b = myPos(last);
    const moved = (a && b) ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    check('live: walking moved us horizontally', moved > 20, `moved=${moved.toFixed(1)}u`);
    sock.destroy();
    server.close();
    done();
  }, 100);
});

server.on('error', (e) => { console.error('server error', e); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 15000).unref();   // covers the 5 s freeze + 1 s of walking
