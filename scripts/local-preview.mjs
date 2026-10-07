import { request } from 'node:http';

// Preserve the preview authority in the URL and Host header, while connecting
// directly to loopback. A Host override on fetch's API URL is not equivalent.
export function fetchLocalPreview(previewUrl, path, { signal = AbortSignal.timeout(15_000) } = {}) {
  const origin = new URL(previewUrl), url = new URL(path, origin);
  if (origin.protocol !== 'http:' || !/^[a-f0-9]{48}\.localhost$/.test(origin.hostname)
    || origin.username || origin.password || url.origin !== origin.origin) throw new Error('invalid_local_preview');
  return new Promise((resolve, reject) => {
    const probe = request(url, { signal, lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    } }, response => {
      const chunks = []; let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 1024 * 1024) { probe.destroy(new Error('preview_response_too_large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    probe.on('error', reject); probe.end();
  });
}
