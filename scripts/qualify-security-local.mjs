// Local-only native transport qualification. This never loads .env, connects
// remote bindings, deploys, changes product gates, or supplies real credentials.
// The explicit public DNS/TCP positive controls contact fixed public resolvers.
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { parseDnsAnswer, assessTcpDns } from './security-local-dns.mjs';

const interrupted = new AbortController();
let interruptionSignal;
const onInterrupt = signal => { interruptionSignal ??= signal; interrupted.abort(new Error('qualification_interrupted')); };
const onSigint = () => onInterrupt('SIGINT'), onSigterm = () => onInterrupt('SIGTERM');
process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
let image = 'mainbrella-managed-base:qualification';
let output = '.wrangler/release-security/native-report.json';
for (let i = 0; i < args.length; i += 2) {
  if (!args[i + 1] || !['--image', '--output'].includes(args[i])) throw new Error('Usage: node scripts/qualify-security-local.mjs [--image LOCAL_IMAGE] [--output REPORT]');
  if (args[i] === '--image') image = args[i + 1];
  else output = args[i + 1];
}
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 5_000 });
// An explicit local inspect prevents an implicit application-image pull.
const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
const version = async name => JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8')).version;
const runId = randomUUID(), workerName = 'security-local-' + runId;
const prefix = 'workerd-' + workerName + '-Probe-';
const report = {
  runId, startedAt: new Date().toISOString(), releaseQualified: false,
  versions: { node: process.version, wrangler: await version('wrangler'), miniflare: await version('miniflare'), workerd: await version('workerd'), docker: docker(['version', '--format', '{{.Server.Version}}']).trim() },
  image: { id: imageInfo.Id, tag: image, sizeBytes: imageInfo.Size },
  checks: {}, cleanup: { completed: false },
  pending: ['production_native_transport_and_isolation', 'production_generation_and_incarnation_revocation', 'ipv6_protocol_positive_control'],
};

// This runs inside the guest. TCP handshakes are recorded as diagnostics only:
// a local sidecar can accept before it denies the actual protocol traffic.
async function publicControls() {
  const net = require('node:net'), dns = require('node:dns').promises;
  const out = {};
  for (const [name, host] of [['tcp4HandshakeOnly', '1.1.1.1'], ['tcp6HandshakeOnly', '2606:4700:4700::1111']]) {
    out[name] = await new Promise(resolve => {
      const socket = net.connect({ host, port: 443 });
      const done = value => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(2000, () => done(false));
    });
  }
  const resolver = new dns.Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers(['1.1.1.1']);
  // Node's resolver validates UDP transaction identity and question matching.
  out.udpDnsA = await resolver.resolve4('example.com').then(addresses => ({ responded: true, addresses }), () => ({ responded: false }));
  out.udpDnsTxt = await resolver.resolveTxt('example.com').then(records => records.length > 0, () => false);
  resolver.cancel();
  out.tcpDns = await new Promise(resolve => {
    const question = Buffer.from('076578616d706c6503636f6d0000010001', 'hex'); // example.com A IN
    const id = 0x7777, request = Buffer.concat([Buffer.from('777701000001000000000000', 'hex'), question]);
    const length = Buffer.alloc(2); length.writeUInt16BE(request.length);
    const socket = net.connect({ host: '1.1.1.1', port: 53 });
    let bytes = Buffer.alloc(0), finished = false;
    const done = result => { if (!finished) { finished = true; socket.destroy(); resolve({ ...result, responseReceived: bytes.length > 0, receivedBytes: bytes.length }); } };
    socket.once('connect', () => socket.write(Buffer.concat([length, request])));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65537) return done({ answered: false, invalidResponse: true });
      if (bytes.length >= 2 && bytes.length >= bytes.readUInt16BE(0) + 2) done(parseDnsAnswer(bytes.subarray(2, bytes.readUInt16BE(0) + 2), { id, question, expectedAddresses: out.udpDnsA.addresses ?? [] }));
    });
    socket.once('end', () => done({ answered: false })); socket.once('error', () => done({ answered: false })); socket.setTimeout(2000, () => done({ answered: false }));
  });
  return out;
}

async function ownedControl(port) {
  const net = require('node:net');
  return new Promise(resolve => {
    const socket = net.connect({ host: 'host.docker.internal', port });
    let data = '', finished = false;
    const done = value => { if (!finished) { finished = true; socket.destroy(); resolve({ receivedExpectedBody: value }); } };
    socket.once('connect', () => socket.write('GET / HTTP/1.1\r\nHost: local-control\r\nConnection: close\r\n\r\n'));
    socket.on('data', chunk => { data += chunk; });
    socket.once('end', () => done(data.includes('owned-loopback-network-control')));
    socket.once('error', () => done(false)); socket.setTimeout(2000, () => done(false));
  });
}
async function interceptedRequests(denial = false) {
  const result = {};
  const targets = ['http://allowed.example.com/probe', 'https://allowed.example.com/probe'];
  if (!denial) targets.push('http://denied.example.com/probe', 'https://denied.example.com/probe');
  for (const target of targets) result[target] = await fetch(target, { signal: AbortSignal.timeout(4000) })
    .then(async response => ({ status: response.status, body: await response.json() })).catch(() => ({ status: 0 }));
  return result;
}
const guest = (fn, ...args) => 'const parseDnsAnswer = (' + parseDnsAnswer.toString() + '); (' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ').then(value=>console.log(JSON.stringify(value)))';
const control = http.createServer((_request, response) => response.end('owned-loopback-network-control'));
await new Promise(resolve => control.listen(0, '0.0.0.0', resolve));
const port = control.address().port;
const script = `
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
export class Mediator extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url);
    if (this.ctx.props.mode !== 'allow' || url.hostname !== 'allowed.example.com' || url.pathname !== '/probe') return Response.json({allowed:false},{status:403});
    return Response.json({allowed:true,protocol:url.protocol});
  }
}
export class Probe extends DurableObject {
  async command(source) {
    const process = await this.ctx.container.exec(['node','-e',source], { env:{NODE_EXTRA_CA_CERTS:'/etc/cloudflare/certs/cloudflare-containers-ca.crt'} });
    const timer = setTimeout(()=>process.kill(9),15000);
    try {
      const output = await process.output(), exitCode = await process.exitCode;
      if(exitCode !== 0) throw new Error('guest_command_failed');
      return JSON.parse(new TextDecoder().decode(output.stdout));
    } finally { clearTimeout(timer); }
  }
  async run() {
    const c=this.ctx.container, results={};
    await this.ctx.storage.setAlarm(Date.now()+60000);
    try {
      c.start({image:c.images.terminal,entrypoint:['sleep','infinity'],enableInternet:true});
      await c.setInactivityTimeout(60000);
      results.onlineOwnedControl=await this.command(${JSON.stringify(guest(ownedControl, port))});
      results.onlinePublicControls=await this.command(${JSON.stringify(guest(publicControls))});
      await c.destroy('Native security local control completed');
      const binding=this.ctx.exports.Mediator({props:{mode:'allow'}});
      await c.interceptAllOutboundHttp(binding); await c.interceptOutboundHttps('*',binding);
      c.start({image:c.images.terminal,entrypoint:['sleep','infinity'],enableInternet:false});
      await c.setInactivityTimeout(60000);
      results.interception=await this.command(${JSON.stringify(guest(interceptedRequests))});
      results.offlineOwnedControl=await this.command(${JSON.stringify(guest(ownedControl, port))});
      results.offlinePublicControls=await this.command(${JSON.stringify(guest(publicControls))});
      const denial=this.ctx.exports.Mediator({props:{mode:'deny'}});
      await c.interceptAllOutboundHttp(denial); await c.interceptOutboundHttps('*',denial);
      results.revocation=await this.command(${JSON.stringify(guest(interceptedRequests, true))});
      return results;
    } finally { if(c.running) await c.destroy('Local native security qualification completed'); await this.ctx.storage.deleteAlarm(); }
  }
  async alarm() { if(this.ctx.container.running)await this.ctx.container.destroy('Local native security qualification deadline'); }
}
export default {async fetch(request,env){const stub=env.PROBE.get(env.PROBE.idFromName(new URL(request.url).pathname));return Response.json(await stub.run());}};
`;
let mf;
try {
  const priorSignalListeners = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
  mf = new Miniflare(convertV4MiniflareOptions({ port: 0, cf: false, log: new Log(LogLevel.ERROR), workers: [{ name: workerName, modules: true, script,
    compatibilityDate: '2026-10-05', compatibilityFlags: ['enable_request_signal'], durableObjects: { PROBE: { className: 'Probe', useSQLite: true,
      container: { images: [{ name: 'terminal', image: imageInfo.Id }] } } } }] }));
  // Miniflare's default signal hooks call process.exit immediately, skipping
  // our asynchronous cleanup. Remove only hooks introduced by this dedicated
  // runner's construction; keep the explicit interruption handlers above.
  for (const [signal, previous] of priorSignalListeners) {
    for (const handler of process.listeners(signal)) if (!previous.has(handler)) process.off(signal, handler);
  }
  const response = await mf.dispatchFetch('http://local-security/' + runId, { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(90_000)]) });
  report.httpStatus = response.status;
  if (!response.ok) throw new Error('local_native_probe_failed');
  report.checks = await response.json();
  const checks = report.checks, online = checks.onlinePublicControls, offline = checks.offlinePublicControls;
  report.assessment = {
    ipv4TcpProtocol: assessTcpDns(online.tcpDns, offline.tcpDns),
    udpDnsTxt: online.udpDnsTxt ? offline.udpDnsTxt ? 'bypass' : 'denied' : 'indeterminate',
    udpDnsA: offline.udpDnsA.responded ? offline.udpDnsA.addresses?.every(address => /^11\./.test(address)) ? 'synthetic_interception_route' : 'needs_investigation' : 'denied',
    ipv6: 'indeterminate',
    privateDockerHostRoute: checks.offlineOwnedControl.receivedExpectedBody ? 'reachable' : 'unreachable',
  };
  report.ok = checks.onlineOwnedControl.receivedExpectedBody === true && report.assessment.ipv4TcpProtocol === 'denied'
    && report.assessment.udpDnsTxt === 'denied' && report.assessment.udpDnsA !== 'needs_investigation'
    && checks.interception['http://allowed.example.com/probe'].status === 200
    && checks.interception['https://allowed.example.com/probe'].status === 200
    && checks.interception['http://denied.example.com/probe'].status === 403
    && checks.interception['https://denied.example.com/probe'].status === 403
    && Object.values(checks.revocation).length === 2 && Object.values(checks.revocation).every(value => value.status === 403);
} catch (error) { report.ok = false; report.error = String(error); }
finally {
  let disposalTimer;
  // Begin disposal, but do not let a hung dev runtime delay exact Docker cleanup.
  const disposal = Promise.resolve().then(() => mf?.dispose());
  const disposalOutcome = Promise.race([disposal, new Promise((_, reject) => {
    disposalTimer = setTimeout(() => reject(new Error('runtime_dispose_timeout')), 10_000);
  })]).then(() => true, () => false).finally(() => clearTimeout(disposalTimer));
  control.closeAllConnections(); await new Promise(resolve => control.close(resolve));
  // Miniflare leaves sidecars behind. Remove only this unique run's exact
  // namespace, never other developers' containers or the shared image.
  try {
    const owned = docker(['ps', '-a', '--format', '{{.ID}} {{.Names}}']).trim().split('\n')
      .map(line => line.split(' ')).filter(([, name]) => name?.startsWith(prefix));
    for (const [id] of owned) docker(['rm', '--force', id]);
    report.cleanup.removedContainers = owned.map(([, name]) => name);
    report.cleanup.remainingOwned = docker(['ps', '-a', '--format', '{{.Names}}']).trim().split('\n').filter(name => name.startsWith(prefix));
    report.cleanup.ownedContainersRemoved = report.cleanup.remainingOwned.length === 0;
  } catch { report.cleanup.error = 'owned_container_cleanup_failed'; }
  report.cleanup.runtimeDisposed = await disposalOutcome;
  // Recheck after runtime shutdown so an in-flight create cannot outlive the
  // first inventory. Both cleanup passes stay in the same unique namespace.
  try {
    const late = docker(['ps', '-a', '--format', '{{.ID}} {{.Names}}']).trim().split('\n')
      .map(line => line.split(' ')).filter(([, name]) => name?.startsWith(prefix));
    for (const [id] of late) docker(['rm', '--force', id]);
    report.cleanup.removedContainers ??= [];
    report.cleanup.removedContainers.push(...late.map(([, name]) => name));
    report.cleanup.remainingOwned = docker(['ps', '-a', '--format', '{{.Names}}']).trim().split('\n').filter(name => name.startsWith(prefix));
    report.cleanup.ownedContainersRemoved = report.cleanup.remainingOwned.length === 0;
  } catch { report.cleanup.ownedContainersRemoved = false; report.cleanup.error = 'owned_container_cleanup_failed'; }
  report.cleanup.completed = report.cleanup.runtimeDisposed && report.cleanup.ownedContainersRemoved === true;
  if (interruptionSignal) { report.interruptedBy = interruptionSignal; report.ok = false; }
  report.finishedAt = new Date().toISOString();
  report.ok &&= report.cleanup.completed;
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm);
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = interruptionSignal === 'SIGINT' ? 130 : interruptionSignal === 'SIGTERM' ? 143 : 1;
// The report retains unconfirmed runtime disposal; exit after bounded owned
// cleanup instead of hanging on an unresponsive development runtime.
if (!report.cleanup.runtimeDisposed) process.exit(process.exitCode || 1);
