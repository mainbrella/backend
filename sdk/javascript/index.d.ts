export type MachineSize = 'lite' | 'small' | 'medium' | 'large' | 'xl';
export interface Size { id: MachineSize; name: string; instance: string; cpuVcpu: number; memoryMiB: number; diskGB: number; computeUnits: number }
export interface ContainerIdentity { id: string; createdAt: string }
export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; outputTruncated: boolean }
export interface Container extends ContainerIdentity { status: 'starting' | 'running'; expiresAt: string; imageName?: string; catalogId?: string; imageId?: string; imageDigest?: string; instance?: string; size?: MachineSize; computeUnits?: number }
export interface AccountState { plan: 'builder' | 'pro' | 'scale' | null; active: boolean; containers: Container[];
  sizes: Size[]; imageCatalog: { id: string; name: string }[]; limits: { maxComputeUnitHours: number; maxConcurrentComputeUnits: number; maxContainers: number; maxStartsPerMonth: number; maxSessionMs: number; idleTimeoutMs: number };
  usage: { month: string; starts: number; computeUnitHours: number; reservedComputeUnitHours: number; availableComputeUnitHours: number; concurrentComputeUnits: number } }
export interface Capabilities {
  apiVersion: string;
  execution: { foreground: boolean; streaming: boolean; background: boolean; cancellation: boolean; reconnect: boolean; pty: boolean;
    maxCommandBytes: number; maxTimeoutMs: number; maxOutputBytes: number; maxConcurrentOperations: number;
    maxManagedTimeoutMs: number; retentionMs: number; maxRetainedExecutions: number };
  files: { read: boolean; write: boolean; binary: boolean; maxFileBytes: number; maxPathBytes: number; timeoutMs: number; [key: string]: boolean | number };
  persistence: { filesystemAfterStop: boolean; snapshots: boolean; memory: boolean; volumes: boolean };
  previews: { supported: boolean; signedUrls: boolean };
  containers: { idempotentCreate: boolean; creationRetentionMs: number; generationRequired: boolean; accountLimitsPath: string; configurableDeadline: boolean };
  resources: Size[];
  images: { catalog: boolean; customBuilds: boolean; availableCatalogPath: string; limits: Record<string, number> };
  authentication: Record<string, boolean>; networking: Record<string, boolean>; access: Record<string, number>;
}
export class MainbrellaError extends Error { code: string; status: number; idempotencyKey?: string; cursor?: number; constructor(code: string, status?: number, details?: Record<string, unknown>) }
export class Mainbrella {
  constructor(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number });
  baseUrl: string; timeoutMs: number;
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string>; binary?: boolean; stream?: boolean; signal?: AbortSignal }): Promise<T>;
  capabilities(): Promise<Capabilities>; list(): Promise<AccountState>; connect(value: ContainerIdentity): Sandbox;
  create(options?: { catalogId?: string; imageId?: string; size?: MachineSize; idempotencyKey?: string; waitTimeoutMs?: number; pollIntervalMs?: number }): Promise<Sandbox>;
}
export class Sandbox implements ContainerIdentity {
  constructor(client: Mainbrella, value: ContainerIdentity);
  client: Mainbrella; id: string; createdAt: string; creationId?: string; imageDigest?: string; instance?: string;
  files: { read(path: string): Promise<Uint8Array>; write(path: string, bytes: Uint8Array): Promise<{ path: string; size: number }> };
  commands: { run(command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
    start(command: string, options?: { timeoutMs?: number; idempotencyKey?: string }): Promise<Execution> };
  kill(): Promise<AccountState>;
}
export const terminalExecutionStates: Set<string>;
export interface ExecutionRecord extends CommandResult {
  id: string; createdAt: string; startedAt: string; finishedAt?: string; retainUntil: number; cursor: number; outputBytes: number;
  status: 'starting' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'output_limit' | 'interrupted';
}
export type ExecutionEvent = { type: 'stdout' | 'stderr'; data: string; sequence: number } | { type: 'status'; execution: Omit<ExecutionRecord, 'stdout' | 'stderr'> };
export class Execution {
  constructor(sandbox: Sandbox, id: string); id: string; cursor: number;
  get(): Promise<ExecutionRecord>; cancel(): Promise<Omit<ExecutionRecord, 'stdout' | 'stderr'>>;
  wait(options?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<ExecutionRecord>;
  events(options?: { cursor?: number; signal?: AbortSignal }): AsyncGenerator<ExecutionEvent>;
}
