import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { receiverClient } from './qualify-webhook-receiver.mjs';
const origin = 'https://mainbrella-outbox-qualification.crimson-dust-553b.workers.dev';
const check = value => { if (!value) throw new Error('check_failed'); };
const options = {};
for (const arg of process.argv.slice(2)) {
  const match = /^--(output|secret-file)=(.+)$/.exec(arg); check(match && !Object.hasOwn(options, match[1])); options[match[1]] = match[2];
}
check(options.output && options['secret-file']);
const secrets = parseEnv(await readFile(resolve(options['secret-file']), 'utf8'));
check(/^[a-f0-9]{64}$/.test(secrets.QUALIFICATION_RECEIVER_TOKEN ?? ''));
const output = resolve(options.output); await mkdir(output, { mode: 0o700 });
const receiver = receiverClient(secrets.QUALIFICATION_RECEIVER_TOKEN), runId = randomUUID();
const report = { ok: false, releaseQualified: false, evidenceScope: 'real_cloudflare_outbox_synthetic_lifecycle', startsConsumed: 0, runId,
  samples: [], checks: {}, cleanup: {}, stage: 'setup', sources: await Promise.all(['experiments/webhook-outbox-probe.mjs', 'containers/webhooks.js', 'containers/executions.js',
    'containers/user-container-core.js', 'experiments/webhook-receiver-core.mjs'].map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }))) };
const save = () => writeFile(join(output, 'outbox-verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const call = async (action, method = 'GET') => {
  const response = await fetch(`${origin}/${runId}/${action}`, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${secrets.QUALIFICATION_RECEIVER_TOKEN}` } });
  check(response.ok); return response.json();
};
const sample = async () => {
  const outbox = await call('status'), incoming = await receiver(`/admin/${runId}`); check(incoming.status === 200);
  report.samples.push({ at: new Date().toISOString(), outbox, receiver: incoming.value }); await save(); return { outbox, receiver: incoming.value };
};
const wait = async count => {
  const until = Date.now() + 100_000;
  while (Date.now() < until) {
    const current = await sample();
    if (current.outbox.deliveries.length === count && current.outbox.deliveries.every(d => d.status === 'delivered') && current.receiver.events.length === count) return current;
    if (Object.values(current.outbox.fetchDiagnostics?.failures ?? {}).reduce((a, b) => a + b, 0) >= 2) throw new Error('transport_diagnostic_failure');
    await new Promise(done => setTimeout(done, 2000));
  }
  throw new Error('alarm_delivery_timeout');
};
try {
  await save(); const setup = await call('setup', 'POST');
  check(/^mbwh_[a-f0-9]{64}$/.test(setup.signingSecret));
  check((await receiver(`/admin/${runId}`, { method: 'PUT', body: { signingSecret: setup.signingSecret, container: setup.container, failFirst: true } })).status === 200);
  report.stage = 'automatic_retry'; await save();
  const delivered = await wait(2); check(delivered.receiver.transientFailures === 1 && delivered.outbox.alarmsObserved > 0 && !delivered.outbox.scheduleFailed);
  report.checks.automaticAlarmSignedRetry = true;
  report.stage = 'after_stop'; await save(); await call('stop', 'POST');
  const stopped = await wait(3); check(stopped.receiver.events.some(e => e.type === 'stopped')); report.checks.deliveryAfterSyntheticStop = true;
} catch (error) { report.error = error.message === 'alarm_delivery_timeout' ? 'alarm_delivery_timeout' : `${report.stage}_failed`; }
finally {
  try { check((await call('delete', 'DELETE')).removed === true); report.cleanup.outbox = 'completed'; } catch { report.cleanup.outbox = 'failed'; }
  try { check((await receiver(`/admin/${runId}`, { method: 'DELETE' })).status === 200 && (await receiver(`/admin/${runId}`)).status === 404); report.cleanup.receiver = 'completed'; } catch { report.cleanup.receiver = 'failed'; }
}
report.ok = !report.error && Object.values(report.cleanup).every(value => value === 'completed'); report.stage = 'finished'; await save();
console.log(JSON.stringify({ ok: report.ok, checks: report.checks, cleanup: report.cleanup, startsConsumed: 0, error: report.error }));
if (!report.ok) process.exitCode = 1;
