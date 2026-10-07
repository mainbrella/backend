import http from 'node:http';

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Private Services — Users</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 20px;max-width:720px;color:#18202a}h1{font-size:24px}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:12px 8px;border-bottom:1px solid #ddd}p{color:#465261}@media(max-width:480px){th,td{padding:10px 4px;font-size:14px}}</style>
<h1>Users</h1><p>Frontend → private Go service → SQLite</p><p id="status" role="status">Loading users…</p>
<table hidden><thead><tr><th scope="col">Name</th><th scope="col">Email</th></tr></thead><tbody></tbody></table>
<script>fetch('/api/users').then(async r=>{if(!r.ok)throw Error();return r.json()}).then(data=>{for(const user of data.users){const row=document.createElement('tr');for(const key of ['name','email']){const cell=document.createElement('td');cell.textContent=user[key];row.append(cell)}document.querySelector('tbody').append(row)}document.querySelector('table').hidden=false;document.querySelector('#status').textContent=data.users.length+' users'}).catch(()=>{document.querySelector('#status').textContent='The user service is unavailable.'})</script></html>`;

http.createServer(async (request, response) => {
  if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page); return; }
  if (request.url !== '/api/users') { response.writeHead(404); response.end(); return; }
  try {
    const upstream = await fetch('http://api.internal/users', { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    response.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(await upstream.text());
  } catch { response.writeHead(502); response.end(JSON.stringify({ error: 'User service unavailable' })); }
}).listen(3000, '0.0.0.0');
