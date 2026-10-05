export function validIdempotencyKey(key: unknown): boolean;
export function validContainerId(id: string): boolean;
export function machineName(userId: string, id: string): string;
export class ContainerAccountController {
  constructor(ctx: { storage: DurableObjectStorage }, machineFor: (userId: string, id: string) => { fetch(request: Request): Promise<Response> }, now?: () => number);
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}
