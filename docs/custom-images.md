# Custom image build rollout

Catalog images and custom image builds have separate availability. On October 6,
2026, production `/capabilities` advertised `images.customBuilds: false`. A
read-only Wrangler secret-name check confirmed `IMAGE_BUILD_SECRET` is configured
on the API but `IMAGE_BUILD_GITHUB_TOKEN` is absent. GitHub Actions has the shared
build secret and Cloudflare credential. No credential values were inspected.

The API enables customer build admission only when both API secrets exist.
`IMAGE_BUILD_GITHUB_TOKEN` dispatches `.github/workflows/custom-image.yml` in
`mainbrella/backend`; the callback uses the existing shared `IMAGE_BUILD_SECRET`.
An absent dispatch credential is a deployment configuration blocker, not evidence
that the image build implementation is missing.

## Operator setup and qualification

Create a dedicated GitHub credential scoped to `mainbrella/backend` with Actions
write access for workflow dispatch. Store its value through Wrangler's interactive
secret input, never in a tracked file or command argument:

```sh
npx wrangler secret put IMAGE_BUILD_GITHUB_TOKEN --config wrangler.jsonc
```

Adding this secret enables build admission immediately. Before setting it, arrange
the bounded build/start qualification and confirm the existing shared secret
matches between the API and GitHub Actions. Do not rotate the shared callback
secret solely to enable dispatch.

Verify discovery and run one bounded customer build with a dedicated account.
Confirm dispatch, build completion, owner isolation, published image digest,
runtime image-map reconciliation, create/exec from the image and exact-generation
cleanup. Image publication can redeploy the private runtime; follow
[deployment.md](deployment.md) and preserve image digests required by saved
workspaces. Record build and container budgets before running customer mutations.

If dispatch or qualification fails, remove only the new dispatch credential to
disable new build admission:

```sh
npx wrangler secret delete IMAGE_BUILD_GITHUB_TOKEN --config wrangler.jsonc
```

Reconcile pending builds and any admitted generation before retrying. Leave the
shared build secret in place for deployment-lock and callback authentication.
Do not claim production-qualified custom builds until the customer workflow has
passed and its cleanup evidence is retained.
