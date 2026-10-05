---
name: mainbrella-containers
description: Start, inspect, use through SSH, and stop Mainbrella small containers through the authenticated API for scripted jobs and automation.
---

# Mainbrella container automation

Read [API.md](API.md) for authentication setup, curl examples, response fields,
and error handling. Use `https://api.mainbrella.com` unless the user specifies a
different environment. Use the user's provisioned login session as a Bearer
credential through a secret store or protected header file. If it is missing or
expired, ask the user to provision it using the documented login flow. Never
include credentials or token-bearing SSH commands in logs or your response.

1. GET `/containers` to inspect the running container and remaining allowance.
   Read the effective `plan`, `limits`, and `usage` from the API. All accounts
   currently resolve to Builder: one running lite container, ten starts per UTC
   month, one-hour hard lifetime, ten-minute idle timeout.
2. Reuse the running container for the authorized task. If none is running and
   starts remain, POST `/containers` with no body. The backend selects ownership
   and resources. Do not supply plan, size, image, owner, or lifetime overrides.
3. For command execution, POST `/containers/ssh` and use its returned SSH command
   privately with local `ssh` and `cloudflared`. Access lasts at most 15 minutes,
   is tied to the container generation, and does not extend the hard lifetime.
   No HTTP exec endpoint exists. Export needed results before stopping because
   storage is ephemeral.
4. DELETE `/containers` when the task calls for cleanup of the container you
   launched. If you reused an existing container, preserve it unless the user
   authorized stopping it. Report the task result and current container state.

A second launch returns 409 `container_limit_exceeded` without spending another
start. Read status and reuse; do not stop an existing container merely to retry
creation. Monthly exhaustion returns 429 `container_quota_exceeded`: stop launch
attempts until the next UTC month. SSH token exhaustion also returns 429; reuse
existing access or wait for token expiry. Never evade limits with new sessions
or accounts.

After a launch timeout or 503, reconcile with GET before considering another
POST. Failed starts still consume quota, so avoid automatic launch retry loops.
A 401 requires credential renewal. Browser cookies still require trusted Origins
for mutations; Bearer lifecycle and SSH requests can omit Origin. Browser terminal
WebSockets remain cookie-only. Status polling does not renew the idle lease.
