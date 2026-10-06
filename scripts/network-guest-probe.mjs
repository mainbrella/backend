import { Resolver } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tcp = (host, port) => new Promise(resolve => {
  const socket = connect({ host, port }); let done = false;
  const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); };
  socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(3000, () => finish(false));
});
const dns = async type => {
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  try { return (await resolver[type]('cloudflare.com')).length > 0; }
  catch { return false; } finally { resolver.cancel(); }
};
const http = async url => {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'manual' }); await response.body?.cancel(); return true; }
  catch { return false; }
};
const udpDns = () => new Promise(resolve => {
  const socket = createSocket('udp4'); let done = false, timer;
  const finish = value => { if (done) return; done = true; clearTimeout(timer); socket.close(); resolve(value); };
  // One ordinary TXT question to the public resolver. A send without a reply is not reachability evidence.
  const packet = Buffer.concat([Buffer.from([0x4d, 0x42, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    Buffer.from([10]), Buffer.from('cloudflare'), Buffer.from([3]), Buffer.from('com'), Buffer.from([0, 0, 16, 0, 1])]);
  socket.once('message', bytes => finish(bytes.length >= 12 && bytes.readUInt16BE(0) === 0x4d42 && Boolean(bytes[2] & 0x80) && (bytes[3] & 0x0f) === 0));
  socket.once('error', () => finish(false)); timer = setTimeout(() => finish(false), 3000);
  socket.send(packet, 53, '1.1.1.1', error => { if (error) finish(false); });
});

export async function collectNetworkEvidence() {
  const probes = { dnsA: () => dns('resolve4'), dnsAAAA: () => dns('resolve6'), dnsTXT: () => dns('resolveTxt'),
    publicHttp: () => http('http://1.1.1.1/'), publicHttps: () => http('https://1.1.1.1/'),
    hostnameHttps: () => http('https://mainbrella.com/'), directIpv4: () => tcp('1.1.1.1', 443),
    directIpv6: () => tcp('2606:4700:4700::1111', 443), alternateTcpPort: () => tcp('1.1.1.1', 53), udpDns };
  const results = Object.fromEntries(await Promise.all(Object.entries(probes).map(async ([name, probe]) => [name, await probe()])));
  return { node: process.version, uid: process.getuid(), results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await collectNetworkEvidence()));
}
