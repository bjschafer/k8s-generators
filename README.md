# Kubernetes using CDK8S

This uses CDK8S in TypeScript to build K8S deployments and such.

Some apps are deployed directly from this repo, others are used as a base for something in prod.

**IMPORTANT**: Before committing any changes, run `make` to lint and build YAML. Or else
you're gonna have a bad time.

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

Use the helper script `tools/download-crds.ts` to fetch CRDs for supported apps. It writes CRD YAML files into the appropriate `apps/<app>/crds/` folder (unless noted otherwise).

Examples:

```bash
# cert-manager: specify version (without leading v)
bun run tools/download-crds.ts cert-manager 1.15.3

# VictoriaMetrics stack CRDs (uses Helm under the hood)
bun run tools/download-crds.ts metrics

# Velero CRDs (requires the velero CLI; script enforces a specific client version)
bun run tools/download-crds.ts velero

# CloudNativePG CRDs (writes to /tmp/cnpg currently; move files into apps/postgres/crds as needed)
bun run tools/download-crds.ts cnpg 1.23.1
```

Prerequisites:

- metrics: requires `helm` available in PATH.
- velero: requires `velero` CLI in PATH; the script compares the installed client version.
- cert-manager and cnpg: fetched from upstream URLs; no extra tools required.

After fetching CRDs, commit the updated files and run `make` to regenerate manifests.
