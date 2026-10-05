import type { Plan } from '../worker/lib/stripe';
export interface Limits { maxContainers: number; maxStartsPerMonth: number; maxSessionMs: number; idleTimeoutMs: number }
export interface Entitlement { plan: Plan | null; active: boolean; validUntil: number | null; checkedAt?: number }
export const PLAN_LIMITS: Readonly<Record<Plan, Readonly<Limits>>>;
export const NO_PLAN_LIMITS: Readonly<Limits>;
export const ACCESS_LIMITS: Readonly<{ maxTerminalConnections: number; maxSSHAccessTokens: number; sshTokenLifetimeMs: number }>;
export const PLAN_DETAILS: Readonly<Record<Plan, { name: string; price: number; limits: Limits; machine: { instance: string; cpuVcpu: number; memoryMiB: number; diskGB: number }; access: typeof ACCESS_LIMITS; features: Record<string, boolean> }>>;
export function validEntitlement(value: unknown, now?: number): boolean;
export function entitlementHeaders(value: Entitlement): Record<string, string>;
export function requestEntitlement(request: Request, now?: number): Entitlement;
