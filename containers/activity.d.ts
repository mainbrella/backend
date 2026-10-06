export const MAX_ACTIVITY_CONNECTIONS: number;
export const ACTIVITY_CONNECTION_MS: number;
export const MAX_ACTIVITY_MESSAGE_BYTES: number;
export function validActivityUser(value: unknown): boolean;
export function validActivityChange(value: unknown): boolean;
export function publishActivity(env: { ACCOUNT_ACTIVITY?: DurableObjectNamespace }, userId: string, change: unknown): Promise<void>;
export class AccountActivityController {
  constructor(ctx: DurableObjectState, options?: { now?: () => number; pairFactory?: () => Record<string, WebSocket>; responseFactory?: (socket: WebSocket) => Response });
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(socket: WebSocket): Promise<void>;
  webSocketError(socket: WebSocket): Promise<void>;
}
