// Round-robin SOCKS5 relay: listens on 127.0.0.1:1090, forwards each TCP
// connection to the next upstream in 1081..1086 (strict rotation).
// No auth on the front; upstreams are trusted localhost. TCP CONNECT only.
import net from 'net';
import fs from 'node:fs';

const ATTR_LOG = process.env.RR_ATTR_LOG || null;
const WATCH_TOKEN = process.env.RR_WATCH_TOKEN || null;
const WATCH_URL = process.env.RR_WATCH_URL || 'http://localhost:20128/api/usage/proxy-logs?limit=20';
const WATCH_INTERVAL_MS = Number(process.env.RR_WATCH_INTERVAL_MS || 15000);
const COOLDOWN_MS = Number(process.env.RR_COOLDOWN_MS || 15 * 60 * 1000);
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
const LIMIT_RE = /429|rate.?limited|rate.?limit|quota|freeusagelimit|usage.?limit/i;
async function pollLimitsOnce() {
  if (!WATCH_TOKEN) return;
  let rows = null;
  try {
    const res = await fetch(WATCH_URL, { headers: { Authorization: `Bearer ${WATCH_TOKEN}` } });
    if (!res.ok) return;
    rows = await res.json();
  } catch { return; }
  if (!Array.isArray(rows)) return;
  const fresh = Date.now() - 90000;
  const hit = rows.find((x) => x && x.status === 'error'
    && ((x.provider || '').includes('opencode') || String(x.targetUrl || '').includes('opencode'))
    && LIMIT_RE.test(String(x.error || ''))
    && new Date(x.timestamp).getTime() > fresh);
  if (!hit) return;
  const cur = UPSTREAMS[pinnedIdx].port;
  cooldownUntil.set(cur, Date.now() + COOLDOWN_MS);
  for (let k = 1; k <= UPSTREAMS.length; k++) {
    const idx = (pinnedIdx + k) % UPSTREAMS.length;
    if (!isCooled(UPSTREAMS[idx].port)) { pinnedIdx = idx; break; }
  }
  noteAttr(`${new Date().toISOString()} ROTATE from=${cur} to=${UPSTREAMS[pinnedIdx].port} reason=${String(hit.error).slice(0, 80)}`);
  console.log(`rr-socks 429-rotate ${cur} -> ${UPSTREAMS[pinnedIdx].port}`);
}
function startWatcher() {
  if (!WATCH_TOKEN) { console.log('rr-socks watcher disabled (no RR_WATCH_TOKEN)'); noteAttr(`${new Date().toISOString()} watcher=disabled`); return; }
  console.log(`rr-socks watcher on ${WATCH_URL} every ${WATCH_INTERVAL_MS}ms`);
  noteAttr(`${new Date().toISOString()} watcher=started interval=${WATCH_INTERVAL_MS}ms cooldown=${COOLDOWN_MS}ms`);
  const loop = async () => { try { await pollLimitsOnce(); } finally { setTimeout(loop, WATCH_INTERVAL_MS); } };
  setTimeout(loop, WATCH_INTERVAL_MS);
}

const UPSTREAMS = [1081, 1082, 1083, 1084, 1085, 1086].map(p => ({ host: '127.0.0.1', port: p }));
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
server.listen(1090, '127.0.0.1', () => { console.log('rr-socks listening 127.0.0.1:1090'); startWatcher(); });
server.on('error', (e) => { console.error('FATAL', e.message); process.exit(1); });
