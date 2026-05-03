---
name: alertmanager
description: Use when investigating active alerts, managing/silencing noisy or flappy alerts, or checking alertmanager status in the homelab. Use when asked about "silences", "alerts firing", "alertmanager", or "mute an alert".
---

# Alertmanager

Interact with the homelab Alertmanager for alert triage and silencing.

**Server:** `https://alertmanager.cmdcentral.xyz`  
**Tool:** `amtool` (available via `mise run` or directly since it's a mise tool)

Set the default server via env var or pass `--alertmanager.url` to every command:

```bash
export AMTOOL_URL=https://alertmanager.cmdcentral.xyz
```

## Quick Reference

| Goal | Command |
|------|---------|
| List active alerts | `amtool alert` |
| List active alerts (verbose) | `amtool alert -o extended` |
| List silences | `amtool silence` |
| Show silence details | `amtool silence <id>` |
| Create a silence | `amtool silence add <matcher...> --duration=<duration> --comment="<reason>"` |
| Expire a silence | `amtool silence expire <id>` |
| Check alertmanager status | `amtool status` |
| Validate config | `amtool check-config alertmanager.yml` |

## Common Workflows

### View active alerts

```bash
# Simple list
amtool alert

# Extended with labels and annotations
amtool alert -o extended

# Filter by alert name
amtool alert -o extended | grep <alertname>

# Filter by label
amtool alert -o extended --alertmanager.url=https://alertmanager.cmdcentral.xyz 'alertname=~".*"'
```

### Silence a noisy/flappy alert

```bash
# Silence a specific alert by exact name in a namespace
amtool silence add alertname=KubePodCrashLooping namespace=immich \
  --duration=2h \
  --comment="Investigating image pull issue -BS"

# Silence all alerts matching a pattern
amtool silence add alertname=~"PostgreSQL.*" namespace=cnpg-system \
  --duration=30m \
  --comment="CNPG maintenance window"

# Silence all alerts in a namespace
amtool silence add namespace=grafana \
  --duration=1h \
  --comment="Grafana upgrade in progress"
```

### List and manage existing silences

```bash
# Show all active silences
amtool silence

# Show expired silences too
amtool silence --expired

# Get details of a specific silence by ID
amtool silence <silence-id>

# Expire a silence early (e.g., fix deployed, silence no longer needed)
amtool silence expire <silence-id>

# Expire multiple silences at once
amtool silence expire <id1> <id2>
```

### Check alertmanager health and peers

```bash
# Cluster status, uptime, config reload info
amtool status

# Check if cluster is healthy and how many peers are visible
amtool status | grep -A5 "Cluster Status"
```

## Matchers Syntax

Matchers filter alerts and define what a silence applies to.

| Syntax | Meaning |
|--------|---------|
| `key=value` | Exact match |
| `key=~"regex"` | Regex match |
| `key!="value"` | Negative match |
| `key!~"regex"` | Negative regex match |

Multiple matchers are ANDed together.

## Duration Format

Use Go duration syntax: `30m`, `1h`, `2h30m`, `1d` (if supported), etc.

## Output Formats

| Flag | Output |
|------|--------|
| `-o simple` | Default compact list |
| `-o extended` | Labels + annotations |
| `-o json` | Structured JSON |

## Important Notes

- **Always add a `--comment`** when creating silences so future-you knows why.
- **Include your initials or name** in silence comments for accountability.
- **Prefer narrow silences** (specific alertname + namespace) over broad ones (all alerts in a namespace).
- **Expire silences early** if the issue is resolved before the duration ends.
- Silences created via `amtool` are stored in Alertmanager's cluster state and will persist across restarts.
