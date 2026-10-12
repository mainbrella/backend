export const MAX_TRANSFER_BYTES: number;
export const TRANSFER_TIMEOUT_MS: number;
export function transferSize(value: unknown): number | null;
export function validTransferPath(path: unknown): path is string;
export function exactByteStream(stream: ReadableStream<Uint8Array> | null, size: number, signal?: AbortSignal): ReadableStream<Uint8Array>;
export function fixedByteStream(stream: ReadableStream<Uint8Array> | null, size: number, signal?: AbortSignal): ReadableStream<Uint8Array>;
