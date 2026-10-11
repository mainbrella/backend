export interface NetworkPolicy { allow: string[]; deny: string[] }
export interface SecretInput { name: string; value: string; hostname: string; header: string; prefix?: string }
export interface SecretMetadata { id: string; name: string; hostname: string; header: string; prefix: string; createdAt: string; updatedAt: string }
export const MAX_SECRET_BYTES: number;
export const EGRESS_REQUEST_BYTES: number;
export const EGRESS_RESPONSE_BYTES: number;
export const EGRESS_TIMEOUT_MS: number;
export function validSecretId(value: unknown): value is string;
export function normalizeNetworkPolicy(value: unknown): NetworkPolicy | null;
export function normalizeSecretBindings(value: unknown): string[] | null;
export function normalizeSecret(value: unknown): (SecretInput & { prefix: string }) | null;
export function validSecretValue(value: unknown): value is string;
export function secretMetadata(value: SecretMetadata): SecretMetadata;
export function relayConfiguration(env: { EGRESS_RELAY_URL?: string; EGRESS_RELAY_TOKEN?: string }): { url: URL; token: string } | null;
export function safeEgressHeaders(headers: Headers): Headers;
export function egressTarget(value: unknown): URL | null;
export function publicAddress(value: string): boolean;
export function publicHostname(value: string): boolean;
export function targetAllowed(policy: NetworkPolicy, hostname: string, address?: string): boolean;
