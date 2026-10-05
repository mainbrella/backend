export const MAX_FILE_BYTES: number;
export const MAX_FILE_PATH_BYTES: number;
export const FILE_TIMEOUT_MS: number;
export function validFilePath(path: unknown): path is string;
export function readFileBytes(stream: ReadableStream<Uint8Array> | null, limit?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
