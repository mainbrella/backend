# Container automation API

Base URL: `https://api.mainbrella.com` (local API: `http://localhost:8787`).
The dashboard and automation share the same account-owned container and allowance.

## Authentication

Sign in at `https://mainbrella.com/login/`. In browser developer tools, inspect
Storage/Application → Cookies for `https://api.mainbrella.com` and copy the
**value** of `mainbrella_session`. It is an HttpOnly login credential, not a
Google ID token, SSH access token, or Cloudflare token. Supply it as
`Authorization: Bearer <session-value>` to `/containers` and `/containers/ssh`.
There is no separate API key issuance endpoint yet.

Sessions expire 30 days after login. Logging out that session revokes the Bearer
credential too. An expired, revoked, unknown, or malformed Bearer credential
returns 401, even if a valid cookie is also sent. Sign in again to obtain a new
session; do not automatically loop through login on errors.

Bearer requests can omit Origin. If Origin is supplied, it must be allowlisted.
Browser clients continue using the session cookie and must send a trusted Origin
for mutations. Bearer authentication is limited to lifecycle and SSH issuance;
the browser WebSocket terminal remains cookie-authenticated with a trusted Origin.

Keep credentials in a secret store or protected local file, never in a repository,
URL, transcript, or log. This is the full login session credential; treat it as
account access. For example, run the following in **bash** to create a temporary
header file without putting the value in shell history or curl's argument list:

```bash
API_URL=https://api.mainbrella.com
AUTH_FILE=$(mktemp)
chmod 600 "$AUTH_FILE"
trap 'rm -f "$AUTH_FILE"' EXIT
read -r -s -p 'Mainbrella session value: ' MAINBRELLA_SESSION
printf '\n'
printf 'Authorization: Bearer %s\n' "$MAINBRELLA_SESSION" > "$AUTH_FILE"
unset MAINBRELLA_SESSION

# Check status and allowance before starting.
curl --fail-with-body --silent --show-error --header "@$AUTH_FILE" "$API_URL/containers"

# Start one small container. No request body is required.
curl --fail-with-body --silent --show-error --header "@$AUTH_FILE" -X POST "$API_URL/containers"

# Obtain SSH access to run commands (requires local ssh and cloudflared).
# This response contains a secret-bearing command; store it privately.
curl --fail-with-body --silent --show-error --header "@$AUTH_FILE" -X POST "$API_URL/containers/ssh"

# Stop the account's container when finished.
curl --fail-with-body --silent --show-error --header "@$AUTH_FILE" -X DELETE "$API_URL/containers"
```

Only run the operations needed for the task. The four examples are separate
requests, not a script to launch and immediately stop a container. For unattended
use, provision the protected header file through your secret manager and keep it
for the authorized job's duration.

## Endpoints

| Method and path | Result |
| --- | --- |
| `GET /containers` | 200: current container, effective plan, limits, and usage. Does not renew idle time. |
| `POST /containers` | 200: starts the fixed Builder container and returns status after readiness. 409 if one is already running; 429 if monthly starts are exhausted. |
| `DELETE /containers` | 200: stops the account's container and returns status. Safe if already stopped. Does not refund starts. |
| `POST /containers/ssh` | 200: `{command, expiresAt, hostname}` for the running container. `expiresAt` is Unix milliseconds. Access lasts at most 15 minutes or until hard container expiry, whichever comes first. |

Lifecycle response example (UTC timestamps and usage month):

```json
{
  "plan": "builder",
  "containers": [{
    "id": "small",
    "name": "Small container",
    "instance": "lite",
    "status": "running",
    "createdAt": "2026-10-05T12:00:00.000Z",
    "expiresAt": "2026-10-05T13:00:00.000Z"
  }],
  "limits": {
    "maxContainers": 1,
    "maxStartsPerMonth": 10,
    "maxSessionMs": 3600000,
    "idleTimeoutMs": 600000
  },
  "usage": {"month": "2026-10", "starts": 1}
}
```

`containers` is empty when stopped. All logged-in users currently get Builder
($5/month) limits, regardless of saved subscription or billing status. Database
plan resolution is deferred. There is no client-selectable plan or resource size.
The container uses `lite`: 1/16 vCPU, 256 MiB RAM, 2 GB ephemeral disk, with Node 24,
bash, tmux, and outbound internet. The filesystem is lost when the container stops.

The backend derives ownership from the authenticated user and serializes starts
inside that account's private Durable Object. Concurrent launches produce one
success and a 409 for the second request. Request bodies cannot override ownership,
plan, machine ID, image, size, or deadlines. Arbitrary `/containers/<id>` routes
are rejected. UI and API calls, across all sessions of the same account, share
one slot and one monthly quota.

A start reserves one of ten starts in the UTC calendar month before platform
startup. Failed starts still consume a reservation. Repeated POSTs while running
return 409 without using another start. Stopping early does not refund a start.
Usage persists across stops and controller restarts; the allowance resets at the
next UTC month. The one-hour hard deadline never extends. Polling and SSH token
issuance do not keep the container alive; terminal activity can renew the
10-minute idle deadline only within the hard deadline.

## Errors and retry behavior

Errors are JSON `{ "error": "code" }`. Handle HTTP status as well as the code.

| Status | Code | Action |
| --- | --- | --- |
| 401 | `not_authenticated` | Session missing, malformed, expired, or revoked. Obtain a fresh login credential. |
| 403 | `origin_required` / `origin_not_allowed` | Cookie mutations need a trusted Origin; Bearer requests may omit it. Supplied Origins must be trusted. |
| 404 | `not_found` | Use the exact documented route; no arbitrary container IDs. |
| 405 | `method_not_allowed` | Use the documented HTTP method. |
| 409 | `container_limit_exceeded` | Builder's one slot is occupied. GET status and reuse it, or stop it only if the task authorizes replacement. |
| 409 | `container_not_running` | SSH needs a live container; GET status before deciding whether to start. |
| 429 | `container_quota_exceeded` | Ten starts reserved this UTC month. Wait for next month; do not retry or create another account to evade the limit. |
| 429 | `ssh_token_limit` | Ten live SSH access tokens for this account. Reuse existing access or wait for expiration. |
| 503 | `containers_unavailable` / `ssh_unavailable` | Service unavailable. Reconcile with GET before any further launch. |

POST creation is not idempotent. If a request times out or returns 503, GET status
before doing anything else: startup may have succeeded, or a failed startup may
have consumed quota. Do not blindly retry POST. Set a startup client timeout long
enough for the server's 60-second readiness check. SSH tokens stop working when
the container stops or is recreated; do not print the returned token-bearing
command in shared logs. Use the returned SSH command with trusted `ssh` and
`cloudflared` tools to run the requested job; there is no HTTP exec endpoint.
