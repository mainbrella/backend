// A dependency-free transport fixture, not a production application server.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const previewBytes = Buffer.from([0, 1, 127, 128, 255, 10]);
export const previewHtml = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mainbrella preview probe</title><link rel="stylesheet" href="/app.css"><h1>Mainbrella preview probe</h1><p id="status">Connecting…</p><script src="/app.js"></script></html>';
export const previewCss = 'body{font:16px system-ui;max-width:40rem;margin:2rem;color:#18212b}';
const script = "const s=new WebSocket(location.origin.replace('http','ws')+'/ws');s.onopen=()=>s.send('mainbrella-preview');s.onmessage=e=>document.querySelector('#status').textContent=e.data;";

export function createPreviewApp() {
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://probe');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(previewHtml); }
    if (url.pathname === '/app.css') { response.setHeader('Content-Type', 'text/css'); return response.end(previewCss); }
    if (url.pathname === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); return response.end(script); }
    if (url.pathname === '/binary') { response.setHeader('Content-Type', 'application/octet-stream'); return response.end(previewBytes); }
    if (url.pathname === '/redirect') { response.writeHead(302, { Location: '/binary' }); return response.end(); }
    if (url.pathname === '/stream') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('mainbrella-stream\n');
      const timer = setTimeout(() => response.end(), 180_000);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/echo' && request.method === 'POST') {
      const chunks = []; let size = 0;
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024) { response.writeHead(413); response.end(); return; }
          chunks.push(chunk);
        }
      } catch { response.destroy(); return; }
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Set-Cookie', 'probe=must-be-stripped; Path=/');
      return response.end(JSON.stringify({ bytes: [...Buffer.concat(chunks)], query: url.search,
        authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null,
        origin: request.headers.origin ?? null, referer: request.headers.referer ?? null }));
    }
    response.writeHead(404); response.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    // Only the probe's small, single-frame UTF-8 messages are supported.
    if (request.url !== '/ws' || request.headers.upgrade?.toLowerCase() !== 'websocket'
      || request.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(request.headers['sec-websocket-key'] ?? '')) {
      socket.destroy(); return;
    }
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    const receive = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 2048) { socket.destroy(); return; }
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15, length = buffered[1] & 127;
        if (buffered[0] & 0x70 || !(buffered[0] & 0x80) || !(buffered[1] & 0x80)
          || length > 125 || ![1, 8, 9, 10].includes(opcode)) { socket.destroy(); return; }
        if (buffered.length < 6 + length) return;
        const payload = Buffer.from(buffered.subarray(6, 6 + length));
        for (let i = 0; i < length; i++) payload[i] ^= buffered[2 + i % 4];
        buffered = buffered.subarray(6 + length);
        if (opcode === 10) continue;
        socket.write(Buffer.concat([Buffer.from([0x80 | (opcode === 9 ? 10 : opcode), length]), payload]));
        if (opcode === 8) { socket.end(); return; }
      }
    };
    socket.on('data', receive);
    socket.on('error', () => socket.destroy());
    if (head.length) receive(head);
  });
  return { server, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createPreviewApp();
  app.server.listen(3000, '0.0.0.0', () => process.stdout.write('mainbrella-preview-ready\n'));
}
