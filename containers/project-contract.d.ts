export const MAX_PROJECT_BINDINGS: number;
export function validProjectId(value: unknown): value is string;
export function validProjectRevision(value: unknown): value is string;
export function validProjectBinding(value: unknown): boolean;
export function validProjectOrigin(value: unknown, allowLocal?: boolean): boolean;
export function projectHeaders(input: Headers): Headers;
export function projectResponseHeaders(input: Headers, output: Headers): void;
