import http from 'node:http';

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const loadUsers = async () => {
  const response = await fetch('http://api.internal/users', { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
  if (!response.ok) throw new Error('User service unavailable');
  return (await response.json()).users;
};
const page = users => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Private Services — Users</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 20px;max-width:720px;color:#18202a}h1{font-size:24px}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:12px 8px;border-bottom:1px solid #ddd}p{color:#465261}@media(max-width:480px){th,td{padding:10px 4px;font-size:14px}}</style>
<h1>Users</h1><p role="status">${users.length} users</p>
<div style="overflow-x:auto"><table><thead><tr><th scope="col">Name</th><th scope="col">Email</th></tr></thead><tbody>${users.map(user => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td></tr>`).join('')}</tbody></table></div></html>`;

http.createServer(async (request, response) => {
  if (request.url === '/') {
    try { const users = await loadUsers(); response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(page(users)); }
    catch { response.writeHead(503, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Users</title><h1>Users</h1><p role="status">The user service is unavailable.</p></html>'); }
    return;
  }
  if (request.url !== '/api/users') { response.writeHead(404); response.end(); return; }
  try {
    const upstream = await fetch('http://api.internal/users', { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    response.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(await upstream.text());
  } catch { response.writeHead(502); response.end(JSON.stringify({ error: 'User service unavailable' })); }
}).listen(3000, '0.0.0.0');
