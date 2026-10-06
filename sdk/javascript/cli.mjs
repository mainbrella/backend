#!/usr/bin/env node
import { open, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Mainbrella, MainbrellaError } from './index.js';

const help = `Mainbrella 0.1.0 — generation-bound container automation
Set MAINBRELLA_API_KEY in your environment. Optional MAINBRELLA_API_URL.

mainbrella capabilities | list
mainbrella create --idempotency-key KEY [--size lite|small|medium|large|xl] [--internet true|false] [--catalog-id ID | --image-id ID]
mainbrella kill --id ID --created-at ISO
mainbrella run --id ID --created-at ISO --command COMMAND [--timeout-ms N]
mainbrella start --id ID --created-at ISO --idempotency-key KEY (--command COMMAND | --argv-json JSON) [--stdin] [--cwd PATH] [--env-json JSON] [--pty-cols N --pty-rows N] [--timeout-ms N]
mainbrella jobs --id ID --created-at ISO
mainbrella events|metrics --id ID --created-at ISO [--cursor N --limit N | --from ISO --to ISO]
mainbrella job get|cancel|events|signal|resize|input|close --id ID --created-at ISO --execution-id UUID [--cursor N] [--signal SIGTERM] [--cols N --rows N] [--source FILE]
mainbrella file read|write --id ID --created-at ISO --path PATH (--output NEW_FILE | --source FILE)
mainbrella file list|stat --id ID --created-at ISO --path PATH [--limit N --offset N | --follow-symlinks]
mainbrella file mkdir --id ID --created-at ISO --path PATH [--recursive] [--mode 0700]
mainbrella file remove --id ID --created-at ISO --path PATH [--recursive]
mainbrella file move --id ID --created-at ISO --path PATH --destination PATH
mainbrella file chmod --id ID --created-at ISO --path PATH --mode 0640

Results are JSON; job events are newline-delimited JSON. Errors go to stderr.
Creation and start require a stable key. Preserve it after an ambiguous response.
kill affects only the supplied generation. Credentials are never command options.
`;
const specifications = {
  capabilities: [], list: [], create: ['idempotency-key', 'internet', 'size', 'catalog-id', 'image-id'],
  kill: [], run: ['command', 'timeout-ms'], start: ['idempotency-key', 'command', 'argv-json', 'timeout-ms', 'stdin', 'cwd', 'env-json', 'pty-cols', 'pty-rows'],
  jobs: [], events: ['cursor', 'limit'], metrics: ['from', 'to'], 'job:get': ['execution-id'], 'job:cancel': ['execution-id'], 'job:events': ['execution-id', 'cursor'],
  'job:signal': ['execution-id', 'signal'], 'job:resize': ['execution-id', 'cols', 'rows'], 'job:input': ['execution-id', 'source'], 'job:close': ['execution-id'],
  'file:read': ['path', 'output'], 'file:write': ['path', 'source'],
  'file:list': ['path', 'limit', 'offset'], 'file:stat': ['path', 'follow-symlinks'],
  'file:mkdir': ['path', 'recursive', 'mode'], 'file:remove': ['path', 'recursive'], 'file:move': ['path', 'destination'], 'file:chmod': ['path', 'mode'],
};
const fail = () => { throw new MainbrellaError('invalid_cli_arguments'); };
function parse(argv) {
  const remaining = [...argv];
  let command = remaining.shift();
  if (['job', 'file'].includes(command)) command += ':' + remaining.shift();
  if (!Object.hasOwn(specifications, command)) fail();
  const hasIdentity = !['capabilities', 'list', 'create'].includes(command);
  const allowed = new Set([...specifications[command], 'base-url', ...(hasIdentity ? ['id', 'created-at'] : [])]);
  const options = {};
  while (remaining.length) {
    const flag = remaining.shift();
    if (!flag?.startsWith('--') || !allowed.has(flag.slice(2)) || Object.hasOwn(options, flag.slice(2))) fail();
    const name = flag.slice(2);
    if (['stdin', 'recursive', 'follow-symlinks'].includes(name)) options[name] = true;
    else { if (!remaining.length) fail(); options[name] = remaining.shift(); }
  }
  const required = name => { if (typeof options[name] !== 'string' || !options[name]) fail(); return options[name]; };
  const integer = (name, maximum) => {
    if (options[name] === undefined) return undefined;
    if (!/^\d+$/.test(options[name]) || !Number.isSafeInteger(Number(options[name])) || Number(options[name]) > maximum) fail();
    return Number(options[name]);
  };
  const json = name => { try { return JSON.parse(required(name)); } catch { fail(); } };
  if (hasIdentity) { required('id'); required('created-at'); }
  if (command === 'create' || command === 'start') { if (!/^[A-Za-z0-9_-]{1,128}$/.test(required('idempotency-key'))) fail(); }
  if (options.internet !== undefined && !['true', 'false'].includes(options.internet)) fail();
  if (command.startsWith('job:')) required('execution-id');
  if (command === 'run') required('command');
  if (command === 'start' && Boolean(options.command) === Boolean(options['argv-json'])) fail();
  if (command === 'start' && Boolean(options['pty-cols']) !== Boolean(options['pty-rows'])) fail();
  if (command.startsWith('file:')) required('path');
  if (command === 'file:read') required('output');
  if (command === 'file:write') required('source');
  if (command === 'file:move') required('destination');
  if (command === 'file:chmod') required('mode');
  if (options.mode !== undefined && !/^0[0-7]{3}$/.test(options.mode)) fail();
  if (command === 'job:input') required('source');
  if (command === 'job:signal') required('signal');
  if (command === 'job:resize') { required('cols'); required('rows'); }
  const timeoutMs = integer('timeout-ms', command === 'run' ? 60_000 : 900_000);
  if (timeoutMs === 0) fail();
  const pty = options['pty-cols'] ? { cols: integer('pty-cols', 1000), rows: integer('pty-rows', 1000) } : undefined;
  if (pty && (!pty.cols || !pty.rows || !options.stdin)) fail();
  let argvValues, envValues;
  if (options['argv-json']) { argvValues = json('argv-json'); if (!Array.isArray(argvValues) || !argvValues.length || !argvValues.every(value => typeof value === 'string')) fail(); }
  if (options['env-json']) { envValues = json('env-json'); if (!envValues || typeof envValues !== 'object' || Array.isArray(envValues) || !Object.values(envValues).every(value => typeof value === 'string')) fail(); }
  return { command, options, timeoutMs, pty, argvValues, envValues, cursor: integer('cursor', Number.MAX_SAFE_INTEGER), limit: integer('limit', command === 'file:list' ? 1000 : 100), offset: integer('offset', 1_000_000),
    cols: integer('cols', 1000), rows: integer('rows', 1000) };
}

async function sourceBytes(path, limit) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new MainbrellaError('invalid_local_file');
    if (stat.size > limit) throw new MainbrellaError('input_too_large');
    const bytes = new Uint8Array(limit + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new MainbrellaError('input_too_large');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, fetch = globalThis.fetch } = {}) {
  const print = value => stdout.write(JSON.stringify(value) + '\n');
  try {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { stdout.write(help); return 0; }
    if (argv.length === 1 && argv[0] === '--version') { stdout.write('0.1.0\n'); return 0; }
    const { command, options, timeoutMs, pty, argvValues, envValues, cursor, limit, offset, cols, rows } = parse(argv);
    const client = new Mainbrella({ apiKey: env.MAINBRELLA_API_KEY, baseUrl: options['base-url'] || env.MAINBRELLA_API_URL, fetch });
    if (command === 'capabilities' || command === 'list') { print(await client[command]()); return 0; }
    if (command === 'create') {
      const sandbox = await client.create({ idempotencyKey: options['idempotency-key'], size: options.size, internet: options.internet === undefined ? undefined : options.internet === 'true', catalogId: options['catalog-id'], imageId: options['image-id'] });
      print({ id: sandbox.id, createdAt: sandbox.createdAt, creationId: sandbox.creationId, internet: sandbox.internet, imageDigest: sandbox.imageDigest, instance: sandbox.instance }); return 0;
    }
    const sandbox = client.connect({ id: options.id, createdAt: options['created-at'] });
    if (command === 'kill') print(await sandbox.kill());
    else if (command === 'jobs') print(await sandbox.commands.list());
    else if (command === 'events') print(await sandbox.events({ cursor, limit }));
    else if (command === 'metrics') print(await sandbox.metrics({ from: options.from, to: options.to }));
    else if (command === 'run') {
      const result = await sandbox.commands.run(options.command, { timeoutMs }); print(result);
      return result.timedOut ? 124 : result.outputTruncated ? 125 : Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : 1;
    } else if (command === 'start') {
      const job = await sandbox.commands.start(argvValues || options.command, { timeoutMs, stdin: options.stdin, cwd: options.cwd, env: envValues, pty, idempotencyKey: options['idempotency-key'] });
      print({ id: job.id, containerId: sandbox.id, createdAt: sandbox.createdAt, idempotencyKey: options['idempotency-key'] });
    } else if (command === 'file:read') {
      const bytes = await sandbox.files.read(options.path); await writeFile(options.output, bytes, { flag: 'wx', mode: 0o600 }); print({ path: options.path, bytes: bytes.byteLength, output: options.output });
    } else if (command === 'file:write') print(await sandbox.files.write(options.path, await sourceBytes(options.source, 1024 * 1024)));
    else if (command === 'file:list') print(await sandbox.files.list(options.path, { limit, offset }));
    else if (command === 'file:stat') print(await sandbox.files.stat(options.path, { followSymlinks: options['follow-symlinks'] ?? false }));
    else if (command === 'file:mkdir') print(await sandbox.files.mkdir(options.path, { recursive: options.recursive ?? false, mode: options.mode }));
    else if (command === 'file:remove') print(await sandbox.files.remove(options.path, { recursive: options.recursive ?? false }));
    else if (command === 'file:move') print(await sandbox.files.move(options.path, options.destination));
    else if (command === 'file:chmod') print(await sandbox.files.chmod(options.path, options.mode));
    else {
      const job = sandbox.commands.attach(options['execution-id']);
      const action = command.split(':')[1];
      if (action === 'events') { for await (const event of job.events({ cursor })) print(event); }
      else if (action === 'signal') print(await job.signal(options.signal));
      else if (action === 'resize') print(await job.resize(cols, rows));
      else if (action === 'input') print(await job.stdin.write(await sourceBytes(options.source, 64 * 1024)));
      else if (action === 'close') print(await job.stdin.close());
      else print(await job[action]());
    }
    return 0;
  } catch (error) {
    const code = error instanceof MainbrellaError ? error.code : error?.code === 'EEXIST' ? 'output_exists' : error?.code === 'ENOENT' ? 'local_file_not_found' : 'cli_failed';
    stderr.write(JSON.stringify({ error: code, ...(error instanceof MainbrellaError && error.status ? { status: error.status } : {}),
      ...(error?.idempotencyKey && /^[A-Za-z0-9_-]{1,128}$/.test(error.idempotencyKey) ? { idempotencyKey: error.idempotencyKey } : {}) }) + '\n');
    return 1;
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) process.exitCode = await main();
