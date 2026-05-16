---
name: grafanactl
description: Use when working with Grafana dashboards, alert rules, or other Grafana resources in the homelab — pulling, editing, pushing, validating, or previewing them. Use when asked to "update a dashboard", "add a panel", "push to Grafana", or "preview a dashboard locally".
---

# grafanactl

Manage homelab Grafana resources (dashboards, folders, alert rules) via the CLI.

**Server:** `https://grafana.cmdcentral.xyz`  
**Context:** `default` (pre-configured)  
**Resources dir:** `./resources/` (default pull/push path)

## Quick Reference

| Goal | Command |
|------|---------|
| List resource types | `grafanactl resources list` |
| List dashboards | `grafanactl resources get dashboards` |
| View a dashboard (YAML) | `grafanactl resources get dashboards/<name> -o yaml` |
| Pull all to disk | `grafanactl resources pull` |
| Pull specific type | `grafanactl resources pull dashboards` |
| Push all from disk | `grafanactl resources push` |
| Push specific dashboard | `grafanactl resources push dashboards/<name>` |
| Dry-run push | `grafanactl resources push --dry-run` |
| Validate | `grafanactl resources validate` |
| Local preview server | `grafanactl resources serve ./resources` |
| Delete a resource | `grafanactl resources delete dashboards/<name>` |
| Check config/context | `grafanactl config view` |

Resource names are the Grafana UIDs (e.g. `CrAHE0iZz`), not the display title. Use `get dashboards` to find the name for a given dashboard.

## Common Workflows

### Inspect an existing dashboard

```bash
# Find the resource name from the list
grafanactl resources get dashboards

# View full spec
grafanactl resources get dashboards/<name> -o yaml
```

### Edit a dashboard locally and push it back

```bash
# Pull the dashboard to disk
grafanactl resources pull dashboards/<name>
# Edits land in ./resources/dashboards/<name>.json or .yaml

# Preview locally (live-reloads on save)
grafanactl resources serve ./resources

# Validate against the remote Grafana instance
grafanactl resources validate dashboards

# Push when satisfied
grafanactl resources push dashboards/<name>
```

### Add a new dashboard from scratch

```bash
# Pull existing dashboards for reference
grafanactl resources pull dashboards

# Create a new .json or .yaml in ./resources/dashboards/
# (copy an existing one as a template, adjust uid, title, panels)

# Validate, then push
grafanactl resources validate
grafanactl resources push --dry-run
grafanactl resources push
```

### Sync all resources bidirectionally

```bash
# Pull everything from Grafana
grafanactl resources pull

# Make changes locally

# Push everything back
grafanactl resources validate && grafanactl resources push
```

## Panel Query Validation

**Before embedding a PromQL expression in a panel, verify it returns data with the prometheus-query skill.**

```bash
# Quick sanity-check a query
promtool query instant https://metrics.cmdcentral.xyz '<your expr>'
```

Common causes of blank panels:
- Query returns no series (wrong labels — check with `query series --match='{...}'`)
- Wrong time range for the dashboard variable
- Datasource UID in the panel spec doesn't match the Grafana datasource

## Resource Structure

Resources on disk are JSON (default) or YAML. Key dashboard fields:

```yaml
apiVersion: dashboard.grafana.app/v0alpha1
kind: Dashboard
metadata:
  name: <uid>          # Grafana UID, used in all CLI selectors
  namespace: default
spec:
  title: "My Dashboard"
  panels: [...]
  templating:
    list: [...]        # Dashboard variables
```

Alert rules use `rules.alerting.grafana.app/v0alpha1` with kind `AlertRule`.

## Output Formats

| Flag | Use case |
|------|----------|
| `-o text` (default) | Quick summary |
| `-o yaml` | Human-readable edit/review |
| `-o json` | Machine-readable, default pull format |
| `-o wide` | Extra columns in list view |

## Common Mistakes

- **Pushing without validating first** — always run `validate` before `push` to catch schema errors.
- **Using display title instead of UID** — selectors use the `metadata.name` (UID), not `spec.title`.
- **Missing datasource UID** — when creating panels, the datasource `uid` in the spec must match what Grafana has. Pull an existing dashboard to see the correct UID for Prometheus.
- **Forgetting `--dry-run`** on first push of a new dashboard — use it to confirm what will be created/updated.
