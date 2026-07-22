# Kubernetes using CDK8S

This uses CDK8S in TypeScript to build K8S deployments and such.

Some apps are deployed directly from this repo, others are used as a base for something in prod.

## Getting set up

Tooling is managed by [mise](https://mise.jdx.dev/) - `mise install` gets the pinned toolchain, `mise run install` gets the bun dependencies.

**Then install the pre-commit hook:**

```bash
mise run setup-hooks
```

This writes `.git/hooks/pre-commit` (via `mise generate git-pre-commit`) so that every commit runs `mise run pre-commit`, which is the same set of gates CI runs: `fmt`, `--force build`, `lint`, `typecheck`, and `validate-alerts`. `fmt` and `build` write in place, so if either changes anything the commit is refused with a list of the files - they're already fixed in your working tree, just `git add` them and commit again. Bypass with `git commit --no-verify` when you mean to.

Because git hooks aren't tracked in the repo, this is a per-clone step. It's worth doing: commits go straight to `main`, so an unformatted file or a stale `dist/` doesn't just fail one build, it turns `main` red - and every open Renovate PR inherits that red tree and stops being able to complete itself (see [CI](#ci) below).

Editor formatting must agree with oxfmt. If your editor formats TypeScript with Prettier on save, it will silently reflow files into a style `oxfmt --check` rejects; point it at the `oxfmt` binary in `node_modules/.bin/` instead (the repo's `.oxfmtrc.json` is the marker most tools key on).

## Secrets

Secrets are all handled with [Bitnami Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets). For additional paranoia, all secrets live in the (private)
[k8s-prod](https://github.com/bjschafer/k8s-prod) repo. These are in the `secrets` folder, with a subfolder per-namespace to keep it organized. The ArgoCD app
has `.spec.source.directory.recurse=true` to make that work.

Then, secrets can just be referenced by name in CDK8S.

## Including CRDs in an app

CRDs that are part of an app should live under `apps/<app>/crds/`. To include them in the chart, use the shared `AddCRDs` helper from `lib/util.ts`:

```ts
import { join } from "path";
import { AddCRDs } from "../../lib/util";

// inside your Chart constructor
AddCRDs(this, join(__dirname, "crds"));
```

Note: We purposefully use base `cdk8s.Include` under the hood for CRDs because they are raw YAML definitions and not resources managed by `cdk8s-plus`.

## Fetching/Updating CRDs

CRD (and other vendored static manifest) sources are declared in `tools/sources.ts`, a registry of stanzas describing where each one comes from and how it's versioned. `tools/update-crds.ts` is the generic engine that reads that registry and does the fetching - there's no per-app code to write or maintain anymore.

**Adding a new source** is just one stanza in `tools/sources.ts`: a `name`, a `version` (`literal`, `app-const` if the app's chart version already lives in its `app.ts`, or `none` for sources that track a rolling upstream file), an `outputDir`, and a `fetch` strategy (`web` for direct YAML URLs, `command` for shelling out to a tool like `helm show crds` or the `velero` CLI). See the doc comment at the top of the file for the full shape.

Running it:

```bash
# a single source, writing into its real outputDir
bun run tools/update-crds.ts cert-manager
bun run tools/update-crds.ts metrics
bun run tools/update-crds.ts velero

# every enabled source at once
bun run tools/update-crds.ts --all

# override the pinned version for a one-off run
bun run tools/update-crds.ts cert-manager 1.21.0

# write elsewhere instead of touching tracked files, e.g. to sanity-check a fetch
bun run tools/update-crds.ts metrics --out-dir /tmp/crd-check
```

`mise run update-crds -- <name|--all>` works the same way.

Currently enabled sources are `cert-manager`, `metrics`, and `velero`. The rest (`cnpg`, `cnpg-barman-cloud`, `cnpg-image-catalogs`, `kured`, `sealed-secrets`, `system-upgrade-controller`) are disabled placeholders for apps still vendored out-of-band in the legacy `prod` repo - `--all` skips them, but naming one explicitly still runs it (with a warning) so it can be smoke-tested ahead of a migration.

**Renovate keeps the pinned versions current.** `renovate.json` at the repo root defines two `customManagers` that look for a `// renovate: datasource=... depName=...` annotation comment: one targets the `literal` versions in `tools/sources.ts` directly, the other targets the `const version = "..."` lines in `apps/cert-manager/app.ts` and `apps/metrics/app.ts` that the `app-const` sources derive from. Renovate itself only bumps the version string - it doesn't run the fetch - but on a Renovate PR CI does that part, refetching the CRDs and regenerating `dist/` and pushing both back onto the branch. See [CI](#ci) below.

When refreshing CRDs by hand, run `mise run build` afterwards to regenerate `dist/`, review the diff, and commit the result.

## Migrating secrets to Bitwarden Secrets Manager

`tools/migrate-secret.ts` helps move a live Secret (originally sourced from a SealedSecret in the legacy `k8s-prod` repo) into Bitwarden Secrets Manager, and emits a ready-to-paste `BitwardenSecret` construct snippet for the External Secrets Operator pattern used going forward.

```bash
# dry run (default): reads the live Secret via kubectl, prints what WOULD be
# created (key names + masked values only), makes no calls to Bitwarden
bun run tools/migrate-secret.ts <namespace> <secret-name>

# actually create the bws secrets and emit the real snippet - requires
# BWS_ACCESS_TOKEN and the `bws` CLI (brew install bitwarden/tap/bws)
bun run tools/migrate-secret.ts <namespace> <secret-name> --execute

# scan the legacy prod repo for SealedSecrets still left to migrate
bun run tools/migrate-secret.ts --inventory
```

`--inventory` reads `spec.encryptedData` key _names_ directly off disk (SealedSecrets can't be decrypted offline, but the key names aren't encrypted, only the values); it defaults to `~/development/k8s/prod`, override with `PROD_REPO_PATH`.

## CI

`.github/workflows/ci.yaml` runs on every push to `main` and every PR: installs the mise-pinned toolchain, runs `mise run --force build` to regenerate `dist/` from scratch, then fails the build if that produces any diff - i.e. committed `dist/` output must always match what the TypeScript source actually generates. It then runs `mise run typecheck`, `mise run lint`, an `oxfmt --check` formatting pass, and `mise run validate-alerts`.

On a Renovate PR the job does more: it refetches the upstream CRDs first (since a version bump changes them too), skips the `dist/` drift check (drift is the expected outcome there), and as its final step commits the regenerated CRDs and `dist/` back onto the Renovate branch. That's what makes those PRs self-completing - the pushed commit re-triggers CI, goes green, and Renovate automerges it.

The catch worth knowing: that sync is the **last** step, so any earlier failure means it never runs and the PR sits there with a bumped version and no regenerated output. Merging it anyway lands manifests that don't match the source. Crucially, a Renovate branch inherits `main`'s tree and can't fix a breakage it didn't cause - so a red `main` breaks every open Renovate PR this way. CI annotates that case explicitly, but the real defense is keeping `main` green, which is what the pre-commit hook above is for.
