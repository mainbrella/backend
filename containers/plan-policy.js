// Authoritative product policy, shared by the API and private container workers.
// Monthly usage belongs to the account, not a machine or subscription ID.
const hour = 60 * 60 * 1000;
export const PLAN_LIMITS = Object.freeze({
  builder: Object.freeze({ maxContainers: 5, maxStartsPerMonth: 10, maxSessionMs: hour, idleTimeoutMs: 10 * 60_000 }),
  pro: Object.freeze({ maxContainers: 100, maxStartsPerMonth: 1_000, maxSessionMs: 24 * hour, idleTimeoutMs: 30 * 60_000 }),
  scale: Object.freeze({ maxContainers: 500, maxStartsPerMonth: 10_000, maxSessionMs: 72 * hour, idleTimeoutMs: hour }),
});
export const NO_PLAN_LIMITS = Object.freeze({ maxContainers: 0, maxStartsPerMonth: 0, maxSessionMs: 0, idleTimeoutMs: 0 });
export const ACCESS_LIMITS = Object.freeze({ maxTerminalConnections: 4, maxSSHAccessTokens: 10, sshTokenLifetimeMs: 15 * 60_000 });
export const PLAN_DETAILS = Object.freeze(Object.fromEntries(Object.entries(PLAN_LIMITS).map(([plan, limits]) => [plan, {
  name: { builder: 'Builder', pro: 'Pro', scale: 'Scale' }[plan],
  price: { builder: 5, pro: 180, scale: 999 }[plan],
  limits,
  machine: { instance: 'lite', cpuVcpu: 1 / 16, memoryMiB: 256, diskGB: 2 },
  access: ACCESS_LIMITS,
  features: { browserTerminal: true, ssh: true, internet: true, snapshots: false, persistentDisk: false,
    customSizes: false, teams: false, sdk: false, advancedLogs: false, auditExports: false, priorityCapacity: false, usageBilling: false },
}])));
export function validEntitlement(value, now = Date.now()) {
  return Boolean(value?.active === true && Object.hasOwn(PLAN_LIMITS, value.plan)
    && Number.isSafeInteger(value.validUntil) && value.validUntil > now);
}
export function entitlementHeaders(value) {
  return {
    'x-mainbrella-plan': value?.active ? value.plan : '',
    'x-mainbrella-paid-until': String(value?.active ? value.validUntil : 0),
    'x-mainbrella-checked-at': String(value?.checkedAt ?? Date.now()),
  };
}
export function requestEntitlement(request, now = Date.now()) {
  const value = { plan: request.headers.get('x-mainbrella-plan'), active: true,
    validUntil: Number(request.headers.get('x-mainbrella-paid-until')),
    checkedAt: Number(request.headers.get('x-mainbrella-checked-at')) || now };
  return validEntitlement(value, now) ? value : { plan: null, active: false, validUntil: null, checkedAt: value.checkedAt };
}
