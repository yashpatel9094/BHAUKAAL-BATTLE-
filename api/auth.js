// Signup / login: username + password -> token
const { db, sign, wrap, crypto } = require('./_lib');

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

module.exports = wrap(async ({ action, username, password }) => {
  username = String(username || '').trim();
  password = String(password || '');
  if (!/^[A-Za-z0-9_]{3,14}$/.test(username)) return { error: 'Username 3-14 letters/numbers/_ ka hona chahiye' };
  if (password.length < 4 || password.length > 64) return { error: 'Password kam se kam 4 character ka ho' };
  const key = 'user:' + username.toLowerCase();

  if (action === 'signup') {
    const salt = crypto.randomBytes(12).toString('hex');
    const ok = await db.set(key, JSON.stringify({ name: username, salt, hash: hashPw(password, salt) }), { nx: true });
    if (!ok) return { error: 'Ye username pehle se hai, doosra chuno' };
  } else if (action === 'login') {
    const raw = await db.get(key);
    const u = raw && JSON.parse(raw);
    const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt)), Buffer.from(u.hash));
    if (!ok) return { error: 'Username ya password galat hai' };
    username = u.name;
  } else return { error: 'Galat action' };

  return { ok: true, username, token: sign({ u: username }, 30 * 24 * 3600) };
});
