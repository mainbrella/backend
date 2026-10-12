import { createRelay } from './egress-relay.mjs';
// Bound memory use for the shared Lite relay. Public ingress authenticates
// before waking this trusted container. Never log bodies or authorization.
createRelay({ token: process.env.EGRESS_RELAY_TOKEN, maxConcurrent: 2 })
  .listen(Number(process.env.EGRESS_RELAY_PORT ?? 8081), process.env.EGRESS_RELAY_BIND ?? '127.0.0.1');
