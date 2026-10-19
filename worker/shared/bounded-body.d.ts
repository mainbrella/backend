export function boundedBody(body: ReadableStream<Uint8Array> | null | undefined, limit?: number, signal?: AbortSignal): Promise<Uint8Array | undefined>;
