export const MAX_PRIVATE_NETWORKS: number;
export const MAX_PRIVATE_MEMBERS: number;
export const MAX_PRIVATE_BYTES: number;
export const PRIVATE_TIMEOUT_MS: number;
export function validServiceName(value: unknown): value is string;
export function validPrivateGeneration(value: unknown): value is string;
export function validPrivatePort(value: unknown): value is number;
export function validPrivateMember(value: unknown): value is { id: string; createdAt: string; name: string; port?: number };
export function boundedPrivateBody(body: ReadableStream<Uint8Array> | null, limit?: number): Promise<Uint8Array | undefined>;
