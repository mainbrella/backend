# Mainbrella API

The cookie-authenticated `/containers` API maps each account server-side to
``USER_CONTAINER.idFromName(`user:${user.id}`)`` in the private
`mainbrella-containers` Worker (`../reference`). Container creation and quota
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

Deploy `../reference` and its bash/tmux image first, then this API and `../web`.
Existing old-image containers need to be stopped and recreated. This path does
not need SSH tokens or any additional secrets. `/containers/ssh`, its token
migration/table, and the existing SSH gateway remain unchanged.

## Verification

```sh
npm ci
npm run type-check
npx tsx --test worker/app/*.test.ts worker/durable-objects/*.test.ts
npx tsx --test worker/app/terminal.test.ts worker/app/containers.test.ts worker/app/ssh.test.ts
```

The full suite currently includes three legacy admin/Apple-auth tests referencing
migrations absent from this checkout (`003_iop_program_tracking.sql`,
`011_native_app_auth.sql`, and related legacy migrations). Those fixtures need
their original migrations restored to run. Terminal/container/SSH tests are
independent of those files.
