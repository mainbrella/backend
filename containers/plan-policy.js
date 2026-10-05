// Authoritative product policy, shared by the API and private container workers.
// Monthly usage belongs to the account, not a machine or subscription ID.
const hour = 60 * 60 * 1000;
export const PLAN_LIMITS = Object.freeze({
  builder: Object.freeze({ maxComputeUnitHours: 250, maxConcurrentComputeUnits: 28, maxContainers: 5, maxStartsPerMonth: 1_000, maxSessionMs: hour, idleTimeoutMs: 10 * 60_000 }),
  pro: Object.freeze({ maxComputeUnitHours: 9_000, maxConcurrentComputeUnits: 128, maxContainers: 100, maxStartsPerMonth: 10_000, maxSessionMs: 24 * hour, idleTimeoutMs: 30 * 60_000 }),
  scale: Object.freeze({ maxComputeUnitHours: 50_000, maxConcurrentComputeUnits: 640, maxContainers: 500, maxStartsPerMonth: 100_000, maxSessionMs: 72 * hour, idleTimeoutMs: hour }),
});
export const NO_PLAN_LIMITS = Object.freeze({ maxComputeUnitHours: 0, maxConcurrentComputeUnits: 0, maxContainers: 0, maxStartsPerMonth: 0, maxSessionMs: 0, idleTimeoutMs: 0 });
export const MACHINE_SIZES = Object.freeze([
  { id: 'lite', name: 'Lite', instance: 'lite', cpuVcpu: 1 / 16, memoryMiB: 256, diskGB: 2, computeUnits: 1 },
  { id: 'small', name: 'Small', instance: 'standard-1', cpuVcpu: 0.5, memoryMiB: 4096, diskGB: 8, computeUnits: 6 },
  { id: 'medium', name: 'Medium', instance: 'standard-2', cpuVcpu: 1, memoryMiB: 6144, diskGB: 12, computeUnits: 10 },
  { id: 'large', name: 'Large', instance: 'standard-3', cpuVcpu: 2, memoryMiB: 8192, diskGB: 16, computeUnits: 16 },
  { id: 'xl', name: 'XL', instance: 'standard-4', cpuVcpu: 4, memoryMiB: 12288, diskGB: 20, computeUnits: 28 },
].map(Object.freeze));
export const machineSize = id => MACHINE_SIZES.find(size => size.id === id);
export const ACCESS_LIMITS = Object.freeze({ maxTerminalConnections: 4, maxSSHAccessTokens: 10, sshTokenLifetimeMs: 15 * 60_000 });
export const PLAN_DETAILS = Object.freeze(Object.fromEntries(Object.entries(PLAN_LIMITS).map(([plan, limits]) => [plan, {
  name: { builder: 'Builder', pro: 'Pro', scale: 'Scale' }[plan],
  price: { builder: 5, pro: 180, scale: 999 }[plan],
  limits,
  machine: { instance: 'lite', cpuVcpu: 1 / 16, memoryMiB: 256, diskGB: 2 },
  sizes: MACHINE_SIZES,
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
