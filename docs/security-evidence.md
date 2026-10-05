# Security evidence for product documentation

This document identifies implemented controls that can support frontend copy. It is not a certification, penetration-test report, or statement about controls outside this repository.

| Implemented control | Evidence |
| --- | --- |
| API keys are hashed before storage; authenticated requests resolve their owner. | `worker/app/api-keys.ts`, `worker/app/auth-core.ts` |
| Cookie authentication checks allowed origins; an explicit invalid bearer credential fails closed. | `worker/app/auth-core.ts` and authentication tests |
| Container access is tied to the authenticated account and a specific creation generation. | `worker/app/containers.ts`, command/file/execution handlers and their tests |
| The API resolves the owner's private runtime and supplies trusted generation and lease information. | `worker/app/commands.ts`, `worker/app/files.ts`, `worker/app/executions.ts`, `containers/user-container.js` |
| Server-side entitlements control starts, concurrent machines and lease limits. | `worker/app/entitlements.ts`, `containers/user-container-core.js` |
| Commands and binary file operations have bounded time, output and concurrency. | `containers/commands.js`, `containers/files.js`, their contracts and tests |
| Managed execution admission requires an idempotency key and retains a command fingerprint rather than command text. | `containers/executions.js` |
| Managed output/result access requires the owning account and matching generation. | `worker/app/executions.ts` |
| Operational-status writes use a separate monitoring credential. | `worker/app/status.ts` |
| Custom image builds run separately from customer container execution. | `worker/app/images.ts`, `scripts/publish-image-build.mjs`, image-build workflow |

Cloudflare documents its container runtime as Linux VMs. That describes the provider's isolation boundary; it does not establish Mainbrella compliance or replace an independent security assessment. See the [provider runtime API](https://developers.cloudflare.com/containers/api/durable-object-container/).

Runtime configuration includes a developer SSH public key. Do not claim operators are technically unable to access customer machines. Containers currently allow outbound internet access, and the product does not expose customer-configurable egress policy, region selection, secret mediation, team RBAC or audit exports.

The running filesystem is ephemeral. Managed command output is stored temporarily in Durable Object storage and can contain customer secrets. It must not be copied into public status messages, benchmark reports or application logs. Execution records expire after one hour; cleanup runs through lifecycle and alarm maintenance. This is not a guarantee of immediate deletion from provider backups or logs.

Claims about encryption configuration, data geography, subprocessors, incident response, backups, security-contact monitoring, DPAs, SLAs, penetration tests or SOC 2 require separate operational or legal evidence. Confirm those facts before publishing them. Do not infer them from these API controls.
