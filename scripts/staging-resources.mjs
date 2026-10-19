import { STAGING, assertStagingDatabaseId, stagingConfig } from './staging-config.mjs';

const API = `https://api.cloudflare.com/client/v4/accounts/${STAGING.accountId}`;
const MAX_PAGES = 1000;

function credentials(env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Set CLOUDFLARE_API_TOKEN explicitly to discover staging resources.');
  }
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']) {
    if (env[name] && env[name] !== STAGING.accountId) {
      throw new Error(`${name} must match the staging Cloudflare account.`);
    }
  }
  return token;
}

function cloudflareRequest(request, token) {
  return async (method, path, body) => {
    let response;
    try {
      response = await request(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed. Check connectivity and token permissions.`);
    }
    if (!response.ok) {
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} returned HTTP ${response.status}. Check token permissions.`);
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} returned invalid JSON.`);
    }
    if (payload?.success !== true) {
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} was rejected. Check token permissions.`);
    }
    return payload;
  };
}

async function listDatabases(call) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await call('GET', `/d1/database?page=${page}&per_page=100`);
    if (!Array.isArray(payload.result)) throw new Error('Cloudflare returned an invalid D1 listing.');
    rows.push(...payload.result);
    const info = payload.result_info;
    if (!info || !Number.isInteger(info.total_count)) {
      if (payload.result.length < 100) return rows;
    } else if (rows.length >= info.total_count) return rows;
  }
  throw new Error('Cloudflare D1 listing exceeded the safe pagination limit.');
}

async function listBuckets(call) {
  const rows = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const path = `/r2/buckets?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const payload = await call('GET', path);
    if (!Array.isArray(payload.result?.buckets)) throw new Error('Cloudflare returned an invalid R2 listing.');
    rows.push(...payload.result.buckets);
    cursor = payload.result_info?.cursor;
    if (!cursor) return rows;
    if (cursors.has(cursor)) throw new Error('Cloudflare R2 listing repeated a cursor.');
    cursors.add(cursor);
  }
  throw new Error('Cloudflare R2 listing exceeded the safe pagination limit.');
}

function exactOne(rows, name, kind) {
  const matches = rows.filter(row => row?.name === name);
  if (matches.length > 1) throw new Error(`Cloudflare returned duplicate ${kind} resources named ${name}.`);
  return matches[0];
}

export async function provisionStaging({ env = process.env, request = fetch, create = false } = {}) {
  const token = credentials(env);
  if (typeof request !== 'function') throw new Error('A fetch-compatible request function is required.');
  const call = cloudflareRequest(request, token);
  const [databases, buckets] = await Promise.all([listDatabases(call), listBuckets(call)]);
  let database = exactOne(databases, STAGING.databaseName, 'D1');
  let previewDatabase = exactOne(databases, STAGING.previewDatabaseName, 'D1');
  let bucket = exactOne(buckets, STAGING.bucketName, 'R2');
  // A partial rerun must reject unsafe existing IDs before creating anything else.
  if (database) assertStagingDatabaseId(database.uuid);
  if (previewDatabase) assertStagingDatabaseId(previewDatabase.uuid);
  if (database && previewDatabase && database.uuid.toLowerCase() === previewDatabase.uuid.toLowerCase()) {
    throw new Error('Staging D1 databases must have distinct IDs.');
  }

  if (!create && (!database || !previewDatabase || !bucket)) {
    const missing = [
      !database && `D1 ${STAGING.databaseName}`,
      !previewDatabase && `D1 ${STAGING.previewDatabaseName}`,
      !bucket && `R2 ${STAGING.bucketName}`,
    ].filter(Boolean);
    throw new Error(`Missing staging resources: ${missing.join(', ')}. Run staging provisioning with --apply to create only these names.`);
  }

  if (create) {
    if (!database) {
      const payload = await call('POST', '/d1/database', { name: STAGING.databaseName });
      database = payload.result;
      if (database?.name !== STAGING.databaseName) throw new Error('Cloudflare returned a D1 database with an unexpected name.');
      assertStagingDatabaseId(database.uuid);
    }
    if (!previewDatabase) {
      const payload = await call('POST', '/d1/database', { name: STAGING.previewDatabaseName });
      previewDatabase = payload.result;
      if (previewDatabase?.name !== STAGING.previewDatabaseName) throw new Error('Cloudflare returned a D1 database with an unexpected name.');
      assertStagingDatabaseId(previewDatabase.uuid);
    }
    if (database.uuid.toLowerCase() === previewDatabase.uuid.toLowerCase()) {
      throw new Error('Staging D1 databases must have distinct IDs.');
    }
    if (!bucket) {
      const payload = await call('POST', '/r2/buckets', { name: STAGING.bucketName });
      bucket = payload.result;
      if (bucket?.name !== STAGING.bucketName) throw new Error('Cloudflare returned an R2 bucket with an unexpected name.');
    }
  }

  if (database?.name !== STAGING.databaseName || previewDatabase?.name !== STAGING.previewDatabaseName || bucket?.name !== STAGING.bucketName) {
    throw new Error('Cloudflare returned a resource with an unexpected name.');
  }
  const resources = { databaseId: database.uuid, previewDatabaseId: previewDatabase.uuid, bucketName: bucket.name };
  // The same checks used by the publisher reject malformed IDs and production IDs.
  stagingConfig('api', { resources });
  return resources;
}
