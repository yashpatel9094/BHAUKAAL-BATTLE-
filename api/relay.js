// In-match message relay: client apne messages bhejta hai aur naye messages le jata hai (polling)
const { db, verify, wrap } = require('./_lib');

module.exports = wrap(async ({ rt, cursor, msgs }) => {
  const t = verify(rt);
  if (!t) return { error: 'Session khatam, dobara room join karo', code: 401 };
  if (Array.isArray(msgs) && msgs.length) {
    const clean = msgs.slice(0, 300).filter(m => m && typeof m.t === 'string');
    if (clean.length) await db.pushLog(t.c, JSON.stringify({ f: t.id, m: clean }));
  }
  const entries = await db.readLog(t.c, Number(cursor) || 0);
  let cur = Number(cursor) || 0;
  const out = [];
  for (const [q, s] of entries) {
    if (q > cur) cur = q;
    let e; try { e = JSON.parse(s); } catch { continue; }
    if (e.f === t.id) continue;
    for (const m of e.m) if (m.to === undefined || m.to === t.id) { m.from = e.f; out.push(m); }
  }
  return { ok: true, cursor: cur, msgs: out };
});
