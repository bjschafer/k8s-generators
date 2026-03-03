---
name: prometheus-query
description: Use when debugging k8s apps in this homelab, checking if services are scraping correctly, investigating pod health, resource usage, or any metric-related questions. Use when asked to "check metrics", "look at prometheus", or "query for X in namespace Y".
---

# Prometheus Query

Query the homelab Prometheus for debugging k8s apps.

**Server:** `https://metrics.cmdcentral.xyz`
**Tool:** `promtool` (available via `mise run` or directly since it's a mise tool)

## Quick Reference

| Goal | Command |
|------|---------|
| Instant value | `promtool query instant <server> '<expr>'` |
| Time range | `promtool query range --start=<t> --end=<t> --step=1m <server> '<expr>'` |
| Discover series | `promtool query series --match='<selector>' <server>` |
| Label values | `promtool query labels <server> <label>` |
| All metric names | `promtool query labels <server> __name__` |
| All namespaces | `promtool query labels <server> namespace` |

## Common Debugging Patterns

### Is a service up/being scraped?
```bash
promtool query instant https://metrics.cmdcentral.xyz 'up{namespace="<ns>"}'
```
Returns 1 = scraping ok, 0 = scrape failing, no result = not configured.

### Pod restarts
```bash
promtool query instant https://metrics.cmdcentral.xyz \
  'kube_pod_container_status_restarts_total{namespace="<ns>"}'
```

### CPU / memory for a namespace
```bash
# CPU usage rate
promtool query instant https://metrics.cmdcentral.xyz \
  'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="<ns>"}[5m]))'

# Memory
promtool query instant https://metrics.cmdcentral.xyz \
  'sum by (pod) (container_memory_working_set_bytes{namespace="<ns>"})'
```

### What metrics exist for an app?
```bash
# Find all series in a namespace
promtool query series --match='{namespace="<ns>"}' https://metrics.cmdcentral.xyz

# Or find metric names matching a pattern via label query
promtool query labels https://metrics.cmdcentral.xyz __name__ | grep <keyword>
```

### Active alerts
```bash
promtool query instant https://metrics.cmdcentral.xyz 'ALERTS{alertstate="firing"}'
```

### PostgreSQL / CNPG health
```bash
promtool query instant https://metrics.cmdcentral.xyz \
  'cnpg_pg_stat_activity_count{namespace="<ns>"}'
```

## Output Format

Default output: `<labels> => <value> @[<timestamp>]`

Use `-o json` for structured output, `-o csv` for tabular data.

## Time Flags

- `--time=2024-01-15T10:00:00Z` (RFC3339) or Unix timestamp
- `--start` / `--end` for range queries
- `--step=5m` for range resolution (default varies)

## Namespaces Available

Key namespaces: `argocd`, `authentik`, `ceph`, `cert-manager`, `cnpg-system`, `grafana`, `immich`, `kube-system`, `metrics`, `postgres` (varies by app)

Run `promtool query labels https://metrics.cmdcentral.xyz namespace` for the full live list.
