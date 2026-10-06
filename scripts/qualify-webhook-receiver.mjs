import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { readFileBytes } from '../containers/file-contract.js';

export const RECEIVER_ORIGIN = 'https://mainbrella-webhook-qualification.crimson-dust-553b.workers.dev';
const requireCheck = value => { if (!value) throw new Error('check_failed'); };
export function receiverClient(token, origin = RECEIVER_ORIGIN, fetcher = fetch) {
  requireCheck(/^[a-f0-9]{64}$/.test(token ?? '') && origin === RECEIVER_ORIGIN);
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    requireCheck(/^\/(admin|receive)\/[a-f0-9-]{36}$/.test(path));
    const signal = AbortSignal.timeout(10_000);
    const response = await fetcher(origin + path, { method, redirect: 'error', signal,
      headers: { ...(path.startsWith('/admin/') ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const bytes = await readFileBytes(response.body, 128 * 1024, signal);
    return { status: response.status, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  };
}
export async function qualifyReceiver(request, { runId = randomUUID(), checkpoint = async () => {} } = {}) {
  const report = { formatVersion: 1, ok: false, releaseQualified: false, evidenceScope: 'synthetic_receiver_only',
    runId, startsConsumed: 0, cleanup: 'pending', stage: 'configure', checks: {}, pendingGates: ['actual_private_outbox_transport_retry_rotation_stop'] };
  const save = () => checkpoint(structuredClone(report));
  const admin = `/admin/${runId}`, receive = `/receive/${runId}`;
  const container = { id: 'small', createdAt: new Date().toISOString() };
  let signingSecret = 'mbwh_' + randomBytes(32).toString('hex');
  const post = async (event, { secret = signingSecret, corrupt = false } = {}) => {
    const raw = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    return request(receive, { method: 'POST', body: raw + (corrupt ? ' ' : ''),
      headers: { 'Mainbrella-Event-Id': event.id, 'Mainbrella-Signature': `t=${timestamp},v1=${signature}` } });
  };
  const event = sequence => ({ id: randomUUID(), sequence, type: sequence === 1 ? 'starting' : 'started', occurredAt: container.createdAt, container });
  try {
    await save();
    requireCheck((await request(admin, { method: 'PUT', body: { signingSecret, container, failFirst: true } })).status === 200);
    report.stage = 'signature_retry_deduplication'; await save();
    const first = event(1), second = event(2);
    requireCheck((await post(first, { corrupt: true })).status === 401);
    requireCheck((await post(first)).status === 503);
    requireCheck((await post(second)).status === 200);
    requireCheck((await post(first)).status === 200);
    requireCheck((await post(first)).status === 200);
    const summary = await request(admin);
    requireCheck(summary.status === 200 && summary.value.invalidSignatures === 1 && summary.value.transientFailures === 1
      && summary.value.duplicates === 1 && summary.value.outOfOrder === 1 && summary.value.events.length === 2
      && !JSON.stringify(summary.value).includes(signingSecret));
    report.checks.rawBodySignature = true; report.checks.transientRetry = true;
    report.checks.deduplication = true; report.checks.outOfOrder = true; report.checks.noSecretInSummary = true;
    report.stage = 'rotation'; await save();
    const previous = signingSecret; signingSecret = 'mbwh_' + randomBytes(32).toString('hex');
    requireCheck((await request(admin, { method: 'PUT', body: { signingSecret, container, failFirst: false } })).status === 200);
    requireCheck((await post(second, { secret: previous })).status === 401 && (await post(second)).status === 200);
    report.checks.rotationRejectsOldKey = true;
  } catch { report.error = `${report.stage}_failed`; }
  finally {
    try { requireCheck((await request(admin, { method: 'DELETE' })).status === 200 && (await request(admin)).status === 404); report.cleanup = 'completed'; }
    catch { report.cleanup = 'failed'; }
  }
  report.ok = !report.error && report.cleanup === 'completed'; report.stage = 'finished'; await save();
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (const arg of process.argv.slice(2)) {
      const match = /^--(output|secret-file)=(.+)$/.exec(arg);
      requireCheck(match && !Object.hasOwn(options, match[1])); options[match[1]] = match[2];
    }
    requireCheck(options.output && options['secret-file']);
    const secrets = parseEnv(await readFile(resolve(options['secret-file']), 'utf8'));
    const request = receiverClient(secrets.QUALIFICATION_RECEIVER_TOKEN);
    const output = resolve(options.output); await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 });
    const root = fileURLToPath(new URL('../', import.meta.url));
    const sources = await Promise.all(['scripts/qualify-webhook-receiver.mjs', 'experiments/webhook-receiver-core.mjs', 'sdk/javascript/index.js'].map(async path =>
      ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })));
    const checkpoint = async report => writeFile(join(output, 'receiver-verification.json'), JSON.stringify({ ...report, sources, receiverOrigin: RECEIVER_ORIGIN }, null, 2) + '\n', { mode: 0o600 });
    const report = await qualifyReceiver(request, { checkpoint });
    console.log(JSON.stringify({ ok: report.ok, releaseQualified: false, checks: report.checks, cleanup: report.cleanup, startsConsumed: 0 }));
    if (!report.ok) process.exitCode = 1;
  } catch { console.error('Use --output=NEW_DIR --secret-file=LOCAL_SECRET_FILE. Receiver credentials and provider errors are never printed.'); process.exitCode = 1; }
}
