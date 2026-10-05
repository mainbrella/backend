# Mainbrella API

The session-authenticated `/containers` API maps each account server-side to
``USER_CONTAINER.idFromName(`user:${user.id}`)`` in the private
`mainbrella-containers` Worker (`containers/`). Container creation and quota
reservation remain exclusively in `POST /containers`.

## Browser terminal

`GET /containers/terminal?createdAt=<ISO generation>&cols=80&rows=24` requires
`Upgrade: websocket`, an explicit allowlisted browser Origin, and the existing
`mainbrella_session` cookie. `createdAt` is required and must exactly match the
current running container. Dimensions default to 80×24, must be integer strings,
and clamp to 1–500 columns / 1–200 rows. Unknown or duplicate parameters are
rejected. Client headers cannot override the account, image, resources, session
name, generation, or deadline.

The API first reads `GET https://internal/container` for the authenticated owner,
then forwards only Upgrade and trusted generation/expiration/dimension headers
to `GET https://internal/terminal`. Cookie and Authorization are not forwarded.
The DO rechecks the generation and persisted lease before `exec()` to reject
stop/recreate races. A stopped, stale, or expired container returns 409; terminal
capacity returns 429; service failures are sanitized as 503. No terminal request
calls `start()`, writes quota, or resets the hard expiration.

The private DO runs a PTY attached to the fixed tmux session `main`. The browser
uses binary UTF-8 stdin, raw binary stdout, JSON `{cols, rows}` resizing and
`{type:"ack"}` output acknowledgements. The DO sends `ready`, `exit` and sanitized
`error` control messages. Non-hibernating sockets retain the live process handle.
Disconnect terminates only the attached tmux client. The existing idle/hard
expiration alarm still destroys the container and closes terminal sockets.

Run `npm run deploy` here to deploy the container Worker and its bash/tmux image
first, then the API. Deploy `../web` afterward. The image is built in GitHub
Actions; local deployments require GitHub CLI authentication, not Docker.
Existing old-image containers need to be stopped and recreated. This path does
not need SSH tokens or any additional secrets. `/containers/ssh`, its token
migration/table, and the existing SSH gateway remain unchanged.

## Verification

```sh
npm ci
npm run type-check
npm run check:containers
npm run test:containers
npx tsx --test worker/app/*.test.ts worker/durable-objects/*.test.ts
npx tsx --test worker/app/terminal.test.ts worker/app/containers.test.ts worker/app/ssh.test.ts
```

The full suite currently includes three legacy admin/Apple-auth tests referencing
migrations absent from this checkout (`003_iop_program_tracking.sql`,
`011_native_app_auth.sql`, and related legacy migrations). Those fixtures need
their original migrations restored to run. Terminal/container/SSH tests are
independent of those files.

## Production deployment

All production backend code lives here. `containers/` contains the private
container Worker, lifecycle controller, terminal bridge, Dockerfile, and tests.
`wrangler.containers.jsonc` deploys `mainbrella-containers`; `wrangler.jsonc`
deploys `mainbrella-api`. The API's cross-Worker binding, `UserContainer` class,
account, and storage identity are unchanged by this move. `../reference` is
benchmark and historical material only; production builds do not read it.

```sh
npm run deploy             # Containers and image first, then API; stops on failure
npm run deploy:containers  # Container Worker with the CI-published image
npm run deploy:api         # API only
```

Container limits remain one running container per account, ten reserved starts
per UTC month, a one-hour hard deadline, and a ten-minute idle timeout. The
container image includes Node 24, bash, and tmux, with outbound internet enabled.
Deploying an image does not replace running containers; stop and recreate old
containers to use the updated image.

Developer SSH keys are configured in `wrangler.containers.jsonc`. Connect with
`npx wrangler containers ssh <INSTANCE_ID> --config wrangler.containers.jsonc`.
Private keys stay local. Status polling and SSH attachment do not renew the idle
lease; terminal input/output does.

## Terminal image publishing

The **Build terminal image** GitHub Actions workflow builds a Linux amd64 image,
checks Node/bash/tmux, and pushes it to the Cloudflare managed registry. It runs
on main when the Dockerfile, workflow, or dependency lockfile changes, and can
also be run manually. CI publishes `terminal-image.json` on the `terminal-image`
GitHub release, containing the immutable registry digest and Dockerfile hash.
It does not deploy production Workers.

One-time setup:

1. Create a Cloudflare custom API token with **Account → Containers → Edit**,
   limited to account `2b7a9be82bb64187230703b024e25157`. No zone permissions are
   required for this image-only workflow. Leave IP filtering unset for GitHub
   runners. Add it as the repository Actions secret `CLOUDFLARE_API_TOKEN`.
2. Push the workflow and Dockerfile to main, then run **Build terminal image**
   under the repository Actions tab if it has not already run.
3. Install GitHub CLI and authenticate with `gh auth login` for this private
   repository. Keep your existing Wrangler login for production deployment.
4. Run `npm run deploy` locally after the image workflow succeeds.

The deploy script downloads the terminal release manifest and live custom-image
manifest, verifies the registry account,
repository, digest, and Dockerfile hash, and supplies Wrangler a temporary config
with digest-pinned entries for `terminal` and all ready/publishing custom images.
Set `IMAGE_BUILD_SECRET` in the local deployment environment; a missing secret or
unavailable custom manifest stops deployment rather than removing user images. The tracked config remains
the build blueprint. Use the npm deploy commands rather than invoking
`wrangler deploy --config wrangler.containers.jsonc` directly, which would still
attempt a local Docker build. `npm run deploy:containers -- --dry-run` exercises
the same image selection without publishing the Worker.

If the local Dockerfile differs from the published one, deployment stops before
uploading. Push that Dockerfile to main and wait for CI to publish its image.
Registry references and hashes are public metadata; API tokens stay in Actions
secrets and are never put in the deployment manifest. The GitHub release and
repository must remain accessible to the authenticated deployment user.

## API automation and Builder enforcement

See [API.md](API.md) for authentication, endpoints, curl examples, limits, and
retry behavior, and [SKILL.md](SKILL.md) for the reusable automation skill. Both
files are mirrored in `../web`; update both copies when the API changes.

Lifecycle and SSH issuance accept `Authorization: Bearer <login-session-value>`
without Origin, using the existing hashed, expiring, revocable session record.
Cookie mutations still require a trusted Origin. Browser terminal authentication
and gateway credentials are unchanged. No migration or new secret is required.

`BUILDER_LIMITS` in `containers/user-container-core.js` is the effective policy
for every account until database-backed plan resolution is implemented. Status
includes `plan: "builder"`. The serialized controller returns 409
`container_limit_exceeded` for attempts to launch a second running container,
without spending quota; monthly exhaustion remains 429
`container_quota_exceeded`. Ownership and resources come exclusively from the
backend, and UI/API launches share the same slot and reservations. Deploy the
container Worker before the API to activate the new lifecycle behavior.

To install the skill in Codex, copy `SKILL.md` and `API.md` into
`~/.codex/skills/mainbrella-containers/` (or the equivalent skills directory for
your agent), then invoke `$mainbrella-containers`. Provision the session credential
separately using the instructions in `API.md`.

## Custom image build and deployment

The **Build custom image** workflow must be on `main` before enabling builds.
Set `IMAGE_BUILD_SECRET` (at least 32 characters) in both the API Worker and
GitHub Actions, and set `IMAGE_BUILD_GITHUB_TOKEN` in the API Worker to a token
with Actions write access to this repository. `CLOUDFLARE_API_TOKEN` in Actions
must permit both registry access and deployment of the container Worker.

For the first rollout of the live manifest/deployment lease, apply remote D1
migrations (including `007_image_deployment_lock.sql`) and deploy the API first:
`npm run db:migrate:remote`, then `npm run deploy:api`. Merge the custom-image
workflow to `main` and configure its secrets before accepting builds. Subsequent
releases can use the normal `npm run deploy` command with `IMAGE_BUILD_SECRET` set.

Preparation downloads the recipe and pinned base image on a trusted runner.
The user Dockerfile builds and runs its compatibility check on a separate,
disposable runner with no registry, deployment, or API callback secrets.
Publication loads the resulting archive without executing it, pushes it, reports
`publishing` with its immutable digest, deploys the assembled image map, then
reports `ready`. The terminal release and live API manifest feed the same deploy
script; the old `custom-images.json` release snapshot is no longer consumed.

All production image-map deployments acquire an API lease. The lease lasts 12
minutes; the Wrangler subprocess is bounded to 10 minutes, and deployments wait
up to 8 minutes for a competing lease. This serializes local deployments, builds,
and deletion reconciliation. Deleted images disappear from the live manifest
and trigger the workflow's `reconcile` operation. An hourly reconciliation retries
failed removals; deleting an image does not stop an already-running container.
If Actions is unavailable, attached image slots can remain until reconciliation
succeeds. Dry runs validate the live manifest without acquiring a deployment lease.

Explicit GitHub dispatch rejections (400/401/403/404/422) refund the monthly build
reservation atomically. Ambiguous network/server failures keep the reservation.
`npm run test:images` and CI exercise the SQL state machine through generated image selection and the
container controller, deployment failure handling, quota refunds, and workflow
syntax. It uses simulated GitHub/Cloudflare boundaries; a production build and
launch still need a smoke test after rollout. The broader `npm test` currently
also includes legacy admin/Apple tests referencing removed Groupicorn migrations;
those unrelated fixtures need separate repair.
