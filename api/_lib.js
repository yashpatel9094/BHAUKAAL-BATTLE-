// Shared helpers: DB (Upstash/Vercel KV Redis REST, ya local dev ke liye memory), auth token, JSON handler
const crypto = require('crypto');

// Vercel integration kabhi prefix lagata hai (jaise STORAGE_KV_REST_API_URL), isliye naam ke ant se dhundho
const findEnv = re => { const k = Object.keys(process.env).find(n => re.test(n) && process.env[n]); return k ? process.env[k] : undefined; };
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || findEnv(/(KV_REST_API_URL|UPSTASH_REDIS_REST_URL)$/);
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || findEnv(/(KV_REST_API_TOKEN|UPSTASH_REDIS_REST_TOKEN)$/);
const SECRET = process.env.AUTH_SECRET || 'dev-secret-change-me';
const LOG_KEEP = 150;

// Normal redis:// (TCP) URL, jaise Vercel ke "Redis" integration ka REDIS_URL
const REDIS_URL = [process.env.REDIS_URL, findEnv(/(^|_)REDIS_URL$/)].find(v => v && /^rediss?:\/\//.test(v));
const USE_REST = !!(URL_ && TOK);

/* ---------- Redis (REST ya TCP) ---------- */
let _tcp = null;
async function tcpClient() {
  if (_tcp && _tcp.c.isOpen) return _tcp.c;
  const { createClient } = require('redis');
  const c = createClient({ url: REDIS_URL, socket: { connectTimeout: 6000 } });
  c.on('error', e => console.error('redis:', e.message));
  _tcp = { c };
  await c.connect();
  return c;
}
async function cmd(args) {
  if (!USE_REST) {
    const c = await tcpClient();
    return c.sendCommand(args.map(String));
  }
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOK }, body: JSON.stringify(args) });
  const j = await r.json();
  if (j.error) throw new Error('DB: ' + j.error);
  return j.result;
}
const PUSH_LUA = "local s=redis.call('INCR',KEYS[2]) redis.call('RPUSH',KEYS[1],s..'|'..ARGV[1]) redis.call('LTRIM',KEYS[1],-" + LOG_KEEP + ",-1) redis.call('EXPIRE',KEYS[1],7200) redis.call('EXPIRE',KEYS[2],7200) return s";
const redisDb = {
  kind: 'redis',
  get: k => cmd(['GET', k]),
  async set(k, v, o = {}) { const a = ['SET', k, v]; if (o.ex) a.push('EX', String(o.ex)); if (o.nx) a.push('NX'); return (await cmd(a)) === 'OK'; },
  del: k => cmd(['DEL', k]),
  async hset(k, f, v) { await cmd(['HSET', k, f, v]); await cmd(['EXPIRE', k, '7200']); },
  hget: (k, f) => cmd(['HGET', k, f]),
  async hgetall(k) { const a = (await cmd(['HGETALL', k])) || [], o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; },
  hdel: (k, f) => cmd(['HDEL', k, f]),
  async hlen(k) { return Number(await cmd(['HLEN', k])) || 0; },
  async incr(k) { const n = Number(await cmd(['INCR', k])); await cmd(['EXPIRE', k, '7200']); return n; },
  zadd: (k, score, member) => cmd(['ZADD', k, String(score), member]),
  async zrevrange(k, a, b) { const r = (await cmd(['ZREVRANGE', k, String(a), String(b), 'WITHSCORES'])) || [], o = []; for (let i = 0; i < r.length; i += 2) o.push([r[i], Number(r[i + 1])]); return o; },
  pushLog: (room, str) => cmd(['EVAL', PUSH_LUA, '2', 'log:' + room, 'seq:' + room, str]),
  async readLog(room, cursor) {
    const a = (await cmd(['LRANGE', 'log:' + room, String(-LOG_KEEP), '-1'])) || [], out = [];
    for (const s of a) { const i = s.indexOf('|'), q = Number(s.slice(0, i)); if (q > cursor) out.push([q, s.slice(i + 1)]); }
    return out;
  },
};

/* ---------- Memory (local test) ---------- */
const M = global.__bbmem || (global.__bbmem = { kv: new Map(), h: new Map(), log: new Map(), seq: new Map(), z: new Map() });
const memDb = {
  kind: 'memory',
  async get(k) { return M.kv.has(k) ? M.kv.get(k) : null; },
  async set(k, v, o = {}) { if (o.nx && M.kv.has(k)) return false; M.kv.set(k, v); return true; },
  async del(k) { M.kv.delete(k); M.h.delete(k); },
  async hset(k, f, v) { if (!M.h.has(k)) M.h.set(k, new Map()); M.h.get(k).set(f, v); },
  async hget(k, f) { const h = M.h.get(k); return h && h.has(f) ? h.get(f) : null; },
  async hgetall(k) { return Object.fromEntries(M.h.get(k) || []); },
  async hdel(k, f) { const h = M.h.get(k); if (h) h.delete(f); },
  async hlen(k) { return (M.h.get(k) || new Map()).size; },
  async incr(k) { const n = (M.seq.get(k) || 0) + 1; M.seq.set(k, n); return n; },
  async zadd(k, score, member) { const m = M.z.get(k) || (M.z.set(k, new Map()), M.z.get(k)); m.set(member, Number(score)); },
  async zrevrange(k, a, b) { return [...(M.z.get(k) || new Map())].sort((x, y) => y[1] - x[1]).slice(a, b + 1); },
  async pushLog(room, str) { const s = await this.incr('seq:' + room); const l = M.log.get(room) || []; l.push([s, str]); while (l.length > LOG_KEEP) l.shift(); M.log.set(room, l); return s; },
  async readLog(room, cursor) { return (M.log.get(room) || []).filter(e => e[0] > cursor); },
};
const db = USE_REST || REDIS_URL ? redisDb : memDb;

/* ---------- tokens ---------- */
const b64 = s => Buffer.from(s).toString('base64url');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function sign(obj, ttlSec) {
  const p = b64(JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return p + '.' + hmac(p);
}
function verify(tok) {
  try {
    const [p, s] = String(tok).split('.');
    if (!p || !s || hmac(p) !== s) return null;
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    return o.exp > Date.now() / 1000 ? o : null;
  } catch { return null; }
}

/* ---------- handler wrapper ---------- */
function wrap(fn) {
  return async (req, res) => {
    const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    // Vercel par memory DB chalega nahi (har request alag instance par ja sakti hai) -> room "gayab" ho jate hain
    if (process.env.VERCEL && db.kind === 'memory') return send(500, { error: 'Database (Upstash Redis / KV) project se connect nahi hai. Vercel > Storage mein Redis banake Connect karo, phir Redeploy.' });
    try {
      const out = await fn(body || {});
      if (out && out.error) return send(out.code || 400, { error: out.error });
      send(200, out || { ok: true });
    } catch (e) { console.error(e); send(500, { error: 'Server error: ' + e.message }); }
  };
}

module.exports = { db, sign, verify, wrap, crypto };
