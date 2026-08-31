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

Wired up and in use. `loadDashboardsFromDir()` recurses through
`resources/Dashboard/`, and the folder is the subdirectory path relative to that
root. The sidecar reads it off the `k8s-sidecar-target-directory` annotation --
*not* `grafana_folder`, which is what the chart's docs suggest and what this
section used to claim.

- `resources/Dashboard/<Folder>/<name>.json` -> Grafana folder `<Folder>`
- Root-level files, and the `General/` subdirectory, emit no annotation and land
  in Grafana's "General". That is the convention for "no folder".
- Nested subdirectories produce a slash-joined name; nothing currently uses this.

### Dashboard identity is the uid, not the filename

The uid resolves as `spec.uid ?? metadata.name ?? basename(file)`. In practice
every dashboard pulled with grafanactl carries `metadata.name`, so **the filename
does not determine identity**. Consequences worth knowing before reorganising:

- Renaming or moving a JSON file keeps the uid, so Grafana *upserts* the existing
  dashboard -- new title, new folder, same dashboard, history intact. It does not
  create a duplicate. This is how `Non-Tech/printers.json` became
  `Printers/klipper.json`.
- The ConfigMap name derives from the uid too (`grafana-dashboard-<uid>`), so a
  move leaves no orphaned ConfigMap for Argo to prune.
- Conversely, *changing* `metadata.name` forks a new dashboard and abandons the
  old one. Don't, unless that is the intent.

## v2 schema dashboards are inert

`loadDashboardsFromDir()` skips any file whose `apiVersion` matches `/v2` (added
in 0b41ed8f). The sidecar's file provisioner only understands the v1 `panels`
array; v2 replaced it with `elements`/`layout`, and feeding that through produces
a broken ConfigMap rather than a failure you'd notice.

Currently inert, present in `resources/` as source but deployed by nobody:

- `Printers/filament.json` (v2beta1)
- `General/home-new.json` (v2alpha1)

These live in Grafana as UI-managed dashboards. **GitOps does not own them**, so
editing or moving the file changes nothing -- including moving it between folder
directories, since no ConfigMap is emitted to carry the folder annotation. Move
them in the UI instead.

There is no cheap way back to v1. `grafanactl resources pull
dashboards.v1.dashboard.grafana.app/<uid>` is accepted, but Grafana returns
`v2beta1` with `elements` regardless -- a dashboard stored as v2 is not
down-converted on read. Recovering one means rebuilding it against the v1 schema
by hand, or waiting for the sidecar to learn v2.

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
