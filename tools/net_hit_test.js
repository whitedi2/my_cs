// net_hit_test.js — end-to-end test of the authoritative KNIFE path over the real WS:
// client A sends {t:'hit', target:<B id>, hg, dmg}; the server applies it to B's
// server-side HP (Phase 6B) and broadcasts a {t:'dmg', id:B, by:A, dealt, hp, w:'knife'}
// to everyone. We assert the broadcast + the HP math (100→70).
//
// Run:  node tools/net_hit_test.js     (exit 0 = pass)

const net    = require('net');
const crypto = require('crypto');
const srv    = require('../server.js');

const PORT = 18098;
let failures = 0;
const check = (name, cond, extra) => {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

function wsSendText(sock, str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  sock.write(Buffer.concat([header, mask, masked]));
}
function readFrames(buf) {
  const out = []; let rest = buf;
  for (;;) {
    if (rest.length < 2) break;
    const opcode = rest[0] & 0x0f;
    let len = rest[1] & 0x7f, off = 2;
    if (len === 126) { if (rest.length < 4) break; len = rest.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (rest.length < 10) break; len = Number(rest.readBigUInt64BE(2)); off = 10; }
    if (rest.length < off + len) break;
    if (opcode === 0x1) out.push(rest.slice(off, off + len).toString('utf8'));
    rest = rest.slice(off + len);
  }
  return { frames: out, rest };
}

function connect(onMsg) {
  const sock = net.connect(PORT, '127.0.0.1', () => {
    const key = crypto.randomBytes(16).toString('base64');
    sock.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  let buf = Buffer.alloc(0), hs = false;
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!hs) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; buf = buf.slice(i + 4); hs = true; }
    const r = readFrames(buf); buf = r.rest;
    for (const f of r.frames) { let m; try { m = JSON.parse(f); } catch { continue; } onMsg(m); }
  });
  return sock;
}

const server = srv.startServer(PORT);
server.on('listening', () => {
  let aId = null, bId = null;
  let aDmg = null, bDmg = null;   // the server's `dmg` event is broadcast to everyone

  const a = connect((m) => { if (m.t === 'welcome') aId = m.id; if (m.t === 'dmg') aDmg = m; });
  const b = connect((m) => { if (m.t === 'welcome') bId = m.id; if (m.t === 'dmg') bDmg = m; });

  // Once both have ids: A reports a KNIFE hit on B; the server applies it to B's HP and
  // broadcasts a `dmg` event (both clients see it).
  const fire = setInterval(() => {
    if (aId == null || bId == null) return;
    clearInterval(fire);
    wsSendText(a, JSON.stringify({ t: 'hit', target: bId, hg: 2, dmg: 30 }));
    setTimeout(() => {
      check('damage event broadcast', !!bDmg && !!aDmg);
      check('dmg targets the victim', bDmg && bDmg.id === bId, bDmg ? `id=${bDmg.id}` : '');
      check('dmg names the attacker', bDmg && bDmg.by === aId, bDmg ? `by=${bDmg.by}` : '');
      check('server applied 30 to HP (100→70)', bDmg && bDmg.dealt === 30 && bDmg.hp === 70,
            bDmg ? `dealt=${bDmg.dealt} hp=${bDmg.hp}` : '');
      check('knife weapon tag', bDmg && bDmg.w === 'knife', bDmg ? `w=${bDmg.w}` : '');
      check('not a kill', bDmg && bDmg.died === false);
      a.destroy(); b.destroy(); server.close();
      console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
      process.exit(failures === 0 ? 0 : 1);
    }, 150);
  }, 10);
});
server.on('error', (e) => { console.error('server error', e); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 5000).unref();
