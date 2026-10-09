export function validContainerName(name: unknown): boolean;
export function validIdempotencyKey(key: unknown): boolean;
export function validContainerId(id: string): boolean;
export function machineName(userId: string, id: string): string;
export class ContainerAccountController {
  constructor(ctx: { storage: DurableObjectStorage }, machineFor: (userId: string, id: string) => { fetch(request: Request): Promise<Response> }, now?: () => number, invoiceUsage?: (event: import('../worker/lib/usage-billing').UsageInvoice) => Promise<string>, refreshEntitlement?: (userId: string) => Promise<import('./plan-policy.js').Entitlement>);
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}
