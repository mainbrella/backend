import { z } from 'zod';
import { ACTIVITY_CONNECTION_MS, MAX_ACTIVITY_CONNECTIONS } from '../../containers/activity.js';
import { containerSecurity, errors, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

export function registerActivityRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/containers/activity', {
    operationId: 'connectAccountActivity', tags: ['Containers'], summary: 'Subscribe to account activity over a read-only WebSocket', security: containerSecurity,
    description: `Requires observability.activityWebSocket. API keys and session Bearer tokens authenticate in Authorization; browser cookies require an explicit trusted Origin. No query parameters or client-selected account IDs. The server sends {type:"ready"} on attachment: load an HTTP snapshot after this frame to repair missed changes. Future {type:"changed",id,resource,containerId,createdAt,executionId?} frames invalidate owned container lifecycle, managed execution status or preview metadata; resource is containers, executions or previews. Generations are exact ISO strings. No commands, output, credentials, preview URLs or activity history are sent. Events are best-effort hints, not a durable approval queue or replay journal. Disconnect/reconnect never executes work or renews a workspace lease. At most ${MAX_ACTIVITY_CONNECTIONS} sockets per account; connections close after ${ACTIVITY_CONNECTION_MS / 1000} seconds to reauthenticate. Text ping receives pong automatically; other client messages close with 1008. Reconnect with backoff, wait for ready, then resync. Inspection requires no paid plan.`,
    request: { headers: z.object({ Upgrade: z.literal('websocket'), Origin: z.string().url().optional() }), query: z.object({}) },
    responses: { 101: { description: 'WebSocket upgraded. Ready and changed frames are JSON text.' }, ...errors(400, 401, 403, 405, 426, 429, 503) },
  }, handler);
}
