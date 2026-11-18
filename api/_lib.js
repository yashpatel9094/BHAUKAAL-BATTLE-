// Shared helpers: DB (Upstash/Vercel KV Redis REST, ya local dev ke liye memory), auth token, JSON handler
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.AUTH_SECRET || 'dev-secret-change-me';
const LOG_KEEP = 150;

/* ---------- Redis REST ---------- */
async function cmd(args) {
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
  pushLog: (room, str) => cmd(['EVAL', PUSH_LUA, '2', 'log:' + room, 'seq:' + room, str]),
  async readLog(room, cursor) {
    const a = (await cmd(['LRANGE', 'log:' + room, String(-LOG_KEEP), '-1'])) || [], out = [];
    for (const s of a) { const i = s.indexOf('|'), q = Number(s.slice(0, i)); if (q > cursor) out.push([q, s.slice(i + 1)]); }
    return out;
  },
};

/* ---------- Memory (local test) ---------- */
const M = global.__bbmem || (global.__bbmem = { kv: new Map(), h: new Map(), log: new Map(), seq: new Map() });
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
  async pushLog(room, str) { const s = await this.incr('seq:' + room); const l = M.log.get(room) || []; l.push([s, str]); while (l.length > LOG_KEEP) l.shift(); M.log.set(room, l); return s; },
  async readLog(room, cursor) { return (M.log.get(room) || []).filter(e => e[0] > cursor); },
};
const db = URL_ && TOK ? redisDb : memDb;

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
    try {
      const out = await fn(body || {});
      if (out && out.error) return send(out.code || 400, { error: out.error });
      send(200, out || { ok: true });
    } catch (e) { console.error(e); send(500, { error: 'Server error: ' + e.message }); }
  };
}

module.exports = { db, sign, verify, wrap, crypto };
