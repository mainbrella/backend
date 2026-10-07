export class PrivateServicesController {
  constructor(ctx: { storage: DurableObjectStorage }, machineFor: (userId: string, id: string) => { fetch(request: Request): Promise<Response> });
  fetch(request: Request): Promise<Response>;
  route(request: Request, userId: string): Promise<Response>;
}
