export type MachineSize = 'lite' | 'small' | 'medium' | 'large' | 'xl';
export interface Size { id: MachineSize; name: string; instance: string; cpuVcpu: number; memoryMiB: number; diskGB: number; computeUnits: number }
export interface NetworkPolicy { allow: string[]; deny?: string[] }
export interface SecretMetadata { id: string; name: string; hostname: string; header: 'authorization' | 'x-api-key' | 'api-key'; prefix: string; createdAt: string; updatedAt: string }
export interface LifecycleOptions { idempotencyKey?: string; waitTimeoutMs?: number; pollIntervalMs?: number }
export interface CreateOptions extends LifecycleOptions { name?: string; lifecycle?: 'ad_hoc' | 'production'; startupCommand?: string; networkPolicy?: NetworkPolicy; secretBindings?: string[]; catalogId?: string; imageId?: string; workspaceId?: string; size?: MachineSize; internet?: boolean }
export interface Image { id: string; name: string; status: 'queued' | 'building' | 'publishing' | 'ready' | 'failed'; digest?: string | null; baseImage?: string | null; cacheFrom?: string | null; createdAt: string; updatedAt: string }
export interface ImageTag { tag: string; imageId: string; updatedAt: string }
export interface PoolOptions { targetSize?: number; create?: Omit<CreateOptions, 'idempotencyKey' | 'lifecycle' | 'startupCommand'> & { lifecycle?: 'ad_hoc' } }
export interface PoolState { closed: boolean; targetSize: number; available: ContainerIdentity[]; pending: { idempotencyKey: string; retryBefore: number } | null }
export interface PoolSelection { size: MachineSize; internet: boolean; catalogId?: string; imageId?: string; networkPolicy?: NetworkPolicy; secretBindings?: string[] }
export interface ManagedPool { id: string; name: string; targetSize: number; ready: number; starting: number; status: 'active' | 'paused' | 'expired' | 'deleting' | 'degraded'; createdAt: string; updatedAt: string; expiresAt: string; lastError?: string; selection: PoolSelection }
export interface ManagedPoolOptions { name: string; targetSize: number; ttlSeconds: number; idempotencyKey?: string; size?: MachineSize; catalogId?: string; imageId?: string; internet?: boolean; networkPolicy?: NetworkPolicy; secretBindings?: string[] }
export interface ImageBuildOptions { name: string; dockerfile: string; context?: Uint8Array; cacheFrom?: string; baseImage?: { image: string; username?: string; password?: string } }
export class SandboxPool { constructor(client: Mainbrella, options?: PoolOptions); readonly state: PoolState; refill(): Promise<PoolState>; acquire(): Promise<Sandbox>; close(): Promise<PoolState> }
export interface ContainerIdentity { id: string; createdAt: string }
export interface RestoreLaunch { command: string; cwd?: string; readiness: { port: number; path?: string; timeoutMs?: number } }
export interface RestoreReadiness { status: 'starting' | 'ready' | 'failed'; port: number; path: string; logPath: string; checkedAt?: string; error?: string; logTail?: string }
export interface Workspace {id:string;name:string;createdAt:string;expiresAt:number;source:ContainerIdentity;size:MachineSize;internet:boolean;networkPolicy?:NetworkPolicy;secretBindings?:string[];imageDigest:string;imageId?:string;imageName?:string;catalogId?:string;bytes:number|null;reservedBytes:number;launch?:RestoreLaunch;archived:boolean;status:'saving'|'ready'|'failed'|'expired'|'deleted';stopRequested:boolean;stopCompleted:boolean}
export interface FileEntry { name: string; path: string; type: 'file' | 'directory' | 'symlink' | 'fifo' | 'socket' | 'character' | 'block' | 'other'; size: number; mode: string; uid: number; gid: number; modifiedAt: string; linkTarget?: string }
export interface DirectoryPage { path: string; entries: FileEntry[]; nextOffset: number | null }
export interface ExecutionOptions { timeoutMs?: number; idempotencyKey?: string; stdin?: boolean; cwd?: string; env?: Record<string, string>; pty?: { cols: number; rows: number } }
export interface GitOptions { cwd: string; timeoutMs?: number; idempotencyKey?: string }
export interface GitOperation { executionId: string; idempotencyKey: string }
export interface GitEntry { indexStatus: string; worktreeStatus: string; path: string; originalPath?: string }
export interface GitBranch { name: string; commit: string; current: boolean }
export interface GitTools {
  status(options: GitOptions): Promise<GitOperation & { entries: GitEntry[] }>;
  branches(options: GitOptions): Promise<GitOperation & { branches: GitBranch[] }>;
  diff(options: GitOptions & { staged?: boolean; paths?: string[] }): Promise<GitOperation & { patch: string }>;
  commit(options: GitOptions & { message: string; author: { name: string; email: string }; idempotencyKey: string }): Promise<GitOperation & { committed: true }>;
  checkout(options: GitOptions & { branch: string; create?: boolean; idempotencyKey: string }): Promise<GitOperation & { branch: string }>;
}
export interface Preview { id: string; port: number; createdAt: string; expiresAt: number }
export interface PreviewLink extends Preview { url: string }
export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; outputTruncated: boolean }
export interface CodeContextRecord { id: string; language: 'python'; createdAt: string; expiresAt: number }
export interface CodeResult { stdout: string; stderr: string; outputTruncated: boolean;
  results: { mimeType: 'text/plain' | 'application/json' | 'text/html' | 'image/png'; data: string }[];
  error: { name: string; message: string; traceback: string } | null }
export interface Container extends ContainerIdentity { internet?: boolean; status: 'starting' | 'running' | 'stopped'; name?: string; lifecycle?: 'ad_hoc' | 'production'; workspaceId?: string; readiness?: RestoreReadiness; launch?: RestoreLaunch; persistenceExpiresAt?: number; networkPolicy?: NetworkPolicy; secretBindings?: string[]; expiresAt: string; imageName?: string; catalogId?: string; imageId?: string; imageDigest?: string; instance?: string; size?: MachineSize; computeUnits?: number }
export interface AccountState { plan: 'builder' | 'pro' | 'scale' | 'usage' | null; active: boolean; containers: Container[];
  sizes: Size[]; imageCatalog: { id: string; name: string }[]; limits: { maxComputeUnitHours: number; maxConcurrentComputeUnits: number; maxContainers: number; maxStartsPerMonth: number; maxSessionMs: number; idleTimeoutMs: number };
  usage: { month: string; starts: number; computeUnitHours: number; reservedComputeUnitHours: number; availableComputeUnitHours: number; concurrentComputeUnits: number } }
export interface Capabilities {
  apiVersion: string;
  pools: { managed: boolean; sdkPrewarming: boolean };
  codeInterpreter: { supported: boolean; languages: 'python'[]; stateful: boolean; memoryPersistence: boolean; maxCodeBytes: number; maxTimeoutMs: number; maxContextMs: number; maxResultBytes: number };
  execution: { foreground: boolean; streaming: boolean; background: boolean; cancellation: boolean; reconnect: boolean; pty: boolean;
    programmaticPty: boolean; ptyResize: boolean; stdin: boolean; signals: boolean; argv: boolean; managedProcessListing: boolean; processListing: boolean;
    maxStdinChunkBytes: number; maxStdinBytes: number; maxPendingStdinBytes: number;
    maxCommandBytes: number; maxTimeoutMs: number; maxOutputBytes: number; maxConcurrentOperations: number;
    maxManagedTimeoutMs: number; retentionMs: number; maxRetainedExecutions: number; maxRetainedOutputBytes: number; maxRetainedEvents: number; retentionScope: 'container-slot' };
  files: { read: boolean; write: boolean; binary: boolean; maxFileBytes: number; maxPathBytes: number; timeoutMs: number; [key: string]: boolean | number };
  persistence: { restoreLaunch: boolean; startupConfiguration: boolean; filesystemAfterStop: boolean; filesystemFork: boolean; snapshots: boolean; workspaces?:boolean; exports?:boolean; memory: boolean; volumes: boolean };
  observability: { lifecycleEvents: boolean; metrics: boolean; webhooks: boolean; otlp: boolean; eventRetentionMs: number; maxLifecycleEvents: number; maxMetricRangeMs: number; metricBucketMs: number };
  previews: { supported: boolean; signedUrls: boolean };
  containers: { idempotentCreate: boolean; creationRetentionMs: number; generationRequired: boolean; accountLimitsPath: string; configurableDeadline: boolean };
  resources: Size[];
  images: { tags: boolean; catalog: boolean; repositoryLaunch: boolean; customBuilds: boolean; crossBuildCache: boolean; privateRegistryImports: boolean; availableCatalogPath: string; limits: Record<string, number> };
  secrets: { vault: boolean };
  authentication: Record<string, boolean>; networking: Record<string, boolean>; access: Record<string, number>;
}
export class MainbrellaError extends Error { code: string; status: number; idempotencyKey?: string; retryAfterSeconds?: number; cursor?: number; previewId?: string; contextId?: string; cleanupUnconfirmed?: boolean; readiness?: RestoreReadiness; constructor(code: string, status?: number, details?: Record<string, unknown>) }
export class Mainbrella {
  constructor(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number });
  baseUrl: string; timeoutMs: number;
  images: { list(): Promise<{ images: Image[]; buildsEnabled: boolean; privateRegistriesEnabled: boolean; limits: Record<string, number>; usage: { month: string; builds: number } }>;
    get(id: string): Promise<{ image: Image }>; logs(id: string): Promise<{ logs: string; status: string }>; delete(id: string): Promise<{ deleted: true }>;
    create(options: ImageBuildOptions): Promise<{ image: Image }>;
    tags: { list(): Promise<{ tags: ImageTag[] }>; get(tag: string): Promise<{ tag: string; image: Image }>; set(tag: string, imageId: string): Promise<ImageTag>; delete(tag: string): Promise<{ deleted: true }> } };
  pool(options?: PoolOptions): SandboxPool;
  pools: { list(): Promise<{ pools: ManagedPool[] }>; get(id: string): Promise<{ pool: ManagedPool }>;
    create(options: ManagedPoolOptions): Promise<{ pool: ManagedPool }>; update(id: string, options: { name?: string; targetSize?: number }): Promise<{ pool: ManagedPool }>;
    delete(id: string): Promise<{ deleted: true }>; acquire(id: string, options?: { idempotencyKey?: string }): Promise<Sandbox> };
  secrets: { list(): Promise<{ secrets: SecretMetadata[] }>; create(options: { name: string; value: string; hostname: string; header: SecretMetadata['header']; prefix?: string }): Promise<SecretMetadata>; rotate(id: string, value: string): Promise<SecretMetadata>; delete(id: string): Promise<{ deleted: true }> };
  workspaces:{list():Promise<{workspaces:Workspace[];limits:{maxSaved:number;maxReservedBytes:number;retentionMs:number;maxSavesPerMonth:number;maxCaptureBytesPerMonth:number;maxRetainedCaptureBytes:number}|null;usage:{saved:number;reservedBytes:number;savesThisMonth:number;captureBytesThisMonth:number;retainedCaptureBytes:number;captureBudgetResetsAt:number;nextRetainedCaptureReleaseAt:number|null;nextRetainedCaptureReleaseBytes:number}}>;
    get(id:string):Promise<Workspace>;update(id:string,options:{name?:string;archived?:boolean}):Promise<Workspace>;delete(id:string):Promise<{deleted:true}>;
    restore(id:string,options?:{idempotencyKey?:string;waitTimeoutMs?:number;pollIntervalMs?:number}):Promise<Sandbox>};
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string>; binary?: boolean; stream?: boolean; signal?: AbortSignal }): Promise<T>;
  capabilities(): Promise<Capabilities>; list(): Promise<AccountState>; connect(value: ContainerIdentity): Sandbox;
  create(options?: CreateOptions): Promise<Sandbox>;
}
export interface NativeFileWatch {
  execution: Execution;
  idempotencyKey: string;
  events(options?: { signal?: AbortSignal }): AsyncGenerator<{ type: 'ready'; path: string; recursive: boolean } | { type: 'rename' | 'change'; filename: string | null }>;
  close(): Promise<{ closed: true }>;
}
export class Sandbox implements ContainerIdentity {
  git: GitTools;
  internet?: boolean;
  constructor(client: Mainbrella, value: ContainerIdentity);
  client: Mainbrella; id: string; createdAt: string; creationId?: string; imageDigest?: string; instance?: string;
  files: { read(path: string): Promise<Uint8Array>; write(path: string, bytes: Uint8Array): Promise<{ path: string; size: number }>;
    upload(path: string, source: Uint8Array | ReadableStream<Uint8Array>, options?: { size?: number; signal?: AbortSignal }): Promise<{ path: string; size: number }>;
    download(path: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
    uploadDirectory(local: string, remote: string, options?: { signal?: AbortSignal }): Promise<{ entries: number }>;
    downloadDirectory(remote: string, local: string, options?: { signal?: AbortSignal }): Promise<{ entries: number }>;
    watch(path: string, options?: { intervalMs?: number; recursive?: boolean; signal?: AbortSignal }): AsyncGenerator<{ type: 'create' | 'modify' | 'remove'; entry: FileEntry }>;
    watchNative(path: string, options?: { recursive?: boolean; timeoutMs?: number; idempotencyKey?: string }): Promise<NativeFileWatch>;
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
  code: { create(options?: { language?: 'python' }): Promise<CodeContext>; list(): Promise<{ contexts: CodeContextRecord[] }>; attach(id: string): CodeContext };
  desktop: { probe(): Promise<{ supported: boolean; tools: Record<'Xvfb' | 'xdpyinfo' | 'xdotool' | 'import', boolean> }>; start(options?: { width?: number; height?: number }): Promise<DesktopSession> };
  kill(): Promise<AccountState>;
  delete(): Promise<AccountState>;
  stop(options?: { idempotencyKey?: string }): Promise<AccountState>;
  resume(options?: LifecycleOptions): Promise<Sandbox>;
  fork(options?: LifecycleOptions & { name?: string }): Promise<Sandbox>;
  networkPolicy?: NetworkPolicy; secretBindings?: string[];
  workspaceId?:string;
  readiness?:RestoreReadiness;
  launch?:RestoreLaunch;
  configureStartup(launch: RestoreLaunch | null): Promise<ContainerIdentity & { launch: RestoreLaunch | null }>;
  waitUntilReady(options?: { waitTimeoutMs?: number; pollIntervalMs?: number }): Promise<RestoreReadiness>;
  saveWorkspace(name:string,options?:{stop?:boolean;launch?:RestoreLaunch;idempotencyKey?:string}):Promise<Workspace>;
  exportWorkspace():Promise<Uint8Array>;
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
export class CodeContext {
  constructor(sandbox: Sandbox, id: string, record?: Partial<CodeContextRecord>);
  id: string; language: 'python'; expiresAt?: number;
  run(code: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CodeResult>;
  close(): Promise<{ closed: true }>;
}
export class DesktopSession {
  private constructor();
  readonly contextId: string; readonly expiresAt?: number; readonly display: string; readonly width: number; readonly height: number;
  move(x: number, y: number): Promise<{ ok: true }>; click(button?: number): Promise<{ ok: true }>;
  press(keys: string): Promise<{ ok: true }>; type(text: string): Promise<{ ok: true }>;
  launch(argv: string[]): Promise<{ pid: number }>; screenshot(): Promise<Uint8Array>; close(): Promise<{ closed: true }>;
}
export class Execution {
  constructor(sandbox: Sandbox, id: string); id: string; cursor: number;
  get(): Promise<ExecutionRecord>; cancel(): Promise<Omit<ExecutionRecord, 'stdout' | 'stderr'>>;
  resize(cols: number, rows: number): Promise<Omit<ExecutionRecord, 'stdout' | 'stderr'>>;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<Omit<ExecutionRecord, 'stdout' | 'stderr'>>;
  stdin: { write(bytes: Uint8Array): Promise<{ bytes: number; stdinClosed: boolean }>; close(): Promise<{ bytes: number; stdinClosed: boolean }> };
  wait(options?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<ExecutionRecord>;
  events(options?: { cursor?: number; signal?: AbortSignal }): AsyncGenerator<ExecutionEvent>;
}
