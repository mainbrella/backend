# Restore launch Docker smoke

Run this local smoke against an image that is already present in Docker:

```sh
node experiments/restore-launch-smoke.mjs --image cloudflare-dev/usercontainer-terminal-d00e7ed8857c:013677f4
```

The script inspects the supplied image before creating containers, so it does
not pull an image implicitly. It needs Docker access and no secrets. It creates
one source container, four restored clones, and one temporary snapshot image;
all are tagged and removed by exact-label cleanup. A unique directory under the
system temporary directory retains the generated report.

This exercises a real Docker image snapshot, filesystem, PID-1 launch recipe,
HTTP readiness, and exec output. It uses a local Docker adapter and does not
qualify behavior in the Cloudflare runtime.
