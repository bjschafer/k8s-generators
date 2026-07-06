/**
 * Declarative registry of upstream CRD / static-manifest sources fetched by
 * `tools/update-crds.ts`.
 *
 * To add a new source: add one stanza to `sources` below. No code changes
 * required unless you need a genuinely new fetch mechanism (see
 * `FetchStrategy`).
 *
 * Versioning: each source's version is either:
 *   - `{ kind: "literal", value: "..." }` - the version lives here, annotated
 *     with a `// renovate: datasource=... depName=...` comment directly
 *     above the `value` so Renovate's customManagers regex can bump it in
 *     place. See the ready-to-paste renovate.json snippet in the PR/report
 *     that introduced this file.
 *   - `{ kind: "app-const", appName, constName }` - derived at runtime from
 *     an existing `const version = "..."` (or similarly named) declaration
 *     in `apps/<appName>/app.ts`. Use this when the app already tracks its
 *     own version there (e.g. as a Helm chart version) to avoid having two
 *     places that can drift out of sync. NOTE: Renovate won't see this
 *     value here - it needs its own customManager rule targeting the
 *     app.ts file directly if you want automation for it.
 *   - `{ kind: "none" }` - source has no meaningful version (tracks an
 *     upstream branch/rolling file).
 */

export type VersionSource =
  | { kind: "literal"; value: string }
  | { kind: "app-const"; appName: string; constName: string }
  | { kind: "none" };

export type FetchStrategy =
  /**
   * Fetch one or more remote YAML documents directly (optionally templated
   * with the resolved version) via `cdk8s`'s `Yaml.load`, which handles
   * both local paths and http(s) URLs and multi-document files.
   */
  | { kind: "web"; urls: (version?: string) => string[] }
  /**
   * Shell out to a locally-installed tool to render manifests (e.g. `helm
   * show crds ...` or the `velero` CLI's `install --dry-run`).
   * `versionCheck`, if set, is used to assert the installed tool's version
   * matches the version pinned in this registry *before* fetching -
   * this is how the old `VeleroUpdater.WithVersion` behaved, generalized.
   */
  | {
      kind: "command";
      command: string;
      args: (version?: string) => string[];
      versionCheck?: {
        command: string;
        args: string[];
        /** Pull the version string out of the command's stdout. */
        extract: (stdout: string) => string;
        /** Transform the registry version into the format the tool reports (e.g. prefixing "v"). Defaults to identity. */
        expected?: (version: string) => string;
      };
    };

export interface CrdSource {
  /** Unique key; also the CLI argument, e.g. `bun run tools/update-crds.ts cert-manager`. */
  name: string;
  description: string;
  version: VersionSource;
  /** Output directory, relative to the repo root. */
  outputDir: string;
  fetch: FetchStrategy;
  /**
   * Keep only `CustomResourceDefinition` documents and name files after
   * `metadata.name` (matches the old WebUpdater/CommandUpdater behavior).
   * Default: true. Set to `false` for sources that vendor a *whole*
   * operator's manifests (RBAC, Deployment, webhooks, etc.), not just CRDs.
   */
  crdOnly?: boolean;
  /**
   * When `crdOnly` is false, multiple kinds can share a `metadata.name`
   * (e.g. a Role and RoleBinding of the same name), so prefix the filename
   * with the Kind: `<Kind>.<name>.yaml`. Mirrors the `kubectl-slice`
   * template used by the legacy `prod/cnpg/upgrade.sh` script.
   */
  filenameKind?: boolean;
  /**
   * Default true. Set false for sources that are documented here for a
   * planned future migration (e.g. static manifests still vendored in the
   * legacy `prod` repo) but aren't wired into an `apps/*` chart yet.
   * `--all` skips disabled sources; naming one explicitly still runs it
   * (with a warning) so it can be smoke-tested ahead of the migration.
   */
  enabled?: boolean;
}

export const sources: CrdSource[] = [
  {
    name: "cert-manager",
    description: "cert-manager CRDs",
    // Derived from apps/cert-manager/app.ts so the CRDs always match the
    // Helm chart version actually deployed. Renovate should target the
    // `const version = "..."` line in that file instead of here.
    version: {
      kind: "app-const",
      appName: "cert-manager",
      constName: "version",
    },
    outputDir: "apps/cert-manager/crds",
    fetch: {
      kind: "web",
      urls: (version) => [
        `https://github.com/cert-manager/cert-manager/releases/download/v${version}/cert-manager.crds.yaml`,
      ],
    },
  },
  {
    name: "metrics",
    description:
      "VictoriaMetrics k8s-stack CRDs (via `helm show crds`, pinned to the chart version)",
    // Derived from apps/metrics/app.ts; see the cert-manager note above.
    version: { kind: "app-const", appName: "metrics", constName: "version" },
    outputDir: "apps/metrics/crds",
    fetch: {
      kind: "command",
      command: "helm",
      args: (version) => [
        "show",
        "crds",
        "oci://ghcr.io/victoriametrics/helm-charts/victoria-metrics-k8s-stack",
        "--version",
        version ??
          (() => {
            throw new Error("metrics source requires a version");
          })(),
      ],
    },
  },
  {
    name: "velero",
    description:
      "Velero CRDs, rendered by the locally-installed velero CLI (`install --crds-only --dry-run`). " +
      "Requires the client version below to match what's actually installed - there's no plain " +
      "CRD-only manifest published upstream.",
    // renovate: datasource=github-releases depName=vmware-tanzu/velero extractVersion=^v(?<version>.*)$
    version: { kind: "literal", value: "1.18.2" },
    outputDir: "apps/velero/crds",
    fetch: {
      kind: "command",
      command: "velero",
      args: () => ["install", "--crds-only", "--dry-run", "--output", "yaml"],
      versionCheck: {
        command: "velero",
        args: ["version", "--client-only"],
        extract: (stdout) => /Version:\s*(\S+)/.exec(stdout)?.[1] ?? "",
        expected: (version) => `v${version}`,
      },
    },
  },
  {
    name: "cnpg",
    description:
      "CloudNativePG operator manifests (CRDs, RBAC, webhooks, Deployment) - the full release bundle, " +
      "not just CRDs. Not yet wired into apps/postgres; today CNPG is applied out-of-band from the " +
      "legacy prod/cnpg repo. outputDir is a placeholder for once that migrates.",
    // renovate: datasource=github-releases depName=cloudnative-pg/cloudnative-pg extractVersion=^v(?<version>.*)$
    version: { kind: "literal", value: "1.30.0" },
    outputDir: "apps/postgres/crds",
    crdOnly: false,
    filenameKind: true,
    enabled: false,
    fetch: {
      kind: "web",
      urls: (version) => {
        const release = version!.split(".").slice(0, 2).join(".");
        return [
          `https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-${release}/releases/cnpg-${version}.yaml`,
        ];
      },
    },
  },
  {
    name: "cnpg-barman-cloud",
    description:
      "CloudNativePG barman-cloud plugin manifests. Companion to `cnpg` above; versioned independently " +
      "upstream. Same not-yet-migrated caveat applies.",
    // renovate: datasource=github-releases depName=cloudnative-pg/plugin-barman-cloud extractVersion=^v(?<version>.*)$
    version: { kind: "literal", value: "0.13.0" },
    outputDir: "apps/postgres/crds",
    crdOnly: false,
    filenameKind: true,
    enabled: false,
    fetch: {
      kind: "web",
      urls: (version) => [
        `https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v${version}/manifest.yaml`,
      ],
    },
  },
  {
    name: "cnpg-image-catalogs",
    description:
      "CNPG postgres-containers ClusterImageCatalogs (bookworm + trixie). These track upstream " +
      "`main`/rolling files with no version of their own, so there's nothing for Renovate to bump - " +
      "re-run periodically to pick up new point releases.",
    version: { kind: "none" },
    outputDir: "apps/postgres/crds",
    crdOnly: false,
    filenameKind: true,
    enabled: false,
    fetch: {
      kind: "web",
      urls: () => [
        "https://raw.githubusercontent.com/cloudnative-pg/postgres-containers/main/Debian/ClusterImageCatalog-bookworm.yaml",
        "https://raw.githubusercontent.com/cloudnative-pg/artifacts/refs/heads/main/image-catalogs-extensions/catalog-minimal-trixie.yaml",
      ],
    },
  },
  {
    name: "kured",
    description:
      "kured DaemonSet + RBAC, a single vendored manifest today in the legacy prod/kured repo. Placeholder " +
      "entry ready for when kured migrates here; URL pattern verified against the latest upstream " +
      "release but not yet exercised end-to-end against a real apps/kured chart.",
    // renovate: datasource=github-releases depName=kubereboot/kured
    version: { kind: "literal", value: "1.23.0" },
    outputDir: "apps/kured/crds",
    crdOnly: false,
    filenameKind: true,
    enabled: false,
    fetch: {
      kind: "web",
      urls: (version) => [
        `https://github.com/kubereboot/kured/releases/download/${version}/kured-${version}-combined.yaml`,
      ],
    },
  },
  {
    name: "sealed-secrets",
    description:
      "sealed-secrets controller manifest, vendored today in the legacy prod/sealed-secrets repo. " +
      "Placeholder entry for the eventual migration.",
    // renovate: datasource=github-releases depName=bitnami-labs/sealed-secrets extractVersion=^sealed-secrets-v(?<version>.*)$
    version: { kind: "literal", value: "0.38.4" },
    outputDir: "apps/sealed-secrets/crds",
    crdOnly: false,
    filenameKind: true,
    enabled: false,
    fetch: {
      kind: "web",
      urls: (version) => [
        `https://github.com/bitnami-labs/sealed-secrets/releases/download/sealed-secrets-v${version}/controller.yaml`,
      ],
    },
  },
  {
    name: "system-upgrade-controller",
    description:
      "rancher system-upgrade-controller + its CRD, vendored today in the legacy prod/system-upgrade " +
      "repo alongside a hand-written upgrade-plan.yaml (which has no upstream source and stays manual). " +
      "Placeholder entry for the eventual migration.",
    // renovate: datasource=github-releases depName=rancher/system-upgrade-controller
    version: { kind: "literal", value: "0.19.2" },
    outputDir: "apps/system-upgrade/crds",
    crdOnly: false,
    filenameKind: true,
    enabled: false,
    fetch: {
      kind: "web",
      urls: (version) => [
        `https://github.com/rancher/system-upgrade-controller/releases/download/v${version}/system-upgrade-controller.yaml`,
        `https://github.com/rancher/system-upgrade-controller/releases/download/v${version}/crd.yaml`,
      ],
    },
  },
];
