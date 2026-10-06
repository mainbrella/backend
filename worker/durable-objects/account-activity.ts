import { DurableObject } from 'cloudflare:workers';
import { AccountActivityController } from '../../containers/activity.js';

export class AccountActivity extends DurableObject<Env> {
  private controller: AccountActivityController;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.controller = new AccountActivityController(ctx);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  fetch(request: Request): Promise<Response> { return this.controller.fetch(request); }
  alarm(): Promise<void> { return this.controller.alarm(); }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> { return this.controller.webSocketMessage(socket, message); }
  webSocketClose(socket: WebSocket): Promise<void> { return this.controller.webSocketClose(socket); }
  webSocketError(socket: WebSocket): Promise<void> { return this.controller.webSocketError(socket); }
}
