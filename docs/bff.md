# BFF v0.0.1

An owner-managed SQLite backend with isolated JavaScript functions. The workspace
at `/bff/app/` starts with no projects. Creating a project provisions a dedicated
D1 database with a message-board starter: `users`, `messages`, Alice and Bob,
two sample posts, four functions, and row ownership policies. Data persists after
reload. Existing projects are unchanged; API callers can request
`{ "name": "My backend", "template": "empty" }` for a database without the starter.

The workspace includes schema inspection, SQL, ordered migrations, immutable
function versions, execution metadata, daily budgets, pause/resume, and table
permissions. In **Permissions**, start the message board demo and switch between
Alice and Bob. Both can read all messages; posting uses the current user, and
editing or deleting another user's message affects zero rows. The demo uses a
scoped browser key and a real user session on the Data API. End the demo to revoke
both credentials; switching projects or signing out also attempts cleanup.

The public example at `/bff/demo/` starts with an Alice/Bob dropdown and a **Log in**
button. It issues a real one-hour project user session, keeps that credential in
memory, and sends it with the scoped browser key on every table request. Every
message has an Edit action, including other users' posts. Saves preserve the
original author, so a non-owner edit displays the backend's `permission_denied`
response and keeps the draft. **Log out** revokes the session and returns to the
login form; reloading also starts at login.

Its React frontend, API client, styles, and tests live in
[`examples/message-board`](../../web/examples/message-board). Run
`npm run dev:message-board` from `../web` to develop it independently.
The website composes that workspace into the existing `/bff/demo/` route; BFF
owns only the backend behavior and fixed public-demo allowlist.

Management APIs accept the project owner's Mainbrella session or account API key
from `/api-keys/`. Message-board projects support real email/password accounts
through the scoped browser API described below. Owners can also issue sessions
for existing project users. The Alice/Bob public demo is an explicit
exception restricted to the project, browser key, and two users in `worker/demo-config.ts`.
Storage, realtime, automations,
notifications, search, payments, backup management, client SDKs, staging environments,
and project deletion remain deferred. The landing page's SDK examples are illustrative.

## Setup

1. Apply the backend’s pending migrations, including `050_bff.sql`,
   `051_bff_api_keys.sql`, `052_bff_shared_api_keys.sql`,
   `053_bff_table_policies.sql`, `054_bff_message_board.sql`, and
   `055_bff_public_demo.sql`, using the normal migration
   command (`npm run db:migrate:local` for local control data).
2. For deployed Workers, configure `BFF_CLOUDFLARE_ACCOUNT_ID` and `BFF_CLOUDFLARE_API_TOKEN` on the API
   Worker. Create a dedicated API token with **Account → D1 → Edit** permission
   scoped to the account hosting customer databases. Use Wrangler secrets
   for deployed environments. Local development requires neither credential:
   the backend dev launcher automatically supplies Wrangler local D1 databases.
   Prefer a separate Cloudflare account for customer databases; it can differ
   from the account hosting the API Worker.
3. The API config declares `worker_loaders: [{ "binding": "BFF_LOADER" }]` and
   `BFF_ENABLED=true`. Staging defaults to disabled and needs its own credentials
   and explicit enablement. Missing database-provider configuration or loader fails closed.
4. Run `npm run dev` in backend and `npm run dev:local` in `../web`, sign in, and open `/bff/app/`.
   Create a project and open Permissions to try the message board. You can also
   apply migrations, run SQL, and save or invoke functions. Local provisioning creates
   isolated, persistent **local Wrangler D1 databases** under the backend's
   `.wrangler/state/bff/<database-id>/` directory. The launcher honors `--persist-to`
   and never falls back to remote databases in local mode. See the backend's
   [local development guide](../README.md#local-development) for direct SQL
   access. Existing local projects backed by remote databases are not copied;
   create a new local project to start with local D1.

For deployment, configure your Wrangler login and BFF secrets once from the backend directory:

```sh
npm exec -- wrangler login
npm exec -- wrangler secret put BFF_CLOUDFLARE_ACCOUNT_ID
npm exec -- wrangler secret put BFF_CLOUDFLARE_API_TOKEN
```

The account ID is the 32-character Cloudflare account ID where customer databases
will be created. The token must cover that same account. Wrangler login authorizes
deployment; it does not configure these runtime credentials. Secret commands prompt
for values and deploy them immediately, so refresh `/bff/app/` after both succeed.
See Cloudflare's [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Deploy the API from backend, then the website from its own checkout:

```sh
npm run deploy
cd ../web
npm run deploy
```

The backend command applies pending account D1 migrations, runs API preflight,
and publishes the API. The web command builds and publishes Builder and the
website. Each command uses local Cloudflare authentication and writes release
evidence in its own `artifacts/releases` directory.

With BFF enabled, API preflight checks both credential bindings and the isolation
loader before publishing. Missing credentials stop deployment with the exact local
setup commands, rather than leaving the workspace unavailable. This checks binding
presence; project provisioning verifies the token's actual account access.

Use `npm run deploy -- --check` in each repo to validate and bundle its hosts
without publication or remote migrations. If website publication fails, the API
release remains recorded in backend; retry web deployment separately.

No infrastructure is provisioned just by opening the workspace. Project creation
first persists a pending control record, then the UI requests provisioning. Failed
provisioning can be retried from the workspace. A deterministic database name and
a provisioning lease recover lost create responses without allocating another
database. Existing project names are idempotent per owner. The control plane keeps
the database UUID; it is never accepted from the browser or customer code.

## Fetch and preview image services

These services use the Worker’s outbound `fetch()` and require no BFF project,
customer database, or function deployment when called by an owner. BFF must be
enabled. Owner calls authenticate with a Mainbrella session cookie from an allowed
Mainbrella origin, or an account API key (`Authorization: Bearer mb_...`) from a
trusted server. `/bff/og-image` also supports a project user: send both the
project's scoped browser key (`apikey: bff_pk_...`) and a live project user session
(`Authorization: Bearer bff_us_...`). The key identifies the project; its live
grant must belong to that project's owner, and a supplied browser Origin must be
configured for the key. The project must be ready, unpaused, and unblocked, and
the unexpired session must belong to that same project. A browser key alone is
not enough. Explicit project credentials do not fall back to an account cookie.
Project calls need an available control database and can return 409
`database_not_ready`; they do not need a project table-operation grant.

`POST /bff/fetch` accepts `{ "url": "https://example.com", "userAgent": "MyApp/1.0" }`.
It performs a GET with that User-Agent and returns HTTP 200 with
`{ url, status, statusText, ok, redirected, headers, body, bodyEncoding }`.
`status` and `ok` describe the upstream reply, including upstream 4xx/5xx errors.
The default `bodyEncoding` is `text` (UTF-8). Add `"responseType": "base64"` to
preserve binary bytes. Headers are JSON data; upstream cookies are never applied
to the browser, and caller cookies and authorization are never forwarded upstream.

`POST /bff/og-image` accepts `{ "url": "https://example.com/article" }` and returns
`{ "image": "https://example.com/preview.jpg" }`, or `{ "image": null }` when no
usable image exists. It sends `Accept: text/html` and
`User-Agent: MainbrellaPreviewBot/1.0`. HTMLRewriter prefers the first usable
`og:image`, falls back to `twitter:image`, ignores metadata after the body starts,
and cancels reading once an Open Graph image or the body is reached. Relative
image URLs resolve against the final page URL after redirects. Image URLs must
use HTTP(S) without embedded credentials. Upstream HTTP failures return 502 with
an error such as `upstream_http_404`.

For example, from a signed-in Mainbrella frontend:

```js
async function bffService(service, input) {
  const response = await fetch(`https://api.mainbrella.com/bff/${service}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

const reply = await bffService('fetch', {
  url: 'https://example.com/article',
  userAgent: 'MyApp/1.0',
});
const { image } = await bffService('og-image', {
  url: 'https://example.com/article',
});
```

From a project frontend, pass both project credentials and omit cookies. Replace
the placeholders with the scoped browser key and a session issued for a user in
that project:

```js
const response = await fetch('https://api.mainbrella.com/bff/og-image', {
  method: 'POST',
  credentials: 'omit',
  headers: {
    'Content-Type': 'application/json',
    apikey: 'bff_pk_…',
    Authorization: 'Bearer bff_us_…',
  },
  body: JSON.stringify({ url: 'https://example.com/article' }),
});
const { image } = await response.json();
```

The browser key alone cannot authorize this endpoint; the user session is also
required. `/bff/fetch` remains owner-only.

To enable screenshot fallback, include `projectId` in `/bff/og-image`:

```json
{ "url": "https://example.com/article", "projectId": "YOUR_PROJECT_UUID" }
```

The owner must own that project. Scoped keys and sessions must match it. Without
`projectId`, the existing metadata-only response stays the same. With it, the
priority is `og:image`, `twitter:image`, a cached or queued screenshot, then the
page's favicon. If neither a screenshot nor favicon is available, `image` is null
and `source` is `placeholder`, so the frontend can show its standard placeholder.

A metadata match returns HTTP 200 with `image`, `source` (`og` or `twitter`) and
`status: "ready"`. Missing metadata, or a failed plain fetch, enqueues a Cloudflare
Queue job and returns HTTP 202 with `Retry-After: 3`:

```json
{
  "image": null,
  "source": "placeholder",
  "status": "pending",
  "previewId": "PREVIEW_UUID",
  "statusUrl": "https://api.mainbrella.com/bff/projects/PROJECT_UUID/previews/PREVIEW_UUID"
}
```

Poll `statusUrl` with the same credentials. It returns 202 until the job finishes,
then 200 with `status: "ready"` and `source: "screenshot"`, or `status: "failed"`
and the favicon/placeholder. A failed capture is remembered for six hours to
avoid repeatedly rendering a blocked page. Duplicate requests share a job, and
expired delivery/processing leases are recoverable through polling.

The queue uses Browser Run's `snapshot` Quick Action to get rendered HTML and a
JPEG from the same browser session: 1200×630, quality 80, `fullPage: false`.
Navigation and actions have 10-second limits within a 25-second overall deadline.
HTTP failures, known challenge/login/error titles, common CAPTCHA or consent
overlays, and empty HTML are rejected before saving. These checks are conservative
heuristics; they cannot guarantee that every screenshot is visually useful.
Submitted and final hostnames are checked against public DNS answers. Browser
request patterns reject IP literals, local/reserved suffixes, credentials and
non-default ports for both subresources and redirects. These hostname checks do
not pin browser DNS resolution or provide per-request DNS rebinding protection.

Screenshots use the existing `BUCKET` binding and account storage metering/funding
rules. Each immutable JPEG is stored under
`products/bff/<ownerId>/<projectId>/previews/<urlHash>/<previewId>.jpg`. Successful
captures are cached for 14 days. The scheduled worker removes expired objects and
objects whose project/account was deleted. There are at most 1,000 retained jobs
per project, with admission limited to 100 new records per UTC day. Cached reads
and metadata matches do not enqueue additional browser work.

The returned `/bff/preview-images/<previewId>.jpg` URL is a public bearer link for
use in `<img>` elements. Anyone with the unguessable URL can view it; do not treat
it as private account content. Reads require a live, unpaused, unblocked project,
and return 404 after expiry. Browser caches may retain it for up to one hour.

Before deploying this fallback, create its queue once and apply migration 057:

```sh
npx wrangler queues create mainbrella-bff-previews
npm run db:migrate:remote
npm run deploy
```

The checked-in API config declares the `BROWSER` binding and the queue producer
and consumer. Browser Run Quick Actions need a remote browser during local
development (`browser.remote: true` in a local config); the default local browser
does not implement Quick Actions. Staging keeps BFF disabled and strips these
bindings, so it never consumes the production queue. The tests use a local mock
browser with real workerd Queues, D1 and R2.

Both services accept public HTTP(S) URLs on default ports without embedded
credentials or fragments. Private IP literals and local/reserved hostnames are
rejected, including redirect targets. They follow up to five redirects and read
at most 5 MiB. A single deadline covers redirects and body reads: 15 seconds for
fetch, 8 seconds for preview images. Oversized replies return 413
`response_too_large`, network failures return 502 `fetch_failed`, and deadlines
return 504 `fetch_timeout`. Responses use `Cache-Control: no-store`.

## Data and migrations

`050_bff.sql` adds only control-plane tables to the host’s `DB`: projects, function
source versions, daily usage, execution metadata, and a database deletion outbox. Every project has a separate
D1 database. Provisioning installs the hidden `_bff_migrations` ledger and, by
default, migration 1 (`message_board`). The starter creates public user profiles
(`id`, `name`, `created_at`) and messages (`id`, `user_id`, `body`, `created_at`).
Message IDs and timestamps have database defaults; bodies must contain 1–2000
characters. The next application migration is sequence 2. An explicitly empty
project starts with only the ledger and its first migration is sequence 1.
Starter provisioning is retryable and never overwrites committed seed data,
policies, or function versions. The trusted gateway accesses customer D1 via
Cloudflare’s account API, so it can provision databases without redeploying static
bindings. Account credentials remain in the gateway.

The SQL editor accepts one SELECT, INSERT, UPDATE, or DELETE statement, with
optional bound scalar parameters. Schema changes use migrations:

```json
{
  "sequence": 1,
  "name": "create_notes",
  "sql": "CREATE TABLE notes(id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);"
}
```

Each migration has the next sequential number, a unique name, exact source SQL,
SHA-256 checksum, and applied timestamp. The ledger insert and all statements go
in one transactional D1 batch. A constraint rejects out-of-order sequences before
DDL executes. Identical retries are no-ops; changing a previously applied migration
or reusing its name returns 409. Failed batches roll back both schema and ledger.
Recovery from an ambiguous provider response checks the committed ledger.
Apply a new forward migration to undo a change; automated down migrations are not
provided. Keep migration SQL in source control as well.

The scanner handles SQLite quoting and comments. This release supports ordinary
tables, indexes, ALTER/DROP TABLE or INDEX, and data backfills. Triggers, views,
virtual tables, PRAGMA, ATTACH/DETACH, explicit transactions, and WITH statements
are outside the supported SQL surface. `_bff_`, `_cf_`, and `sqlite_` names are
reserved, including when quoted. These restrictions preserve migration history;
tenant isolation comes from separate databases and authorization.

## Functions and isolation

Functions are single JavaScript ES modules with a default function export. No
package installation, TypeScript compilation, ambient secrets, filesystem,
background jobs, or general service bindings are provided.

```js
export default async function(input, ctx) {
  return (await ctx.db.select('notes', { id: input.id }, 1)).results;
}
```

Saving creates an immutable version using an `expectedVersion` compare-and-swap
(0 for a new function). Invocations can pin any saved version. A fresh Dynamic
Worker is loaded for every invocation with `env: {}`, `globalOutbound: null`, no
inherited compatibility flags, 50 ms CPU and 11 subrequests. HTTP and TCP egress
are denied by the runtime. Customer source is never evaluated by the API Worker.
See Cloudflare’s [egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)
and [resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/).

Database access defaults to `none` (`ctx.db === null`). An owner may grant `read`
or `write` when saving a version. A per-invocation RPC capability exposes only:

- `select(table, filters = {}, limit = 100)` → `{ results, meta, success }`
- `insert(table, row)` → result with inserted rows
- `update(table, filters, row)` → result with updated rows
- `remove(table, filters)` → deletion result

Filters are scalar equality tests; null uses SQLite’s `IS` semantics. Update and
remove require a nonempty filter. Values are bound, identifiers validated, and
internal tables inaccessible. The capability holds one server-selected database,
checks pause/block state on each call, allows at most 10 calls, and expires after
5 seconds. No raw SQL, migration, provisioning, cross-project ID, or credential
method crosses the RPC boundary. Read access cannot write.

The gateway enforces a 5-second response deadline and closes the capability when
the invocation ends. CPU and subrequest enforcement belongs to the Cloudflare
runtime. Database writes that already reached D1 may commit even if execution
later fails or times out. A function is not an interactive database transaction;
design side effects to tolerate retries. Results must serialize to JSON. Inputs
and outputs are limited to 64 KiB; source is limited to 32 KiB.

## External browser Data API

In the BFF workspace, open **Connect app** to select a table, explicitly enable
public reads, and create a read-only browser key for your frontend's exact origins.
Copy the generated configuration or complete JavaScript fetch example into your
app. The full key is available only in the current workspace session; it cannot
be retrieved after a reload or project switch. Existing browser keys and their
origins and grants are listed on the same screen, where they can be revoked.

For the first frontend app, run this from backend after deploying the API and
applying pending backend migrations. It reads the existing account key from the
referenced environment file without printing it:

```sh
node --env-file=.env scripts/bff-prepare-public-read.mjs
```

Alternatively, set `MAINBRELLA_API_KEY` in your shell and run `npm run bff:example:prepare`.
The command provisions a real project, creates a `products` table with Coffee,
Tea, and Water, enables public reads, creates a read-only browser key, and verifies
browser CORS and the public SELECT request. It prints `{ apiOrigin, projectId, publicKey, table }`
for use in the frontend. No account key goes into that configuration. Defaults
are the production API and `http://localhost:5173` as the frontend origin; set
`BFF_API_ORIGIN`, `BFF_FRONTEND_ORIGIN`, and `BFF_PROJECT_NAME` to override them.
Project/migration retries reuse the project and rows; each run creates a new
browser key. Revoke unused keys from `/api-keys/`.

With the printed configuration, the frontend can immediately run:

```js
const { apiOrigin, projectId, publicKey, table } = config;
const response = await fetch(
  `${apiOrigin}/bff/data/${projectId}/tables/${table}?select=*`,
  { headers: { apikey: publicKey } },
);
if (!response.ok) throw new Error((await response.json()).error);
const { data } = await response.json(); // Coffee, Tea, Water
```

No user login, JWT, Mainbrella session cookie, or owner credential is needed for
this request. Reads default to 100 rows; use `limit`, `offset`, and `order` for
pagination. The public key identifies the project and limits table/function
access; the table policy decides whether anonymous reads are allowed.

Existing `MAINBRELLA_API_KEY` account credentials work for BFF, including SQL,
project creation, provisioning, migrations, and function calls. From a trusted server:

```sh
curl "https://api.mainbrella.com/bff/projects/$PROJECT_ID/query" \
  -H "Authorization: Bearer $MAINBRELLA_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"sql":"SELECT * FROM notes","params":[]}'
```

The response is `{ result: { success, results: [...], meta } }`. The same account
key can call `/bff/data/{projectId}/tables/{table}` with owner access, and the data
function endpoint runs the latest saved version. Ownership, pause/block switches,
and budgets still apply. An explicit invalid Bearer credential never falls back
to a browser session. Account keys are powerful server credentials; public
browser apps should use scoped keys.

Tables without an explicit policy deny browser access, including tables with
existing browser key grants. The starter explicitly enables reads of `users` and
`messages`. For an existing table, explicitly allow public reads using
the owner API before creating or using its browser key:

```sh
curl -X PUT "https://api.mainbrella.com/bff/projects/$PROJECT_ID/policies/notes" \
  -H "Authorization: Bearer $MAINBRELLA_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"select":"public"}'
```

Both a `select` key grant and a `select: public` table policy are required.
`GET /bff/projects/{id}/policies` lists policies. `PUT .../policies/{table}` accepts
`{ "select": "public" }` or `{ "select": "none" }`, plus optional `insert`,
`update`, and `delete` (`none` or `own`, default `none`) and `ownerColumn`.
Any `own` operation requires an existing ownership column. There are
at most 100 policies per project. `DELETE .../policies/{table}` revokes public
access and is idempotent. Listing and revocation remain available while paused
or BFF is disabled. Policies are keyed by table name and cover all rows and
columns, including data/columns added later. Deleting a project deletes its policies.

Published functions invoked with a browser key receive an anonymous database
capability unless a valid project user session is also supplied. Every call checks the live key's table grant and current table policy.
Anonymous callers cannot read private tables or write, even if the saved function
has `write` database access or the key has a legacy write grant. Authenticated
application users can write only where an own-row policy and key grant allow it. Owner-authenticated
invocations retain administrative database capabilities. Revoking a policy or key
blocks subsequent database calls, including calls from a running function; it
does not cancel provider requests already in flight.

Scoped browser credentials use the same `api_keys` store, token generation,
identity lookup, usage tracking, and revocation system as account keys. BFF keeps
only its table/function/origin grants in `bff_api_key_grants`. Both key types are
listed at `https://mainbrella.com/api-keys/`, labeled Account or BFF browser, and
can be revoked there. Browser keys retain their `bff_pk_` prefix and cannot
authenticate Linux or BFF owner operations. Migration 052 preserves existing
browser tokens and grants; no key rotation is required.

Create a scoped key with the owner management API using your signed-in Mainbrella
session, or use `Authorization: Bearer <MAINBRELLA_API_KEY>` from a trusted server:

```js
const api = 'https://api.mainbrella.com';
const projectId = 'YOUR_PROJECT_ID';
const response = await fetch(`${api}/bff/projects/${projectId}/api-keys`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'My web app',
    origins: ['https://my-app.example', 'http://localhost:3000'],
    tables: { notes: ['select'] },
    functions: { read_notes: 1 },
  }),
});
if (!response.ok) throw new Error((await response.json()).error);
const { key, token } = await response.json();
```

Browser key-management requests require an allowed Mainbrella origin. Server
requests can omit Origin. The project must be ready;
any granted function version must already exist. The response returns the full
`bff_pk_…` token once. Only its SHA-256 hash is stored in the shared key store. `GET` on the same URL lists
key IDs, names, prefixes, origins and grants; `DELETE /bff/projects/{projectId}/api-keys/{keyId}`
revokes a key, as does the top-level API Keys page. Listing and revocation work while the project is paused or the
feature is disabled. Revocation stops new requests; it does not cancel operations
already running. There are at most 20 live keys per project.

The owner can add a table operation to an existing browser key without rotating
its token:

```js
await fetch(`${api}/bff/projects/${projectId}/api-keys/${key.id}`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${accountKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ table: 'messages', operation: 'insert' }),
}); // 200: { key }, with updated grant metadata; no token or hash
```

Use `select`, `insert`, `update`, or `delete` for `operation`. This operation is
idempotent and adds only that grant. It preserves origins, other table
operations, and pinned functions, including under concurrent grant requests.
The table and key must exist in the owner's ready project. Adding a new table
respects the combined limit of 50 table and function grants per key; adding an
operation to an already-granted table is allowed at that limit. Missing
keys/tables return 404; a full grant list returns 429 `api_key_grant_limit`.
Public reads also require a `select: public` table policy. Writes require both
the matching key grant and an `own` policy with its ownership column; signed-in
inserts also require the project user session.

With the updated API deployed, run the Canopy CLI from the application directory
containing `canopy.json` and use an account key in `MAINBRELLA_API_KEY`:

```sh
canopy --browser-keys
canopy --grant messages insert --key <KEY_ID>
```

The listing includes IDs, safe prefixes, origins, and grants. Use the existing
key ID associated with the application's browser token. The frontend continues
using that same token.

In the external frontend, use the scoped token without Mainbrella cookies:

```js
const base = `https://api.mainbrella.com/bff/data/${projectId}`;
const headers = { apikey: 'YOUR_BFF_BROWSER_KEY' };

// Equivalent to SELECT * FROM notes LIMIT 100.
const response = await fetch(`${base}/tables/notes`, { headers });
if (!response.ok) throw new Error((await response.json()).error);
const { data, meta } = await response.json();
// data: [{ id: 'one', body: 'Hello' }], meta: provider execution metadata

// SELECT id, body FROM notes WHERE id IS ? ORDER BY id ASC LIMIT 10.
const params = new URLSearchParams({
  select: 'id,body', id: 'eq.one', order: 'id.asc', limit: '10',
});
const filtered = await fetch(`${base}/tables/notes?${params}`, { headers });

// Invoke only the function version pinned in the key's grant.
const result = await fetch(`${base}/functions/read_notes/invoke`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ input: { id: 'one' } }),
}).then(response => response.json());
// { id, version: 1, ok: true, value: [...] }
```

The key can be sent as `apikey` or `Authorization: Bearer …`. Supplying both with
different values is rejected. A key authorizes only its own project. Browser
origins must match an origin on that key exactly; wildcards and URL paths are
rejected. Preflights allow `apikey`, `authorization`, and `content-type`, without
credentialed cookies. Non-browser requests can omit Origin; CORS is a browser
control, not a substitute for the key's permissions.

| Endpoint | Access | Body / query |
| --- | --- | --- |
| `GET /bff/data/{id}/tables/{table}` | Owner, or public SELECT policy + `select` key grant | Optional `select`, `limit`, `offset`, `order`, and column filters |
| `POST /bff/data/{id}/tables/{table}` | Owner, or user session + key grant + own-row policy | One JSON row; no query parameters |
| `PATCH /bff/data/{id}/tables/{table}?id=eq.one` | Owner, or user session + key grant + own-row policy | JSON object of changed columns; at least one filter |
| `DELETE /bff/data/{id}/tables/{table}?id=eq.one` | Owner, or user session + key grant + own-row policy | At least one filter |

Table responses are `{ data: [...], meta: {...} }`; insertion returns 201. Insert
and update return the affected rows. Delete returns empty `data` and an affected
row count in `meta.changes`. Filters support `column=eq.value` and `column=is.null`,
combined with AND. Equality values are strings bound through SQLite's column
affinity rules. Rows accept strings, finite numbers, and null. Reads select `*`
or comma-separated column names, with one `order=column.asc` or `.desc`, a limit
of 1–100 (default 100), and an offset of 0–1,000,000 (default 0). Choose an order
when paginating. Duplicate parameters, SQL expressions, joins, and other filter
operators are rejected. Row and function request bodies are limited to 64 KiB;
table results use the existing 2 MiB provider-response bound.

Anonymous access supports public SELECT or no access. Public-read policies expose
**every row and column** to anyone holding an authorized browser key; use them for
public data. Own-row write policies compare `ownerColumn` with a trusted session
identity. Raw function input and client filters cannot supply that identity.
Own-row writes reject `rowid` and `oid` fields (case-insensitively), even if the
table declares columns with those names, because SQLite can alias them to an
integer primary key. Generated table INSERTs and UPDATEs explicitly abort on
constraint conflicts instead of inheriting schema-level replacement behavior.

Function grants pin immutable versions, so saving a new version does not change
what an existing key runs. Owners can add a table's `select` grant with the PATCH
endpoint above. Create a replacement key to change origins, write grants, or
function pins, or to remove a grant.
Keys cannot use the owner SQL, schema, migration, provisioning, or function-source
APIs. Raw SQL stays in the owner SQL editor/API. This is a limited Supabase-style
REST surface, not full PostgREST or Supabase SDK compatibility.

## Message board user sessions

Message-board projects support `POST /bff/data/{projectId}/auth/email` with an
`apikey` browser key and `{ "email": "person@example.com", "password": "..." }`.
An existing email signs in; a new email creates an account with a password of at
least 8 characters. Emails are trimmed and lowercased; passwords remain exact
and are limited to 128 characters. The response is `{ session, token, user,
created }`, where `user` contains `id` and `email`, and `token` is a `bff_us_`
Bearer token with a fixed 30-day lifetime. Owner-issued and demo sessions below retain their one-hour
lifetime. Existing sessions keep their original expiry; the longer lifetime applies
to new email logins. Session records persist across Worker deploys. Login is
limited to 20 attempts per minute per project and client IP using `EMAIL_AUTH_LIMIT`.

`GET /bff/data/{projectId}/auth/session` checks the token and returns
`{ session, user }`. `DELETE` revokes that token and returns `{ revoked: true }`.
Both require `apikey` and `Authorization: Bearer <token>`. Cookies never
authenticate these routes. The exact key's configured origins, current owner,
and project grant are checked on every request. Signup/login requires a ready,
unpaused message-board project; revocation remains available while paused or
disabled. Login does not widen any data grants or row policies.

Apply backend migration `056_bff_email_accounts.sql` before deploying this API.
Project-scoped credentials live in the private platform `bff_email_accounts`
table as salted scrypt hashes. The project's public `users` table contains only
the generated ID, display name, and creation time. Emails and password hashes
are not exposed by public table reads. Account creation retries recover safely
from a project-database failure without replacing an existing password. A deleted
project user cannot log in again. Email verification and password reset are not
part of this initial flow.

An owner can issue a one-hour session for a row in the project's `users` table:

```js
// Trusted server or signed-in owner; never expose the account key to an app.
const { session, token: userToken } = await fetch(
  `${api}/bff/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accountKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'alice' }),
  },
).then(response => response.json());
```

The token is returned once; only its SHA-256 hash is stored. `GET .../sessions`
lists active session metadata; `DELETE .../sessions/{sessionId}` revokes a session.
There are at most 100 active sessions per project. Listing and revocation work
while paused or disabled. Deleting a project cascades its sessions. These are
owner-issued demo identities. The fixed public example separately exposes
`POST /bff/demo/session` with its configured `apikey` and `{ "userId": "alice" }`
or `{ "userId": "bob" }`. It returns the same session shape without an account
credential. `DELETE /bff/demo/session` takes that key and the session's Bearer token
to revoke it, including while paused or disabled. Neither route accepts another
project or user. Migration 055 adds `messages: update` only to the example key;
the table's existing own-row policies stay in force. Login does not modify grants
or policies. Other projects continue to require owner-issued sessions.

Create a scoped browser key granting `users: ['select']` and
`messages: ['select', 'insert', 'update', 'delete']`, with your app's exact origin.
Use the browser key and user session together:

```js
const base = `${api}/bff/data/${projectId}`;
const headers = {
  apikey: publicKey,
  authorization: `Bearer ${userToken}`,
  'content-type': 'application/json',
};
await fetch(`${base}/tables/messages`, {
  method: 'POST', headers, body: JSON.stringify({ body: 'Hello from Alice' }),
}); // user_id is filled from the authenticated session
await fetch(`${base}/tables/messages?id=eq.welcome`, {
  method: 'PATCH', headers, body: JSON.stringify({ body: 'Edited by Alice' }),
});
await fetch(`${base}/tables/messages?id=eq.welcome`, { method: 'DELETE', headers });
```

An explicit different `user_id` or ownership transfer returns 403, including
alternate column casing such as `USER_ID`. UPDATE checks both the existing row
and the proposed changes: the existing row must belong to the session user, and
any supplied ownership value must remain that user's ID. UPDATE and
DELETE append the ownership predicate to the original filters atomically; a
request targeting another user's row succeeds with no affected rows. Missing
filters are rejected. Key grants and live policies apply in addition to the user
session, including inside functions. Expired, revoked, cross-project, or deleted-user
sessions are rejected; a failed user credential never falls back to anonymous access.
Revocation blocks subsequent calls but does not cancel provider queries already in flight.

The starter publishes `list_messages`, `post_message`, `edit_message`, and
`delete_message` at version 1. Grant these versions in the browser key to invoke
them. They receive the verified identity as `ctx.user.id` and access tables through
the same policy enforcement as direct requests. `ctx.user` is null for anonymous
and owner invocations; use a user session for the three writing functions. Owner
SQL and owner database capabilities retain administrative access.

## Budgets and operations

There are at most 5 projects per owner, 100 functions per project, and 100 versions
per function. Each project has 10,000 database statements and 1,000 attempted
invocations per UTC day, plus 3 concurrent invocations. Counters and concurrency
reservations are persisted atomically in the control database; retries/failures
consume budget. Database results are bounded to 2 MiB at the provider boundary;
function database results are limited to 64 KiB. Schema inspection covers the
first 50 tables; row browsing shows at most 100 rows. SQL remains available for
other tables. Migration and execution lists show the latest 100 records.

Owners can pause projects in Settings. Operators can set `bff_projects.blocked=1`
in the control database to disable a specific project; owners cannot clear that
flag. `BFF_ENABLED=false` stops data-plane operations globally. Neither switch
undoes completed writes or preempts a database request already in flight.
Execution records contain version, status, duration, and bounded error codes;
arguments/results are not stored. Runtime console capture and automatic log
retention are deferred. Provider errors and credentials are not returned.

Account deletion cascades enqueue database cleanup before removing project
records. The API’s scheduled handler retries up to 10 deletions per run, including
databases whose creation response was lost. Cleanup waits two minutes for in-flight
provisioning and continues even when BFF is disabled. Keep the D1 token configured
until the deletion outbox is empty. Revoked credentials retain pending cleanup
records for retry; they do not silently discard resource identifiers.

Public application-user signup/login, billing, automatic abuse detection, and production qualification
of account quotas are separate release work. Treat the fixed budgets as resource
limits, not billing controls.

## API and verification

Backend registers the handlers and schemas from `worker/bff`; web builds its
BFF pages and the browser code in `src/bff`. Endpoints live under `/bff`:
`config`, `projects`, and `projects/{id}/{provision,schema,query,migrations,functions,executions,usage}`.
Functions add `/{name}` and `/{name}/invoke`. Project PATCH pauses/resumes it.
Projects also expose owner-managed `api-keys`, `api-keys/{keyId}`, `policies`, and
`policies/{table}`, plus `sessions` and `sessions/{sessionId}`. The separate
browser Data API lives under `/bff/data/{projectId}` with `tables/{table}` and
`functions/{functionName}/invoke`. Both entry points use the same project budgets,
pause/block checks, and function runtime. The generated API document describes
request and response schemas and the cookie, account-key, scoped-key, and project-user session authentication schemes.

In backend, run `npm run test:bff`, `npm run test:openapi`,
`npm run type-check`, `npm run docs:generate`, and `npm run check:api`.
In web, run `npm test`, `npm run docs:check`, and `npm run build:site`. The integration tests execute the shipped routes,
Worker Loader and RPC capability in workerd/Miniflare, with real control-plane D1
and a SQLite-backed mock of Cloudflare’s remote provisioning/query API. They
create no remote resources. Live Cloudflare provisioning and production CPU-limit
enforcement still require a configured staging smoke test before rollout.
