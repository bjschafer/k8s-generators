---
name: gcx
description: Use when working with Grafana dashboards, alert rules, datasources, or other Grafana resources in the homelab — listing, inspecting, pulling live state back into git, validating, or checking panel queries. Use when asked to "update a dashboard", "add a panel", "pull a dashboard", "what's on dashboard X", or "save my UI edits to git".
---

# gcx

Inspect homelab Grafana resources via the `gcx` CLI (successor to the deprecated
`grafanactl`; same resource model, same `resources` verbs).

**Server:** `https://grafana.cmdcentral.xyz`
**Context:** `default` (pre-configured in `~/.config/gcx/config.yaml`)
**Dashboard source of truth:** `resources/Dashboard/<Folder>/<name>.json` in this repo

## GitOps first: gcx reads, git writes

Dashboards deploy as ConfigMaps built by `apps/grafana/app.ts` and loaded by the
Grafana sidecar. **Do not deploy with gcx.** Anything written straight to Grafana
(`resources push`, `resources edit`, `dashboards create/update/delete`,
`versions restore`, `dev serve`) is either reverted by the sidecar or leaves a
UI-only dashboard git doesn't know about. Only write to Grafana when the user
explicitly asks for it.

The change path is always: edit JSON in `resources/Dashboard/` → `mise run build`
→ commit. See `slopdocs/features/grafana-dashboards.md` for folders, uid
identity, and the v2-schema caveat.

## Quick Reference

| Goal | Command |
|------|---------|
| Check config + connectivity | `gcx config check` |
| Show config (secrets redacted) | `gcx config view` |
| Discover commands | `gcx help-tree --depth 1 -o text`, then `gcx help-tree <group> -o text` |
| List resource types | `gcx resources list-types` |
| List dashboards | `gcx dashboards list -o wide` |
| Search dashboards | `gcx dashboards search "<text>" --folder <folder> -o json` |
| View one dashboard | `gcx dashboards get <uid> --api-version dashboard.grafana.app/v1 -o json` |
| Pull a dashboard to disk | `gcx resources pull dashboards/<uid> -p <scratch-dir> --include-managed` |
| Validate local files | `gcx resources validate -p <path> -o json` |
| Version history | `gcx dashboards list-versions <uid>` |
| List datasources | `gcx datasources list -o json` |
| Prometheus label values | `gcx datasources prometheus labels -d <uid> --label <label>` |
| Alert rules | `gcx alert rules list` |

Resource names are Grafana UIDs (`metadata.name`, e.g. `CrAHE0iZz`), never the
display title. Search or list first to find the UID.

gcx auto-detects Claude Code and defaults to terse `agents` output. Pass
`-o json`/`-o yaml` explicitly when you need the full object.

## Workflows

### Capture UI edits (or current live state) into git

```bash
# 1. Pull into a scratch dir, NOT ./resources
gcx resources pull dashboards/<uid> -p "$SCRATCH" --include-managed

# 2. gcx writes to <kind>.<version>.<group>/<uid>.json, e.g.
#    $SCRATCH/dashboards.v0alpha1.dashboard.grafana.app/<uid>.json
#    (use the path gcx prints; the version is the server's preferred one)

# 3. Copy over the existing file — find it by uid, since the filename may differ —
#    stripping the provisioning annotations Grafana adds on read
grep -rl '"name": "<uid>"' resources/Dashboard/
jq '.metadata.annotations |= with_entries(select(.key == "grafana.app/folder"))' \
  "$SCRATCH"/dashboards.*/<uid>.json > resources/Dashboard/<Folder>/<file>.json

# 4. Review the diff, build, commit
git diff resources/Dashboard/
mise run build
```

Why the scratch dir: gcx's default path is `./resources`, where it would create
`resources/dashboards.v0alpha1.dashboard.grafana.app/` — outside `resources/Dashboard/`,
so the build silently ignores it and you'd be committing an orphan copy.

Why `--include-managed`: sidecar-provisioned dashboards carry
`grafana.app/managedBy: classic-file-provisioning`. Without the flag pull
writes zero files and still exits 0.

Why the `jq` strip: a pull adds `grafana.app/managedBy`, `managerId`,
`sourcePath`, `sourceChecksum`, and `sourceTimestamp` annotations — pure churn
(the checksum and timestamp change every sync). The `spec` is otherwise
byte-for-byte what's in git. `jq` also rewrites the Go-style
escapes gcx (and grafanactl before it) emit — `>`, `<`, `&` — as
literal `>`/`<`/`&`; that's a harmless one-time diff per file.

### Edit a dashboard

1. Pull current live state (above) so you aren't editing a stale copy.
2. Edit the JSON under `resources/Dashboard/`. Keep `metadata.name` unchanged —
   changing it forks a new dashboard.
3. Validate queries (below), then `mise run build` and commit.

### Add a new dashboard

1. Copy a similar dashboard in `resources/Dashboard/` as the template; its
   variables, datasource wiring, and units follow house conventions.
2. Set a new stable `metadata.name` (uid) and `spec.title`.
3. Put it in the subdirectory named after the target Grafana folder. Folder
   comes from the directory (`k8s-sidecar-target-directory`), **not** from a
   `grafana.app/folder` annotation — that annotation does nothing here.
4. Author against the v1 schema (`panels` / `templating`). v2 files
   (`elements` / `layout`) are skipped by the build.

## Panel Query Validation

Verify every PromQL expression returns data before embedding it — use the
prometheus-query skill, or:

```bash
promtool query instant https://metrics.cmdcentral.xyz '<expr>'
gcx datasources prometheus labels -d <prom-uid> --label __name__   # metric exists?
```

Datasources are UI-managed, so panels must reference a `${datasource}` template
variable, never a hardcoded datasource uid.

Common causes of blank panels:
- Query returns no series (wrong labels)
- Hardcoded datasource uid instead of `${datasource}`
- Variable wired to the wrong label

## Resource Structure

```json
{
  "apiVersion": "dashboard.grafana.app/v0alpha1",
  "kind": "Dashboard",
  "metadata": {
    "annotations": { "grafana.app/folder": "<folder-uid>" },
    "labels": {},
    "name": "<uid>",
    "namespace": "default"
  },
  "spec": { "title": "...", "panels": [], "templating": { "list": [] } }
}
```

`apps/grafana/app.ts` unwraps `spec` for the ConfigMap; metadata other than
`name` is ignored by the build. `v0alpha1` is what this Grafana (13.2) pulls
by default; `v1` also works. Anything with `/v2` in `apiVersion` is skipped.

Pin `--api-version dashboard.grafana.app/v1` on `dashboards get`: without it the
server returns its preferred version, which may be the v2 shape.

## Common Mistakes

- **Pulling into `./resources`** — creates a stray API-group directory the build
  ignores. Always pull to a scratch dir and copy over the real file.
- **Forgetting `--include-managed`** — provisioned dashboards are skipped with
  no error, so it looks like the dashboard doesn't exist.
- **`cp`-ing the pulled file verbatim** — commits provisioning annotations whose
  checksum/timestamp churn on every pull. Use the `jq` strip.
- **Using display title instead of UID** in selectors.
- **Reading the config file directly** — it holds a plaintext token. Use
  `gcx config view`.
- **`gcx dashboards snapshot`** — needs the Grafana Image Renderer, which isn't
  deployed. Don't claim a visual review.
- **HTML / `invalid character '<'` errors** — the request hit Cloudflare
  instead of Grafana (off-LAN, or WAF challenge). Not a gcx or token problem.
