import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { arch, platform, release } from 'node:os';
import { pathToFileURL } from 'node:url';

const capabilityBits = { sysPtrace: 19n, sysAdmin: 21n, checkpointRestore: 40n };

export function checkpointCapabilities(status) {
  const result = {};
  for (const [name, label] of [['effective', 'CapEff'], ['bounding', 'CapBnd']]) {
    const value = status.match(new RegExp(`^${label}:\\s*([0-9a-f]+)$`, 'mi'))?.[1];
    result[name] = value === undefined ? null : Object.fromEntries(
      Object.entries(capabilityBits).map(([capability, bit]) => [capability, Boolean(BigInt(`0x${value}`) & (1n << bit))]),
    );
  }
  const seccomp = status.match(/^Seccomp:\s*(\d+)$/m)?.[1];
  return { ...result, seccompMode: seccomp === undefined ? null : Number(seccomp) };
}

// Run inside an isolated candidate runtime. This reads selected kernel facts
// only: no checkpoint, privileged launch, network access or customer processes.
// Presence of capabilities or CRIU is not proof that checkpoint/restore works.
export function inspectCheckpointSupport() {
  let status = '';
  try { status = readFileSync('/proc/self/status', 'utf8'); } catch {}
  const criu = spawnSync('criu', ['--version'], { encoding: 'utf8', timeout: 2000, maxBuffer: 4096 });
  return {
    diagnosticsOnly: true,
    platform: platform(), architecture: arch(), kernelRelease: release(),
    uid: process.getuid?.() ?? null,
    ...checkpointCapabilities(status),
    kvmDevicePresent: existsSync('/dev/kvm'),
    criuVersion: criu.status === 0 ? criu.stdout.trim().slice(0, 200) : null,
    processRestoreVerified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(inspectCheckpointSupport(), null, 2) + '\n');
}
