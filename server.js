// Local test server: public/ files + /api/* (Vercel jaisa). Online ke liye Vercel khud ye sab chalata hai.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const PORT = process.env.PORT || 8000;
const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript' };
const API = { '/api/auth': require('./api/auth'), '/api/room': require('./api/room'), '/api/relay': require('./api/relay') };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (API[url]) {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => { try { req.body = JSON.parse(data || '{}'); } catch { req.body = {}; } API[url](req, res); });
    return;
  }
  const f = url === '/' ? 'index.html' : url.replace(/^\//, '');
  if (!['index.html', 'three.min.js', 'icons.js'].includes(f)) { res.writeHead(404); return res.end('404'); }
  fs.readFile(path.join(ROOT, f), (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(d);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log('Local server: http://localhost:' + PORT + '  (DB: ' + (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ? 'Redis' : 'memory') + ')');
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('  WiFi : http://' + i.address + ':' + PORT);
});
