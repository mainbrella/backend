export type MachineSize = 'lite' | 'small' | 'medium' | 'large' | 'xl';
export interface Size { id: MachineSize; name: string; instance: string; cpuVcpu: number; memoryMiB: number; diskGB: number; computeUnits: number }
export interface ContainerIdentity { id: string; createdAt: string }
export interface FileEntry { name: string; path: string; type: 'file' | 'directory' | 'symlink' | 'fifo' | 'socket' | 'character' | 'block' | 'other'; size: number; mode: string; uid: number; gid: number; modifiedAt: string; linkTarget?: string }
export interface DirectoryPage { path: string; entries: FileEntry[]; nextOffset: number | null }
export interface ExecutionOptions { timeoutMs?: number; idempotencyKey?: string; stdin?: boolean; cwd?: string; env?: Record<string, string>; pty?: { cols: number; rows: number } }
export interface Preview { id: string; port: number; createdAt: string; expiresAt: number }
export interface PreviewLink extends Preview { url: string }
export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; outputTruncated: boolean }
export interface Container extends ContainerIdentity { internet?: boolean; status: 'starting' | 'running'; expiresAt: string; imageName?: string; catalogId?: string; imageId?: string; imageDigest?: string; instance?: string; size?: MachineSize; computeUnits?: number }
export interface AccountState { plan: 'builder' | 'pro' | 'scale' | null; active: boolean; containers: Container[];
  sizes: Size[]; imageCatalog: { id: string; name: string }[]; limits: { maxComputeUnitHours: number; maxConcurrentComputeUnits: number; maxContainers: number; maxStartsPerMonth: number; maxSessionMs: number; idleTimeoutMs: number };
  usage: { month: string; starts: number; computeUnitHours: number; reservedComputeUnitHours: number; availableComputeUnitHours: number; concurrentComputeUnits: number } }
export interface Capabilities {
  apiVersion: string;
  execution: { foreground: boolean; streaming: boolean; background: boolean; cancellation: boolean; reconnect: boolean; pty: boolean;
    programmaticPty: boolean; ptyResize: boolean; stdin: boolean; signals: boolean; argv: boolean; managedProcessListing: boolean; processListing: boolean;
    maxStdinChunkBytes: number; maxStdinBytes: number; maxPendingStdinBytes: number;
    maxCommandBytes: number; maxTimeoutMs: number; maxOutputBytes: number; maxConcurrentOperations: number;
    maxManagedTimeoutMs: number; retentionMs: number; maxRetainedExecutions: number };
  files: { read: boolean; write: boolean; binary: boolean; maxFileBytes: number; maxPathBytes: number; timeoutMs: number; [key: string]: boolean | number };
  persistence: { filesystemAfterStop: boolean; snapshots: boolean; memory: boolean; volumes: boolean };
  observability: { lifecycleEvents: boolean; metrics: boolean; webhooks: boolean; otlp: boolean; eventRetentionMs: number; maxLifecycleEvents: number; maxMetricRangeMs: number; metricBucketMs: number };
  previews: { supported: boolean; signedUrls: boolean };
  containers: { idempotentCreate: boolean; creationRetentionMs: number; generationRequired: boolean; accountLimitsPath: string; configurableDeadline: boolean };
  resources: Size[];
  images: { catalog: boolean; customBuilds: boolean; availableCatalogPath: string; limits: Record<string, number> };
  authentication: Record<string, boolean>; networking: Record<string, boolean>; access: Record<string, number>;
}
export class MainbrellaError extends Error { code: string; status: number; idempotencyKey?: string; cursor?: number; previewId?: string; constructor(code: string, status?: number, details?: Record<string, unknown>) }
export class Mainbrella {
  constructor(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number });
  baseUrl: string; timeoutMs: number;
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string>; binary?: boolean; stream?: boolean; signal?: AbortSignal }): Promise<T>;
  capabilities(): Promise<Capabilities>; list(): Promise<AccountState>; connect(value: ContainerIdentity): Sandbox;
  create(options?: { catalogId?: string; imageId?: string; size?: MachineSize; internet?: boolean; idempotencyKey?: string; waitTimeoutMs?: number; pollIntervalMs?: number }): Promise<Sandbox>;
}
export class Sandbox implements ContainerIdentity {
  internet?: boolean;
  constructor(client: Mainbrella, value: ContainerIdentity);
  client: Mainbrella; id: string; createdAt: string; creationId?: string; imageDigest?: string; instance?: string;
  files: { read(path: string): Promise<Uint8Array>; write(path: string, bytes: Uint8Array): Promise<{ path: string; size: number }>;
    list(path: string, options?: { limit?: number; offset?: number }): Promise<DirectoryPage>;
    stat(path: string, options?: { followSymlinks?: boolean }): Promise<FileEntry>;
    mkdir(path: string, options?: { recursive?: boolean; mode?: string }): Promise<{ path: string; ok: true }>;
    remove(path: string, options?: { recursive?: boolean }): Promise<{ path: string; ok: true }>;
    move(path: string, destination: string): Promise<{ path: string; destination: string; ok: true }>;
    chmod(path: string, mode: string): Promise<{ path: string; mode: string; ok: true }> };
  previews: { create(port: number, options?: { ttlSeconds?: number }): Promise<PreviewLink>;
    list(): Promise<{ previews: Preview[] }>; revoke(previewId: string): Promise<{ revoked: true }> };
  commands: { run(command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
    start(command: string | string[], options?: ExecutionOptions): Promise<Execution>;
    list(): Promise<{ executions: Omit<ExecutionRecord, 'stdout' | 'stderr'>[] }>; attach(id: string): Execution };
  kill(): Promise<AccountState>;
  webhook: { get(): Promise<{webhook: WebhookConfig | null}>; configure(url: string, options?: {replayFromCursor?: number}): Promise<{webhook: WebhookConfig; signingSecret: string}>;
    remove(): Promise<{removed: true}>; deliveries(): Promise<{deliveries: WebhookDelivery[]}>; retry(eventId: string): Promise<WebhookDelivery> };
  events(options?: {cursor?: number; limit?: number}): Promise<LifecyclePage>;
  metrics(options?: {from?: string; to?: string}): Promise<WorkloadMetrics>;
}
export interface LifecycleEvent { id: string; sequence: number; createdAt: string; occurredAt: string; type: 'starting' | 'started' | 'failed' | 'stopped'; reason?: string; size: MachineSize; retainUntil: number }
export interface LifecyclePage { events: LifecycleEvent[]; nextCursor: number; hasMore: boolean; historyTruncated: boolean; retainForMs: number }
export interface WorkloadMetrics { id: string; createdAt: string; from: string; to: string; bucketMs: number; source: 'cloudflare-workload-analytics'; state: 'observed' | 'unobserved'; buckets: {at: string; samples: number; cpuSeconds: number | null; memoryPeakBytes: number | null; diskUsagePeak: number | null}[] }
export const terminalExecutionStates: Set<string>;
export function verifyWebhookSignature(bytes: Uint8Array, signature: string, signingSecret: string, options?: {nowMs?: number; toleranceSeconds?: number}): Promise<boolean>;
export interface WebhookConfig { id: string; url: string; createdAt: string; configuredAt: string; retainUntil: number }
export interface WebhookDelivery { id: string; sequence: number; status: 'pending' | 'sending' | 'delivered' | 'exhausted'; attempts: number; manualRetries: number; nextAt: number | null; retainUntil: number; lastAttemptAt?: number; httpStatus?: number | null }
export interface ExecutionRecord extends CommandResult {
  id: string; createdAt: string; startedAt: string; finishedAt?: string; retainUntil: number; cursor: number; outputBytes: number;
  status: 'starting' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'output_limit' | 'interrupted';
  pty?: { cols: number; rows: number }; stdinEnabled?: boolean; stdinClosed?: boolean; stdinBytes?: number;
}
export type ExecutionEvent = { type: 'stdout' | 'stderr'; data: string; sequence: number } | { type: 'status'; execution: Omit<ExecutionRecord, 'stdout' | 'stderr'> };
export class Execution {
  constructor(sandbox: Sandbox, id: string); id: string; cursor: number;
  get(): Promise<ExecutionRecord>; cancel(): Promise<Omit<ExecutionRecord, 'stdout' | 'stderr'>>;
  resize(cols: number, rows: number): Promise<Omit<ExecutionRecord, 'stdout' | 'stderr'>>;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<Omit<ExecutionRecord, 'stdout' | 'stderr'>>;
  stdin: { write(bytes: Uint8Array): Promise<{ bytes: number; stdinClosed: boolean }>; close(): Promise<{ bytes: number; stdinClosed: boolean }> };
  wait(options?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<ExecutionRecord>;
  events(options?: { cursor?: number; signal?: AbortSignal }): AsyncGenerator<ExecutionEvent>;
}
