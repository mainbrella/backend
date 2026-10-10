import type { ChildProcess, SpawnOptions } from 'node:child_process';

export function startCodexBridge(options?: {
  executable?: string;
  signal?: AbortSignal;
  spawnProcess?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  requestTimeoutMs?: number;
  rpcTimeoutMs?: number;
  idleTimeoutMs?: number;
  lifetimeMs?: number;
}): Promise<{ url: string; token: string; model: string; close(): Promise<void> }>;
