import { pathToFileURL } from 'node:url';

// Run on a trusted machine. The returned config contains only public credentials.
export async function preparePublicRead({
  accountKey,
  apiOrigin = 'https://api.mainbrella.com',
  frontendOrigin = 'http://localhost:5173',
  projectName = 'Public read example',
}, requestFetch = fetch) {
  if (!/^mb_[a-f0-9]{64}$/.test(accountKey || '')) throw new Error('Set MAINBRELLA_API_KEY to an account API key.');
  for (const origin of [apiOrigin, frontendOrigin]) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('API and frontend origins must be exact HTTP(S) origins.');
  }
  async function owner(path, method, input) {
    const response = await requestFetch(`${apiOrigin}/bff${path}`, {
      method, headers: { authorization: `Bearer ${accountKey}`, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`BFF setup failed (${response.status}): ${result.error || 'request_failed'}`);
    return result;
  }
  const { project } = await owner('/projects', 'POST', { name: projectName, template: 'empty' });
  const base = `/projects/${project.id}`;
  await owner(`${base}/provision`, 'POST');
  await owner(`${base}/migrations`, 'POST', {
    sequence: 1, name: 'public_read_products',
    sql: "CREATE TABLE products(id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO products VALUES('coffee','Coffee'),('tea','Tea'),('water','Water');",
  });
  await owner(`${base}/policies/products`, 'PUT', { select: 'public' });
  const { token } = await owner(`${base}/api-keys`, 'POST', {
    name: 'Example frontend', origins: [frontendOrigin], tables: { products: ['select'] },
  });
  const config = { apiOrigin, projectId: project.id, publicKey: token, table: 'products' };
  const url = `${apiOrigin}/bff/data/${project.id}/tables/products?select=*`;
  const preflight = await requestFetch(url, { method: 'OPTIONS', headers: {
    origin: frontendOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'apikey',
  } });
  if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== frontendOrigin) throw new Error('Browser CORS preflight verification failed.');
  const check = await requestFetch(url, { headers: { apikey: token, origin: frontendOrigin } });
  if (!check.ok) throw new Error(`Public SELECT verification failed (${check.status}).`);
  if (check.headers.get('access-control-allow-origin') !== frontendOrigin) throw new Error('Public SELECT did not allow the frontend origin.');
  const result = await check.json();
  if (!Array.isArray(result.data)) throw new Error('Public SELECT returned an invalid response.');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = await preparePublicRead({ accountKey: process.env.MAINBRELLA_API_KEY,
      apiOrigin: process.env.BFF_API_ORIGIN, frontendOrigin: process.env.BFF_FRONTEND_ORIGIN,
      projectName: process.env.BFF_PROJECT_NAME });
    console.log(JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'BFF setup failed.');
    process.exitCode = 1;
  }
}
