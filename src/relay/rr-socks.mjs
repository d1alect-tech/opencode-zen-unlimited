// Round-robin SOCKS5 relay: listens on 127.0.0.1:1090, forwards each TCP
// connection to the next upstream in 1081..1096 except 1090 (strict rotation).
// No auth on the front; upstreams are trusted localhost. TCP CONNECT only.
import net from 'net';
import fs from 'node:fs';

// Rotation authority is the gateway inline layer (src/gateway/rotation.ts).
// This relay is a dumb round-robin/sticky-pin diagnostic port: no watcher,
// no second rotation opinion. A dead 429-watcher lived here until it was
// removed (its proxy-logs contract never matched the gateway shape, so it
// never fired once).
const ATTR_LOG = process.env.RR_ATTR_LOG || null;
const PINNED_SUFFIX = 'opencode.ai';

let pinnedIdx = 1; // UPSTREAMS[1] = 1082 (DE), initial sticky egress
const cooldownUntil = new Map(); // port -> epoch ms

const isPinnedHost = (host) => host === PINNED_SUFFIX || String(host).endsWith('.' + PINNED_SUFFIX);
const isCooled = (port) => (cooldownUntil.get(port) || 0) > Date.now();
function pickPinned() {
  if (!isCooled(UPSTREAMS[pinnedIdx].port)) return UPSTREAMS[pinnedIdx];
  for (let k = 1; k <= UPSTREAMS.length; k++) {
    const idx = (pinnedIdx + k) % UPSTREAMS.length;
    if (!isCooled(UPSTREAMS[idx].port)) { pinnedIdx = idx; return UPSTREAMS[idx]; }
  }
  return UPSTREAMS[pinnedIdx];
}
function noteAttr(line) { if (ATTR_LOG) fs.appendFileSync(ATTR_LOG, line + '\n'); }

const UPSTREAMS = [1081, 1082, 1083, 1084, 1087, 1088, 1091, 1093, 1097, 1099, 1100].map(p => ({ host: '127.0.0.1', port: p }));
let cursor = 0;
const next = () => UPSTREAMS[(cursor++) % UPSTREAMS.length];

function socks5Handshake(client, onTarget) {
  let stage = 0, buf = Buffer.alloc(0);
  const fail = () => client.destroy();
  client.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 0) {
      if (buf.length < 2) return;
      const n = buf[1];
      if (buf.length < 2 + n) return;
      buf = buf.slice(2 + n);
      client.write(Buffer.from([0x05, 0x00])); // no-auth
      stage = 1;
    }
    if (stage === 1) {
      if (buf.length < 4) return;
      const atyp = buf[3];
      let addr, off;
      if (atyp === 0x01) { // IPv4
        if (buf.length < 10) return;
        addr = [...buf.slice(4, 8)].join('.'); off = 8;
      } else if (atyp === 0x03) { // domain
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        addr = buf.slice(5, 5 + len).toString(); off = 5 + len;
      } else if (atyp === 0x04) { // IPv6
        if (buf.length < 22) return;
        addr = buf.slice(4, 20).toString('hex').replace(/(.{4})(?=.)/g, '$1:'); off = 20;
      } else return fail();
      const port = buf.readUInt16BE(off);
      const rest = buf.slice(off + 2);
      buf = Buffer.alloc(0);
      client.removeAllListeners('data');
      onTarget(addr, port, rest);
    }
  });
  client.on('error', fail);
}

function socks5Dial(up, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(up.port, up.host, () => {
      s.write(Buffer.from([0x05, 0x01, 0x00])); // greeting, no-auth
      let step = 0, b = Buffer.alloc(0);
      s.on('data', (c) => {
        b = Buffer.concat([b, c]);
        if (step === 0 && b.length >= 2) {
          // send CONNECT (domain form for simplicity)
          const hb = Buffer.from(host);
          const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
          s.write(req); step = 1; b = Buffer.alloc(0);
        } else if (step === 1 && b.length >= 10) {
          if (b[1] !== 0x00) return reject(new Error('upstream socks err ' + b[1]));
          s.removeAllListeners('data');
          resolve(s);
        }
      });
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error('upstream timeout')), 15000);
  });
}

const server = net.createServer((client) => {
  socks5Handshake(client, async (host, port, rest) => {
    const pinned = isPinnedHost(host);
    const up = pinned ? pickPinned() : next();
    try {
      const u = await socks5Dial(up, host, port);
      if (ATTR_LOG) fs.appendFileSync(ATTR_LOG, `${new Date().toISOString()} up=${up.port} target=${host}:${port}${pinned ? ' pinned=1' : ''}\n`);
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // success
      if (rest.length) u.write(rest);
      client.pipe(u); u.pipe(client);
      const tag = `${up.port}`;
      client.on('close', () => u.destroy());
      u.on('close', () => client.destroy());
      client.on('error', () => u.destroy());
      u.on('error', () => client.destroy());
    } catch {
      try { client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) } catch {}
      client.destroy();
    }
  });
});
server.listen(1090, '127.0.0.1', () => { console.log('rr-socks listening 127.0.0.1:1090'); });
server.on('error', (e) => { console.error('FATAL', e.message); process.exit(1); });
