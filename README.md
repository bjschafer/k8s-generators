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

Secrets live in OpenBao and are synced into the cluster by External Secrets, through the `openbao` ClusterSecretStore. This repo is public, so it only ever holds *references* to secrets, never values.

By convention each Secret has its own KV v2 entry at `kv/kubernetes/<namespace>/<name>`, whose fields are the Secret's keys. Values needed in more than one namespace live once under `kv/kubernetes/_all/`. OAuth2 client credentials are published by the tf-authentik repo to `kv/kubernetes/<namespace>/authentik`, so they never get copied by hand.

`lib/secrets.ts` has the two constructs to use:

- `OpenBaoSecret` for anything whose value has to be *known*: an upstream API key, a password something outside the cluster also uses.
- `GeneratedSecret` for values that only need to be *stable*, such as signing or encryption keys. ESO mints these itself and they never go into bao.

Both expose `toEnvValues()` and `secret`, so they can be referenced like any cdk8s-plus Secret.

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

Every source is enabled except `cnpg-image-catalogs`. Its catalogs track upstream `main` and the production database resolves its image through them, so it only refreshes when asked (`mise run update-crds cnpg-image-catalogs`, in its own commit) rather than as a side effect of an unrelated Renovate PR. `--all` skips it; naming it explicitly still runs it, with a warning.

**Renovate keeps the pinned versions current.** `renovate.json` at the repo root defines two `customManagers` that look for a `// renovate: datasource=... depName=...` annotation comment: one targets the `literal` versions in `tools/sources.ts` directly, the other targets the `const version = "..."` lines in `apps/cert-manager/app.ts` and `apps/metrics/app.ts` that the `app-const` sources derive from. Renovate itself only bumps the version string - it doesn't run the fetch - but on a Renovate PR CI does that part, refetching the CRDs and regenerating `dist/` and pushing both back onto the branch. See [CI](#ci) below.

When refreshing CRDs by hand, run `mise run build` afterwards to regenerate `dist/`, review the diff, and commit the result.

## CI

`.github/workflows/ci.yaml` runs on every push to `main` and every PR: installs the mise-pinned toolchain, runs `mise run --force build` to regenerate `dist/` from scratch, then fails the build if that produces any diff - i.e. committed `dist/` output must always match what the TypeScript source actually generates. It then runs `mise run typecheck`, `mise run lint`, an `oxfmt --check` formatting pass, and `mise run validate-alerts`.

On a Renovate PR the job does more: it refetches the upstream CRDs first (since a version bump changes them too), skips the `dist/` drift check (drift is the expected outcome there), and as its final step commits the regenerated CRDs and `dist/` back onto the Renovate branch. That's what makes those PRs self-completing - the pushed commit re-triggers CI, goes green, and Renovate automerges it.

The catch worth knowing: that sync is the **last** step, so any earlier failure means it never runs and the PR sits there with a bumped version and no regenerated output. Merging it anyway lands manifests that don't match the source. Crucially, a Renovate branch inherits `main`'s tree and can't fix a breakage it didn't cause - so a red `main` breaks every open Renovate PR this way. CI annotates that case explicitly, but the real defense is keeping `main` green, which is what the pre-commit hook above is for.
