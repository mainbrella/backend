# Custom image build rollout

Catalog images and custom image builds have separate availability. On October 6,
2026, production `/capabilities` advertised `images.customBuilds: false`. A
read-only Wrangler secret-name check confirmed `IMAGE_BUILD_SECRET` is configured
on the API but `IMAGE_BUILD_GITHUB_TOKEN` is absent. GitHub Actions has the shared
build secret and Cloudflare credential. No credential values were inspected.

The new source requires both API secrets and `IMAGE_BUILD_GITHUB_REPOSITORY`, an
operator-controlled **private** repository containing the reviewed backend
workflow and scripts. Before every build admission, the API checks GitHub's
repository metadata and requires `private: true`; redirects and metadata failures
fail closed. There is no public-repository fallback. The workflow also rejects
customer builds dispatched in a public repository. The callback uses the existing
shared `IMAGE_BUILD_SECRET`.

This boundary matters even for ordinary builds: Actions artifacts contain source
and image layers. In a public repository, signed-in GitHub users can download
workflow artifacts. The private build repository's readers can still access its
artifacts; restrict membership, forbid public visibility changes, and retain the
one-day artifact expiry. Registry passwords never appear in those artifacts.
[GitHub artifact access](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/downloading-workflow-artifacts).

## Operator setup and qualification

Before building or reconciling images, verify the Actions credential can read the
existing container service. The custom-image workflow runs `npm run images:preflight`
before preparation and reconciliation. Its `operation=preflight` option runs only
that read-only check: it does not claim build inputs, acquire the image deployment
lease, query the mutable image manifest, publish an image, or deploy a Worker.

An October 11 scheduled reconciliation at backend revision `1420b8f` failed on
`GET /accounts/…/workers/services/mainbrella-containers` with “No access to the
specified service.” Local Wrangler authentication can read the existing service
in the configured account, but that session does not validate the separate
`CLOUDFLARE_API_TOKEN` stored in GitHub Actions. Check that token's account, expiry,
IP restrictions and scope. Updating this existing Worker requires Workers
**Editor** access scoped to `mainbrella-containers`; image registry/container
operations have their own permissions. Do not recreate the Worker or replace
its Durable Object bindings to work around an access error.
[Cloudflare Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/).

After installing the reviewed workflow, run its read-only check with the actual
Actions secret before retrying reconciliation:

```sh
gh workflow run custom-image.yml --repo <build-owner>/<private-build-repository> \
  --ref main -f operation=preflight
```

A successful check proves service metadata access only. It does not prove write
permissions, registry publication, a compatible runtime image, or a qualified
customer build. A local `--dry-run` also does not establish those permissions.

Create a dedicated private build repository and mirror the reviewed backend
revision, including `.github/workflows/custom-image.yml`, the scripts and lockfile.
Protect its `main` branch and restrict write access to trusted operators. Configure
the shared callback secret and Cloudflare publication credential in that private
repository. Its workflow reads the public backend's pinned terminal manifest;
it never needs to publish customer artifacts back to the public repository.

Set `IMAGE_BUILD_GITHUB_REPOSITORY` to its `owner/repo` name in the API's deployment
configuration. Create a dedicated credential scoped to that private repository
with metadata read and Actions write access for workflow dispatch. Store its value
through Wrangler's interactive secret input, never in a tracked file or command
argument:

```sh
npx wrangler secret put IMAGE_BUILD_GITHUB_TOKEN --config wrangler.jsonc
```

Adding the final required setting enables build admission immediately. Before setting it, arrange
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

## Cross-build layer caching and private base images (unreleased)

Apply `040_image_build_inputs.sql` before deploying these handlers. `cacheFrom`
is an optional image UUID in the multipart build request. Admission resolves only
an owned, ready image and pins its digest. The trusted preparation job pulls that
image and transfers it to the isolated build job. A bounded converter materializes
its config/layers as a local OCI layout, without extracting archive paths. Builds
export inline BuildKit metadata and import that layout with `type=local`;
credentials and registry access are unnecessary for cache consumption. This is explicit,
owner-scoped layer reuse; it does not reserve a global shared cache or guarantee
a hit. Existing images without inline metadata remain valid inputs but may yield
no reuse. Selecting a cache captures its reference at admission; deleting the
source image afterwards does not revoke an already queued build's input.
[Docker inline cache](https://docs.docker.com/build/cache/backends/inline/).

`baseImage` is an optional JSON-encoded multipart field:

```json
{
  "image": "ghcr.io/your-account/development@sha256:<64-lowercase-hex-digits>",
  "username": "pull-only-account",
  "password": "pull-only-token"
}
```

Only `ghcr.io` and `docker.io` references with a namespace/repository and immutable
SHA-256 digest are supported. Credentials are optional as a pair for public
images. Tags, arbitrary registry hosts, private network addresses, custom ports,
registry configuration changes and reusable customer registry credentials are
unsupported. A Docker Hub reference must explicitly include `docker.io` and its
namespace (`library` for official images).

The operator must separately configure `IMAGE_REGISTRY_ENCRYPTION_KEY` as 32
random bytes encoded with 64 hexadecimal characters. Store it with interactive
`wrangler secret put`; never derive it from the callback secret. `GET /images`
advertises `privateRegistriesEnabled` only when the private repository build
configuration and encryption key are present; admission still checks GitHub's
current visibility. Configured availability does not constitute live qualification.

Credentials use AES-GCM with account/build-associated data. The source claim
atomically clears the encrypted record before returning it to the trusted
preparation job. A lost claim response or preparation crash requires a new build;
the old claim cannot replay the credential. Expiry, dispatch failure and deletion
also clear it. Rotating the encryption key while builds are queued makes their
old encrypted credentials unusable. Returned customer image metadata contains
only the base reference, never credentials.

The preparation job performs `docker login --password-stdin`, pulls the image,
checks Linux/amd64 and the 512 MiB size ceiling, and saves it without running its
code. Temporary Docker credentials are removed even on failure. Only explicitly
selected Dockerfile/context fields enter `prepared/source.json`. The build job
has no API, registry or publishing credentials. Its Dockerfile still starts with
`FROM mainbrella:base`; the selected image supplies that local alias. The final
image must run as root and provide `/bin/sh`, `/bin/bash`, sleep, setsid, GNU
timeout/stat/find/sed/tar/base64, gzip, tmux and a writable `/workspace`. The isolated
compatibility check runs with networking disabled. Windows, ARM and incompatible
minimal base images are rejected. These checks do not qualify every runtime
feature: Python execution still requires a Python-equipped image, for example.

## Bounded deployed verifier

After the private workflow, migrations and API/runtime revisions are deployed,
the following verifier can exercise two builds, cache reuse, one sandbox launch,
execution from the built image, and exact-generation cleanup:

```sh
node scripts/qualify-image-build.mjs \
  --output=/secure/new-image-evidence \
  --max-builds=2 --max-starts=1 \
  --api-revision=<deployed-sha> --runtime-revision=<deployed-sha>
```

Provide `MAINBRELLA_API_KEY` through the environment. An optional
`MAINBRELLA_QUALIFY_IMAGE_BASE` environment value supplies the same JSON base
object for a private-image run; never put credentials in shell arguments or
evidence. The verifier checks account capacity before mutation and writes
recovery names/IDs/creation keys before requests. It never retries an ambiguous
image-create POST. If the exact container generation cannot be confirmed gone,
it preserves the images and reports `reconcile_manually`. Active or ambiguous
builds also remain recorded for operator reconciliation. Successful image-delete
responses confirm API tombstones; separately confirm workflow reconciliation of
the deployed image map. Reports never contain raw logs or credentials. The
reported first-command latency is one observation, not a percentile benchmark.

The verifier has local tests but has not been run against production as part of
this change. A Linux Docker test exports inline cache, converts its saved image,
and proves a cache hit in a new isolated BuildKit builder; run it with
`MAINBRELLA_TEST_IMAGE_CACHE_DOCKER=1 node --test scripts/prepare-image-cache.test.mjs`.
Live private-pull isolation, cache hits across hosted runners,
publication/redeployment and artifact access qualification remain release gates.

## Image versions and account tags (unreleased)

Each successful build has an immutable image ID and digest. The source checkout
adds `digest` to image metadata and account-scoped aliases through
`GET /images/tags` and `GET`, `PUT`, `DELETE /images/tags/{tag}`. Apply
`039_image_tags.sql` before deploying these routes. This does not enable builds.

`PUT` takes `{ "imageId": "<ready-image-uuid>" }`. Tags contain 1–64 lowercase
letters, digits, dots, underscores or hyphens and start with a letter or digit.
An account may hold 30 tags. The write atomically checks image readiness and
ownership; moving an existing tag remains possible at the limit. Deleting an
image removes its aliases. Another account cannot resolve, move or remove your
aliases. `DELETE` is idempotent within the requesting account.

Resolve a tag, then pass its returned image ID to normal container creation.
Resolve once and retain that ID with the creation key when retrying: a later tag
move must not alter an in-flight creation's image selection. Existing containers
continue using their selected digest. The bounded build recipe, private build
repository and production qualification requirements above still apply.
