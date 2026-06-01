---
name: grafana-dashboards
description: How Grafana dashboards are managed — GitOps via ConfigMaps, grafanactl as the sync tool, and the path toward Foundation SDK
metadata:
  type: project
---

# Grafana Dashboard Management

## Current Architecture

Dashboards are stored as JSON in `resources/Dashboard/*.json` and injected into Grafana via Kubernetes ConfigMaps with the `grafana_dashboard: "1"` label. The Grafana Helm chart runs a k8s-sidecar container that watches for these ConfigMaps and loads them into Grafana's provisioning directory automatically.

`apps/grafana/app.ts` → `loadDashboards()` reads every `.json` from `resources/Dashboard/`, extracts the inner `spec` from the grafanactl wrapper format, and emits one `grafana-dashboard-<uid>` ConfigMap per file. Adding a new dashboard is: drop a JSON in `resources/Dashboard/`, run `mise run build`, commit, push.

## The grafanactl Wrapper Format

`grafanactl pull` saves dashboards in a Kubernetes-style API object:
```json
{
  "apiVersion": "dashboard.grafana.app/v0alpha1",
  "kind": "Dashboard",
  "metadata": { "name": "<uid>", ... },
  "spec": { /* actual Grafana dashboard JSON */ }
}
```

The ConfigMap data needs just the `spec` content — that's what Grafana provisioning understands. `loadDashboards()` does `raw.spec ?? raw` so plain dashboard JSON (no wrapper) also works.

## Editing Workflow

`allowUiUpdates: true` is intentionally kept. Grafana allows UI edits but the sidecar resyncs from git on each GitOps cycle, which means:
- UI edits are ephemeral unless explicitly saved back to git
- **Save workflow**: edit in Grafana UI → `grafanactl pull dashboards/<uid>` → check `resources/Dashboard/<uid>.json` → `mise run build` → commit

Agents: use `grafanactl resources get dashboards` to find UIDs, pull to get the current spec, edit the JSON in `resources/Dashboard/`, build and commit.

## Folder Support

The provider has `foldersFromFilesStructure: true` but with ConfigMaps the sidecar uses the `grafana_folder` annotation, not file paths. Currently all dashboards land in "General". To add folder support later:
- Use subdirectories: `resources/Dashboard/<FolderName>/<uid>.json`
- `loadDashboards()` would need to walk subdirs and add `annotations: { grafana_folder: subdirName }` to each ConfigMap
- This is a small change, not wired up yet

## Dashboard Size

ConfigMaps have a 1 MB limit per object. Current dashboards (authentik: 38 KB, ceph-perf-drilldown: 28 KB) are well under. Only a concern for very large dashboards with many panels.

## Future: Grafana Foundation SDK

The [Grafana Foundation SDK](https://github.com/grafana/grafana-foundation-sdk) is a TypeScript library for building dashboards as type-safe code. Instead of editing raw JSON, you'd define dashboards in `apps/grafana/dashboards/*.ts`, call `.build()` to get the JSON spec, and feed that into the same ConfigMap pattern.

Benefits: type checking on panel config, IDE completion, PromQL expressions as strings caught at compile time if wrapped, diffs are code not JSON blobs.

**Risk to check before adopting**: Foundation SDK schema versions track Grafana minor versions. Before adding it, verify the SDK release matches the deployed Grafana version (`grafana/app.ts` has the Helm chart version). The SDK ships per-Grafana-version packages — wrong version means schema mismatches or missing panel types.

**Migration path**: one dashboard as a proof-of-concept TypeScript file. The build output slots right into the existing `loadDashboards()` pattern — no other infra change needed.

## What NOT to use grafanactl for anymore

`grafanactl push` is no longer the deployment path — GitOps handles that. Use grafanactl only for:
1. Pulling the current live state of a dashboard back to `resources/Dashboard/` (to capture UI edits)
2. Inspecting/listing dashboards by UID
3. Validating dashboard JSON against the live instance before committing
