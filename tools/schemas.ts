/**
 * Declarative registry of upstream JSON Schemas fetched by
 * `tools/update-schemas.ts` into `schemas/`, from which `mise run schemas`
 * generates the TypeScript types in `imports/helm-values/` that `apps/*`
 * use to type-check their Helm values.
 *
 * The point of fetching rather than hand-committing: a schema pinned to a
 * chart version that has since moved is worse than no schema at all -- it
 * silently rejects values the chart now accepts and accepts values it has
 * removed. Every `helm` source below therefore derives its version from the
 * same `const version = "..."` in `apps/<app>/app.ts` that the chart itself
 * is pinned to, so a Renovate chart bump refreshes the schema in the same PR
 * (see the `Refresh upstream values schemas` step in .github/workflows/ci.yaml).
 *
 * To add a schema: check whether the chart actually ships one --
 * `helm pull <chart> --repo <repo> --version <v> --untar` and look for
 * `values.schema.json` -- then add a stanza here and run
 * `mise run update-schemas <name>`.
 */
import { type VersionSource } from "./sources";

export type SchemaFetchStrategy =
  /**
   * Pull and untar a Helm chart, then read a file out of it. Charts have no
   * `helm show schema` equivalent (`helm show` covers chart/values/crds/readme
   * only), so the whole archive has to come down to get at one file.
   */
  | { kind: "helm"; chart: string; repo: string }
  /** Download a schema published as a plain file. */
  | { kind: "url"; url: (version?: string) => string };

export interface SchemaSource {
  /** Unique key; also the CLI argument, e.g. `mise run update-schemas eso`. */
  name: string;
  description: string;
  version: VersionSource;
  /** Output path relative to the repo root. */
  outputFile: string;
  fetch: SchemaFetchStrategy;
}

export const schemaSources: SchemaSource[] = [
  {
    name: "eso",
    description: "external-secrets chart values schema",
    version: { kind: "app-const", appName: "external-secrets", constName: "version" },
    outputFile: "schemas/eso-values.schema.json",
    fetch: {
      kind: "helm",
      chart: "external-secrets",
      repo: "https://charts.external-secrets.io",
    },
  },
  {
    name: "metallb",
    description:
      "metallb chart values schema. The bundled frr-k8s subchart ships its own schema, deliberately " +
      "not fetched: apps/metallb runs with speaker.frr.enabled=false, so none of its values are set.",
    version: { kind: "app-const", appName: "metallb", constName: "version" },
    outputFile: "schemas/metallb-values.schema.json",
    fetch: {
      kind: "helm",
      chart: "metallb",
      repo: "https://metallb.github.io/metallb",
    },
  },
  {
    name: "velero",
    description: "velero chart values schema",
    // apps/velero/app.ts names this `chartVersion` rather than `version` --
    // the app also tracks the velero *CLI* version that renders its CRDs.
    version: { kind: "app-const", appName: "velero", constName: "chartVersion" },
    outputFile: "schemas/velero-values.schema.json",
    fetch: {
      kind: "helm",
      chart: "velero",
      repo: "https://vmware-tanzu.github.io/helm-charts/",
    },
  },
  {
    name: "cert-manager",
    description: "cert-manager chart values schema",
    version: { kind: "app-const", appName: "cert-manager", constName: "version" },
    outputFile: "schemas/cert-manager-values.schema.json",
    fetch: {
      kind: "helm",
      chart: "cert-manager",
      repo: "https://charts.jetstack.io",
    },
  },
  {
    name: "reloader",
    description:
      "stakater/reloader chart values schema. Upstream's is close to empty -- it constrains " +
      "`reloader.reloadStrategy` to an enum and leaves everything else open -- so the generated type " +
      "catches very little today. Tracked anyway so apps/reloader picks it up for free if upstream " +
      "ever fills it in.",
    version: { kind: "app-const", appName: "reloader", constName: "version" },
    outputFile: "schemas/reloader-values.schema.json",
    fetch: {
      kind: "helm",
      chart: "reloader",
      repo: "https://stakater.github.io/stakater-charts",
    },
  },
  {
    name: "kometa",
    description:
      "Kometa config-file schema -- not a Helm chart. apps/media/kometa.ts renders a ConfigMap from a " +
      "typed literal, and this is what types it. Tracks upstream `master`, which is where Kometa " +
      "publishes it, so there is no version for Renovate to bump; re-run periodically.",
    version: { kind: "none" },
    outputFile: "schemas/kometa-config.schema.json",
    fetch: {
      kind: "url",
      url: () =>
        "https://raw.githubusercontent.com/Kometa-Team/Kometa/master/json-schema/config-schema.json",
    },
  },
];
