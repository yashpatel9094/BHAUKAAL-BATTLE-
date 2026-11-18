// Ranking: match ke baad points, leaderboard (top 20), apna rank
const { db, verify, wrap } = require('./_lib');

const clean = s => String(s || '').toLowerCase();
async function getStats(name) {
  const raw = await db.get('stats:' + clean(name));
  return raw ? JSON.parse(raw) : { name, pts: 0, wins: 0, kills: 0, matches: 0 };
}

module.exports = wrap(async b => {
  if (b.action === 'top') {
    const rows = await db.zrevrange('lb', 0, 19);
    const list = [];
    for (const [member, pts] of rows) { const s = await getStats(member); list.push({ name: s.name || member, pts, wins: s.wins, kills: s.kills, matches: s.matches }); }
    return { ok: true, list };
  }
  if (b.action === 'me') {
    const u = verify(b.token);
    if (!u) return { error: 'Pehle login karo', code: 401 };
    return { ok: true, stats: await getStats(u.u) };
  }
  if (b.action === 'report') { // match khatam: placement + kills (room ke token se)
    const t = verify(b.rt);
    if (!t) return { error: 'Session khatam', code: 401 };
    const N = Math.max(2, Math.min(30, Number(b.total) | 0)), rank = Math.max(1, Math.min(N, Number(b.rank) | 0)), kills = Math.max(0, Math.min(N - 1, Number(b.kills) | 0));
    const first = await db.set('rep:' + t.c + ':' + clean(t.u), '1', { nx: true, ex: 7200 });
    const s = await getStats(t.u);
    if (!first) return { ok: true, dup: true, stats: s, gain: 0 };
    const win = rank === 1;
    const gain = 5 + Math.round(40 * (N - rank) / (N - 1)) + kills * 12 + (win ? 60 : 0);
    s.name = t.u; s.pts += gain; s.kills += kills; s.matches += 1; if (win) s.wins += 1;
    await db.set('stats:' + clean(t.u), JSON.stringify(s));
    await db.zadd('lb', s.pts, t.u);
    return { ok: true, gain, stats: s };
  }
  return { error: 'Galat action' };
});