// Rooms: create / join / status / leave.  Min 4 players -> 30 sec countdown -> match. Max 30.
const { db, sign, verify, wrap, crypto } = require('./_lib');
const MIN = 4, MAX = 30, WAIT_MS = 30000;
const CODE_CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 5 }, () => CODE_CH[Math.floor(Math.random() * CODE_CH.length)]).join('');
const rtoken = (u, c, id) => sign({ u, c, id }, 3 * 3600);

async function getStatus(code) {
  const raw = await db.get('room:' + code);
  if (!raw) return null;
  const meta = JSON.parse(raw);
  const players = Object.values(await db.hgetall('rp:' + code)).map(s => JSON.parse(s)).sort((a, b) => a.id - b.id);
  const st = await db.get('rs:' + code), startAt = st ? Number(st) : 0, now = Date.now();
  const host = players.find(p => p.name === meta.host) || players[0] || null, map = meta.map === 'registan' ? 'registan' : 'gaon';
  const seed = parseInt(crypto.createHash('md5').update(code + ':' + startAt).digest('hex').slice(0, 7), 16);
  return {
    code, map, players, hostId: host ? host.id : 0, min: MIN, max: MAX, now, startAt,
    started: !!startAt && now >= startAt, secs: startAt ? Math.max(0, Math.ceil((startAt - now) / 1000)) : 0, seed,
  };
}

async function afterCountChange(code) {
  const n = await db.hlen('rp:' + code);
  if (n >= MAX) await db.set('rs:' + code, String(Date.now()), { ex: 7200 });          // full -> turant shuru
  else if (n >= MIN) await db.set('rs:' + code, String(Date.now() + WAIT_MS), { nx: true, ex: 7200 }); // 4 hote hi 30 sec
  return n;
}

module.exports = wrap(async b => {
  const { action } = b;

  if (action === 'status') {
    const s = await getStatus(String(b.code || '').toUpperCase());
    return s ? { ok: true, ...s } : { error: 'Room nahi mila (khatam ho gaya ya code galat)', code: 404 };
  }

  if (action === 'start') { // sirf host: match abhi shuru karo (3 sec ke countdown ke baad)
    const t = verify(b.rt);
    if (!t) return { error: 'Session khatam, dobara join karo', code: 401 };
    const s = await getStatus(t.c);
    if (!s) return { error: 'Room nahi mila', code: 404 };
    if (t.id !== s.hostId) return { error: 'Sirf room banane wala (host) shuru kar sakta hai' };
    if (s.started) return { ok: true };
    if (s.players.length < 2) return { error: 'Shuru karne ke liye kam se kam 2 players chahiye' };
    const cur = s.startAt && s.startAt - Date.now() < 3000 ? s.startAt : Date.now() + 3000;
    await db.set('rs:' + t.c, String(cur), { ex: 7200 });
    return { ok: true };
  }

  if (action === 'leave') {
    const t = verify(b.rt);
    if (!t) return { ok: true };
    const s = await getStatus(t.c);
    if (!s) return { ok: true };
    if (s.started) { // match chal raha hai
      const msg = t.id === s.hostId ? { t: 'hostgone' } : { t: 'left', id: t.id };
      await db.pushLog(t.c, JSON.stringify({ f: 0, m: [msg] }));
      await db.hdel('rp:' + t.c, t.u);
    } else {
      await db.hdel('rp:' + t.c, t.u);
      const n = await db.hlen('rp:' + t.c);
      if (n === 0) await db.del('room:' + t.c);
      else {
        if (n < MIN) await db.del('rs:' + t.c); // 4 se kam -> countdown ruk gaya
        if (t.id === s.hostId) { const left = s.players.filter(p => p.id !== t.id)[0]; if (left) await db.set('room:' + t.c, JSON.stringify({ host: left.name, map: s.map }), { ex: 7200 }); }
      }
    }
    return { ok: true };
  }

  // create / join: login chahiye
  const u = verify(b.token);
  if (!u) return { error: 'Pehle login karo', code: 401 };

  if (action === 'create') {
    let code = '';
    for (let i = 0; i < 8; i++) { code = newCode(); if (await db.set('room:' + code, JSON.stringify({ host: u.u, map: b.map === 'registan' ? 'registan' : 'gaon' }), { nx: true, ex: 7200 })) break; code = ''; }
    if (!code) return { error: 'Room nahi ban paya, dobara try karo' };
    const id = await db.incr('rid:' + code);
    await db.hset('rp:' + code, u.u, JSON.stringify({ id, name: u.u }));
    return { ok: true, rt: rtoken(u.u, code, id), me: id, ...(await getStatus(code)) };
  }

  if (action === 'join') {
    const code = String(b.code || '').trim().toUpperCase();
    const s = await getStatus(code);
    if (!s) return { error: 'Is code ka room nahi mila', code: 404 };
    const mine = s.players.find(p => p.name === u.u);
    if (mine) return { ok: true, rt: rtoken(u.u, code, mine.id), me: mine.id, ...s };
    if (s.started) return { error: 'Is room ka match shuru ho chuka hai' };
    if (s.players.length >= MAX) return { error: 'Room full hai (max ' + MAX + ')' };
    const id = await db.incr('rid:' + code);
    await db.hset('rp:' + code, u.u, JSON.stringify({ id, name: u.u }));
    await afterCountChange(code);
    return { ok: true, rt: rtoken(u.u, code, id), me: id, ...(await getStatus(code)) };
  }
  return { error: 'Galat action' };
});
