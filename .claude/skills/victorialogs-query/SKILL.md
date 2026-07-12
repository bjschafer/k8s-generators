---
name: victorialogs-query
description: Use when debugging k8s apps, hosts, or network gear in this homelab by their logs — tailing/filtering pod logs, finding errors, counting log volume by app/level, or querying journald/syslog/UniFi (CEF) logs. Use when asked to "check the logs", "why is X crashing", "grep the logs for Y", or "how many errors in namespace Z".
---

# VictoriaLogs Query

Query the homelab VictoriaLogs instance for k8s pod logs, host journald/syslog, and UniFi (CEF) device logs. Query language is **LogsQL**.

**Server:** `https://logs.cmdcentral.xyz` (no auth needed from this network)
**Tool:** `vlogscli` (installed via mise as `vlogscli-prod`)

## Running Queries

Use the `mise run logs` task — it presets the datasource and strips vlogscli's banner.

```bash
# One-shot query (compact output, clean stdout — best for scripting/agents)
mise run logs '<LogsQL query>'

# Interactive REPL (no args) — best for iterative exploration
mise run logs
```

**Always bound queries by time** with a leading `_time:` filter (e.g. `_time:1h`, `_time:15m`, `_time:2026-07-11T00:00:00Z`) — without one you scan the full 3-month retention. Add `| limit N` when browsing raw lines.

Direct invocation (if you need a raw flag): `vlogscli-prod -datasource.url=https://logs.cmdcentral.xyz/select/logsql/query`. Override the target with `VLOGS_DATASOURCE=... mise run logs '…'`.

## LogsQL Cheatsheet

| Goal                     | Syntax                                                         |
| ------------------------ | -------------------------------------------------------------- | ---------------------------------------- |
| Word/phrase in message   | `error` · `"connection refused"`                               |
| Field equals             | `level:error` · `kubernetes.pod_namespace:immich`              |
| Field prefix / wildcard  | `level:warn*` · `pod:immich-server*`                           |
| Regex on field           | `\_msg:~"timeout                                               | refused"`                                |
| Field is set / non-empty | `cef.device_vendor:*`                                          |
| Boolean                  | `error AND level:error` · `error NOT healthcheck` · `(a OR b)` |
| Time window              | `_time:1h` · `_time:5m` · `_time:2026-07-10T00:00:00Z`         |
| Project columns          | `...                                                           | keep \_time, kubernetes.pod_name, \_msg` |
| Drop noisy columns       | `...                                                           | delete kubernetes.node_labels.\*`        |
| Limit rows               | `...                                                           | limit 50`                                |
| Sort                     | `...                                                           | sort by (\_time desc)`                   |
| Count / group            | `...                                                           | stats by (level) count() as n`           |
| Unique values            | `...                                                           | uniq by (kubernetes.pod_name)`           |

Pipes chain: `filter | stats ... | sort ... | limit ...`. Full reference: https://docs.victoriametrics.com/victorialogs/logsql/

## Key Fields

**Kubernetes** (via Vector, `source_type:kubernetes_logs`):

- `kubernetes.pod_namespace` — the namespace (`argocd`, `immich`, `media`, `ceph`, …)
- `kubernetes.container_name`, `kubernetes.pod_name`
- `stream` — `stdout` or `stderr`
- `level` — parsed log level where available (`error`, `warn`, `info`, `notice`, `debug`)

**Hosts** (journald/syslog, `source_type:journald`):

- `hostname` — `infra1`, `infra2`, `vmhost01`–`03`, `pandora`, `gitlab`, `apt`, …
- `SYSLOG_IDENTIFIER` / `_SYSTEMD_UNIT` — the service (`pdns-recursor`, `caddy`, `pdns_server`, `vector`, `node_exporter`, …). NOTE: the bare `unit` stream field is mostly empty for journald — use `SYSLOG_IDENTIFIER` instead.

**Network gear** (CEF): `cef.device_vendor` (`Ubiquiti`), `cef.device_product` (`UniFi Protect`, `UniFi Network`), `cef.device_event_class_id`.

**Universal:** `_msg` (log line), `_time`, `_stream`, `source_type`.

Discover live values with `stats by (<field>)`, e.g. `mise run logs '_time:1h * | stats by (kubernetes.pod_namespace) count() as n | sort by (n desc)'`.

## Common Patterns

### Debug a k8s app — recent logs / errors

```bash
# Last 15m of a namespace, newest first, just the useful columns
mise run logs '_time:15m kubernetes.pod_namespace:immich | keep _time, kubernetes.pod_name, _msg | sort by (_time desc) | limit 50'

# Errors only for one container
mise run logs '_time:1h kubernetes.container_name:immich-server (error OR level:error) | keep _time, _msg | limit 50'

# Everything a single pod logged (use after `kubectl get pods` gives you a name)
mise run logs '_time:30m kubernetes.pod_name:immich-server-abc123 | keep _time, stream, _msg | sort by (_time desc)'

# Only stderr (often where crashes land)
mise run logs '_time:1h kubernetes.pod_namespace:media stream:stderr | keep _time, kubernetes.pod_name, _msg | limit 50'
```

### Error / level analysis

```bash
# Which namespaces are the noisiest for errors right now?
mise run logs '_time:1h error | stats by (kubernetes.pod_namespace) count() as errors | sort by (errors desc) | limit 15'

# Log level breakdown across the cluster
mise run logs '_time:1h level:* | stats by (level) count() as n | sort by (n desc)'

# Errors per pod in one namespace (find the misbehaving replica)
mise run logs '_time:1h kubernetes.pod_namespace:media (error OR level:error) | stats by (kubernetes.pod_name) count() as n | sort by (n desc)'

# Spot a spike: error volume bucketed over time
mise run logs '_time:6h error | stats by (_time:10m) count() as n'
```

### Host / syslog / journald

```bash
# What's logging on a host, by service
mise run logs '_time:1h hostname:infra1 | stats by (SYSLOG_IDENTIFIER) count() as n | sort by (n desc) | limit 15'

# Tail a specific systemd service
mise run logs '_time:30m hostname:vmhost03 SYSLOG_IDENTIFIER:caddy | keep _time, _msg | sort by (_time desc) | limit 50'

# sshd / auth activity on a host
mise run logs '_time:6h hostname:infra1 SYSLOG_IDENTIFIER:sshd | keep _time, _msg | limit 50'
```

### Network gear (UniFi / CEF)

```bash
# UniFi event volume by product
mise run logs '_time:6h cef.device_vendor:Ubiquiti | stats by (cef.device_product) count() as n | sort by (n desc)'

# Recent UniFi Network events
mise run logs '_time:1h cef.device_product:"UniFi Network" | keep _time, _msg | sort by (_time desc) | limit 50'
```

## Output Notes

- Default output of the task is **compact** (`field=value` per line). In the interactive REPL, switch modes with `\s` (single-line), `\c` (compact), `\j` (JSON), `\m` (multiline JSON).
- Raw k8s log lines carry dozens of `kubernetes.node_labels.*` / `kubernetes.pod_annotations.*` fields. **Always project with `| keep _time, kubernetes.pod_name, _msg`** (or similar) so output is readable.
- `stats`/`sort`/`uniq` need `by (...)`; a bare `count()` with no `by` prints a single total on its own line.
