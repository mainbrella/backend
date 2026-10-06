import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { readFileBytes } from '../containers/file-contract.js';
import { MAX_METRIC_RESPONSE_BYTES, queryMetrics } from '../worker/lib/workload-metrics';

const root = fileURLToPath(new URL('../', import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const endpoint = 'https://api.cloudflare.com/client/v4/graphql';
const schemaQuery = `query WorkloadSchema {
  dimensions: __type(name: "AccountContainersMetricsAdaptiveGroupsDimensions") { fields { name description args { name } } }
  maximum: __type(name: "AccountContainersMetricsAdaptiveGroupsMax") { fields { name description } }
  total: __type(name: "AccountContainersMetricsAdaptiveGroupsSum") { fields { name description } }
  groups: __type(name: "AccountContainersMetricsAdaptiveGroups") { fields { name description } }
}`;
const discoveryQuery = `query RecentWorkloads($accountTag: String, $from: Time, $to: Time) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    containersMetricsAdaptiveGroups(limit: 100, filter: {datetime_geq: $from, datetime_lt: $to}, orderBy: [datetimeMinute_DESC]) {
      dimensions { datetimeMinute generation: label(name: "mb_generation") }
    }
  } }
}`;
type GraphQL = (query: string, variables?: Record<string, string>) => Promise<any>;
type Sample = Awaited<ReturnType<typeof queryMetrics>>;

export function parseMetricsArgs(args: string[]) {
  const options: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--(output|credential|from|to)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('invalid_arguments');
    options[match[1]] = match[2];
  }
  if (!options.output || !['analytics-token', 'operator-session'].includes(options.credential ?? 'analytics-token')) throw new Error('invalid_arguments');
  const to = options.to ? Date.parse(options.to) : Date.now();
  const from = options.from ? Date.parse(options.from) : to - 24 * 3600_000;
  if (![from, to].every(Number.isSafeInteger) || from >= to || to - from > 24 * 3600_000 || to > Date.now()) throw new Error('invalid_range');
  for (const name of ['from', 'to']) if (options[name] && new Date(Date.parse(options[name])).toISOString() !== options[name]) throw new Error('invalid_range');
  return { output: resolve(options.output), credential: options.credential ?? 'analytics-token', from, to };
}

export async function metricsProviderEvidence({ accountId, credential, from, to, graphql, sample, absentId = randomUUID() }:
  { accountId: string; credential: string; from: number; to: number; graphql: GraphQL; sample: (id: string) => Promise<Sample>; absentId?: string }) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !uuid.test(absentId)
    || !['analytics-token', 'operator-session'].includes(credential)
    || ![from, to].every(Number.isSafeInteger) || from >= to || to - from > 24 * 3600_000) throw new Error('invalid_inputs');
  const report = { formatVersion: 1, startedAt: new Date().toISOString(), ok: false, releaseQualified: false,
    credential, accountId, startsConsumed: 0, providerWrites: 0, stage: 'schema',
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    checks: {} as Record<string, boolean>, schema: {} as Record<string, unknown>, generations: [] as { labelSha256: string; buckets: number; samples: number }[],
    pendingGates: ['deployed_authenticated_metrics_and_account_isolation', 'fresh_generation_ingestion_delay', 'memory_unit_confirmation'], error: undefined as string | undefined };
  if (credential === 'operator-session') report.pendingGates.push('dedicated_account_analytics_token');
  try {
    const schema = (await graphql(schemaQuery)).data;
    const field = (type: string, name: string) => schema?.[type]?.fields?.find((entry: any) => entry.name === name);
    if (!field('dimensions', 'label')?.args?.some((arg: any) => arg.name === 'name')
      || !field('dimensions', 'datetimeMinute') || !field('maximum', 'memory') || !field('maximum', 'diskUsage')
      || !field('total', 'cpuTimeSec') || !field('groups', 'count')) throw new Error();
    report.schema = { cpuTimeSec: field('total', 'cpuTimeSec').description, memory: field('maximum', 'memory').description,
      diskUsage: field('maximum', 'diskUsage').description, count: field('groups', 'count').description,
      datetimeMinute: field('dimensions', 'datetimeMinute').description };
    report.checks.requiredSchema = true;
    report.stage = 'historical_discovery';
    const result = await graphql(discoveryQuery, { accountTag: accountId, ...report.range });
    const accounts = result?.data?.viewer?.accounts;
    const rows = accounts?.[0]?.containersMetricsAdaptiveGroups;
    if (!Array.isArray(accounts) || accounts.length !== 1 || !Array.isArray(rows) || rows.length > 100) throw new Error();
    const ids = [...new Set<string>(rows.map((row: any) => row?.dimensions?.generation).filter((id: unknown) => typeof id === 'string' && uuid.test(id)))];
    if (ids.includes(absentId)) throw new Error();
    report.stage = 'production_adapter';
    for (const id of ids.slice(0, 2)) {
      // Use the exact production query and decoder; do not accept a duplicate probe implementation.
      const buckets = await sample(id);
      if (!buckets.length) throw new Error();
      report.generations.push({ labelSha256: createHash('sha256').update(id).digest('hex'), buckets: buckets.length,
        samples: buckets.reduce((sum, bucket) => sum + bucket.samples, 0) });
    }
    report.checks.twoDistinctGenerations = report.generations.length === 2;
    if (!report.checks.twoDistinctGenerations) throw new Error();
    report.stage = 'absent_generation';
    if ((await sample(absentId)).length !== 0) throw new Error();
    report.checks.absentGenerationUnobserved = true;
    report.checks.exactGenerationFiltering = true;
    report.checks.productionQueryAndDecoder = true;
    report.ok = true;
  } catch { report.error = `${report.stage}_failed`; }
  report.stage = 'finished';
  return { ...report, finishedAt: new Date().toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseMetricsArgs(process.argv.slice(2));
    const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
    let local: Record<string, string> = {};
    try { local = parseEnv(await readFile(join(root, '.env'), 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('cannot_read_local_configuration'); }
    const env = { ...local, ...process.env };
    if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== config.account_id) throw new Error('account_mismatch');
    let token = env.WORKLOAD_METRICS_TOKEN;
    if (options.credential === 'operator-session') {
      // Explicit, read-only operator mode. Never deploy or store the short-lived Wrangler credential.
      const candidates = [join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'), join(homedir(), '.config/.wrangler/config/default.toml')];
      token = undefined;
      for (const path of candidates) {
        try { token = /^oauth_token\s*=\s*"([^"\n]+)"/m.exec(await readFile(path, 'utf8'))?.[1]; } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('operator_session_unavailable'); }
        if (token) break;
      }
    }
    if (!token || /[\r\n]/.test(token)) throw new Error('analytics_credential_missing');
    const graphql: GraphQL = async (query, variables) => {
      const signal = AbortSignal.timeout(10_000);
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('provider_unavailable'); }
      const bytes = await readFileBytes(response.body, MAX_METRIC_RESPONSE_BYTES, signal);
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (data.errors && (!Array.isArray(data.errors) || data.errors.length)) throw new Error('provider_unavailable');
      return data;
    };
    await mkdir(dirname(options.output), { recursive: true });
    await mkdir(options.output, { mode: 0o700 }); // Never overwrite prior evidence.
    const sampleEnv = { WORKLOAD_METRICS_TOKEN: token, WORKLOAD_METRICS_ACCOUNT_ID: config.account_id } as Env;
    const report = await metricsProviderEvidence({ ...options, accountId: config.account_id, graphql,
      sample: id => queryMetrics(sampleEnv, id, options.from, options.to, new AbortController().signal) });
    const sources = await Promise.all(['scripts/qualify-workload-metrics.ts', 'worker/lib/workload-metrics.ts', 'containers/file-contract.js'].map(async path =>
      ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })));
    await writeFile(join(options.output, 'metrics-provider.json'), JSON.stringify({ ...report, sources }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ok: report.ok, releaseQualified: false, startsConsumed: 0, checks: report.checks, pendingGates: report.pendingGates }));
    if (!report.ok) process.exitCode = 1;
  } catch {
    console.error('Metrics qualification could not run. Check arguments, credentials, pinned account and a new evidence directory. No starts or provider writes were performed.');
    process.exitCode = 1;
  }
}
