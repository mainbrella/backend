# P2 runtime status

Source and provider audit on October 11, 2026. P1 still has infrastructure and
live qualification gates; beginning an independent P2 source feature does not
close those gates. No deployment, secret change, remote migration, registry
publication or paid sandbox start is part of this work.

| Capability | Current result | Remaining implementation or evidence |
| --- | --- | --- |
| Linux desktop automation | SDK helpers for supervised Xvfb sessions, mouse/keyboard input, process launch and bounded PNG screenshots; real local Linux checks | Production desktop image, Cloudflare qualification, VNC/browser streaming and recording |
| Native filesystem watching | Bounded Linux inotify notifications through SDK-managed executions; real Linux short-lived-file, rename and cleanup checks | Guest Node requirement, production qualification, SDK publication; durable event journal and transfer resumption remain absent |
| Git-aware SDK operations | Typed status, local branches, diff, staged commit and branch checkout using bounded argv executions; real repository tests | Installed artifact and production qualification, publication; LSP remains a separate gap |
| Teams, RBAC and enterprise identity | Individual account ownership remains authoritative | Organization/account identity migration, membership and roles on every resource, invitations, service credentials, billing ownership, audit trails, OIDC/SAML and identity-provider qualification |
| Customer region selection | Provider supports application-level geographic constraints; Mainbrella has no customer routing contract | Constrained runtime deployments/bindings, persisted region selection, same-region restore/fork routing, image rollout and placement qualification |
| BYOC | No external runtime provisioning or trust boundary | Customer-cloud credentials, isolated deployment/account lifecycle, runtime adapter, billing and support model |
| GPU and alternative OS | Current runtime and all managed images are Linux CPU environments | Qualified provider/runtime with the required hardware/OS, new image and execution contracts, billing and lifecycle qualification |

## What the existing runtime can support

The desktop helper is a source feature that uses existing authorization and
supervision; [desktop.md](desktop.md) defines its contract and limits. It does
not require a new execution backend. An application must still launch a window
manager and its GUI program when needed.

Cloudflare's current [placement documentation](https://developers.cloudflare.com/containers/concepts/placement/)
supports `regions` and `jurisdiction` constraints on container applications.
The installed Wrangler schema includes those fields. Those settings apply to
the application; the current Mainbrella runtime has one `USER_CONTAINER` binding
and does not select a regional application per customer request. Durable Object
location hints alone are not a contractual container placement restriction.
Customer region selection therefore needs real constrained deployments and
routing, with account/generation isolation preserved across all lifecycle paths.
Container placement alone also does not establish data residency for D1, R2,
logs, snapshots or third-party services.

Teams cannot be implemented safely as an invitations table alone. The current
authentication helper returns an individual `AuthUser`; container account
Durable Objects are addressed by `account:${user.id}`, and image/workspace/project
authorization and billing use that user's identity. A membership layer needs a
separate authorized account principal while preserving the actor for auditing.
Every resource handler, runtime authorization, entitlement calculation and
deletion workflow must use the same principal. SSO then needs provider discovery,
verified callbacks, provisioning/revocation and account recovery behavior.

The [provider instance catalog](https://developers.cloudflare.com/containers/platform/limits/)
currently exposes CPU, RAM and disk sizes rather than a GPU allocation field.
Mainbrella's execution/image tooling assumes Linux and GNU process tools. A
future GPU or Windows provider cannot be represented by changing those labels;
it needs an actual runtime adapter and independent qualification.

## P1 constraints that remain separate

The [provider snapshot contract](https://developers.cloudflare.com/containers/guides/snapshots/)
saves the filesystem and excludes RAM and running processes. Handles are tied
to their source image version. Memory-preserving pause/resume requires a
supported checkpoint primitive or another runtime.

The [provider R2 FUSE example](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)
exposes object storage as a filesystem, without full POSIX or local-disk behavior.
It passes bucket credentials into the guest, waits for mount readiness and
requires clean unmount after writes. Mainbrella needs owned volume attachments,
writer fencing, runtime-managed mount supervision, storage accounting and
failure qualification before it can expose a managed durable volume contract.
Ordinary managed command deadlines kill process groups; that is insufficient
as a writable mount's flush guarantee.

The [observability runbook](workload-observability.md) retains deployed metrics,
webhook and credential gates. [Custom image qualification](custom-images.md)
still requires a bounded build, publication, deployed create/exec and exact
generation cleanup. Local test success is not evidence for those live steps.
