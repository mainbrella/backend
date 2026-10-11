import type { ContainerAccountController } from './container-account-core.js';
export function vaultConfigured(env: { SECRETS_VAULT_ENABLED?: string; SECRETS_ENCRYPTION_KEY?: string }): boolean;
export function egressConfigured(env: { EGRESS_POLICIES_ENABLED?: string; EGRESS_RELAY_URL?: string; EGRESS_RELAY_TOKEN?: string }): boolean;
export class AccountSecurity {
  constructor(account: ContainerAccountController, env: unknown, fetcher?: typeof fetch);
  fetch(request: Request): Promise<Response>;
  validateSelection(state: unknown, selection: unknown): Promise<string | null>;
}
