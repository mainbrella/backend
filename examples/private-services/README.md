# Local users demo

Two Lite containers run a Node frontend and a Go backend with SQLite. The backend
seeds Ada Lovelace, Grace Hopper, and Linus Torvalds, then executes
`SELECT * FROM users ORDER BY id`. The frontend reads the private `api.internal`
service and renders the three rows. Only the frontend receives a preview link.

From the repository root, with Node 22+ and Go installed:

```sh
mkdir -p .wrangler
(cd examples/private-services/backend && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -mod=mod -o ../../../.wrangler/private-services-api-amd64 .)
node --env-file=.env scripts/deploy-local-users.mjs
```

The launcher uses `MAINBRELLA_LOCAL_API_KEY` exclusively against
`http://localhost:8787`. It uses native HTTP with no new JavaScript dependencies,
preserves existing containers, and saves exact generations, creation keys, and
the preview URL in the ignored private `.wrangler/local-users-deployment.json`.
It verifies the private service, rendered HTML, and preview HTML/API. Failed
deployments attempt generation-qualified cleanup; unresolved creations require
reconciliation with their saved creation key.

Successful deployments leave both app containers running. The preview lasts
15 minutes at most; idle or hard-lease expiry may stop the containers sooner.
Stopping discards SQLite data. To stop only these demo generations and remove
their private network:

```sh
node --env-file=.env scripts/deploy-local-users.mjs --cleanup
```

The next launch archives successfully cleaned state before creating fresh guests.
