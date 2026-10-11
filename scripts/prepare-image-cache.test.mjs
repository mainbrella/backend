import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('cache converter supports legacy Docker archives and rejects links, duplicate entries, and foreign platforms', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, io, json, pathlib, tarfile, tempfile, hashlib
spec = importlib.util.spec_from_file_location('cache', 'scripts/prepare-image-cache.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
 root = pathlib.Path(directory)
 for kind in ['valid', 'link', 'duplicate', 'platform', 'oversized']:
  layer = b'\\0' * 10240
  config = {'os':'linux', 'architecture':'arm64' if kind == 'platform' else 'amd64', 'rootfs':{'diff_ids':['sha256:'+hashlib.sha256(layer).hexdigest()]}, 'moby.buildkit.cache.v0':'W10='}
  entries = [('manifest.json', json.dumps([{'Config':'config.json', 'Layers':['layer.tar']}]).encode()), ('config.json', json.dumps(config).encode()), ('layer.tar', layer)]
  if kind == 'duplicate': entries.append(('layer.tar', layer))
  if kind == 'oversized': entries[1] = ('config.json', b'x' * (module.MAX_METADATA + 1))
  archive = root / (kind + '.tar')
  with tarfile.open(archive, 'w') as output:
   for name, content in entries:
    member = tarfile.TarInfo(name); member.size = len(content)
    if kind == 'link' and name == 'layer.tar': member.type = tarfile.SYMTYPE; member.linkname = '/etc/passwd'; member.size = 0
    output.addfile(member, io.BytesIO(content))
  destination = root / kind
  try: module.prepare_cache(archive, destination)
  except ValueError:
   assert kind != 'valid'
  else:
   assert kind == 'valid'
   index = json.loads((destination / 'index.json').read_text())
   digest = index['manifests'][0]['digest'].split(':')[1]
   manifest = json.loads((destination / 'blobs' / 'sha256' / digest).read_text())
   saved_config = json.loads((destination / 'blobs' / 'sha256' / manifest['config']['digest'].split(':')[1]).read_text())
   assert saved_config['moby.buildkit.cache.v0'] == config['moby.buildkit.cache.v0']
   assert manifest['layers'][0]['digest'] == 'sha256:' + hashlib.sha256(layer).hexdigest()
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('transported inline image cache hits in a fresh Linux BuildKit builder', {
  skip: process.env.MAINBRELLA_TEST_IMAGE_CACHE_DOCKER !== '1', timeout: 240_000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'mainbrella-cache-test-'));
  const tag = `mainbrella-cache-test-${randomUUID()}`;
  const run = (args, command = 'docker') => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  };
  let builder = false;
  try {
    writeFileSync(join(directory, 'Dockerfile'), 'FROM scratch\nCOPY marker /marker\n');
    writeFileSync(join(directory, 'marker'), randomUUID());
    writeFileSync(join(directory, '.dockerignore'), '*\n!marker\n!Dockerfile\n');
    run(['build', '--platform', 'linux/amd64', '--pull=false', '--provenance=false', '--progress=plain',
      '--build-arg', 'BUILDKIT_INLINE_CACHE=1', '-t', `${tag}:first`, directory]);
    run(['save', '-o', join(directory, 'image.tar'), `${tag}:first`]);
    run(['scripts/prepare-image-cache.py', join(directory, 'image.tar'), join(directory, 'cache')], 'python3');
    run(['buildx', 'create', '--name', tag, '--driver', 'docker-container']); builder = true;
    const log = run(['buildx', 'build', '--builder', tag, '--platform', 'linux/amd64', '--pull=false', '--provenance=false',
      '--progress=plain', '--load', '--cache-from', `type=local,src=${join(directory, 'cache')}`, '-t', `${tag}:second`, directory]);
    assert.match(log, /inferred cache manifest type: application\/vnd\.oci\.image\.manifest\.v1\+json/);
    const step = log.match(/^(#\d+) \[1\/1\] COPY marker \/marker$/m)?.[1];
    assert.ok(step);
    assert.match(log, new RegExp(`^${step} CACHED$`, 'm'));
    assert.doesNotMatch(log, /ERROR:.*cache/);
  } finally {
    if (builder) spawnSync('docker', ['buildx', 'rm', tag], { timeout: 30_000 });
    for (const suffix of ['first', 'second']) spawnSync('docker', ['image', 'rm', `${tag}:${suffix}`], { timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
