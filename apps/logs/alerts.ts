import { Construct } from "constructs";
import { Alert, PRIORITY, SEND_TO_PUSHOVER } from "../../lib/monitoring/alerts";
import { namespace } from "./app";

export function addAlerts(scope: Construct, id: string): void {
  new Alert(scope, `${id}-default`, {
    name: "logs",
    namespace: namespace,
    logs: true,
    rules: [
      {
        alert: "HostFilesystemReadonly",
        expr: `hostname:"k8s" AND job:"systemd-journal" AND "Remounting filesystem read-only" | stats by (hostname) count(*) logs_count | filter logs_count:>0`,
        for: "0m",
        labels: {
          priority: "0",
          severity: "critical",
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "Filesystem on host {{ $labels.hostname }} is read-only, probable longhorn issue",
        },
      },
      {
        // The vmhosts are Ivy Bridge (no AVX2), so any image rebased onto
        // EL10/UBI10 dies in the dynamic loader with this line and nothing
        // else -- from the outside it is just an unexplained crashloop
        // (cephcsi 3.18, 2026-10). The phrase stops at "x86-64" so a future
        // v4 baseline is caught too. Renamed because dotted field names are
        // not valid Prometheus label names.
        alert: "ContainerCpuArchUnsupported",
        expr: `"CPU does not support x86-64" | stats by (kubernetes.pod_namespace, kubernetes.container_name) count(*) logs_count | filter logs_count:>0 | rename kubernetes.pod_namespace as namespace, kubernetes.container_name as container`,
        for: "0m",
        labels: {
          priority: PRIORITY.NORMAL,
          severity: "critical",
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "{{ $labels.namespace }}/{{ $labels.container }} image requires a newer x86-64 microarch level than the hosts support -- pin the previous image",
        },
      },
    ],
  });

  // Homebox has no metrics endpoint, so its maintenance notifiers can only be
  // watched through logs. Both rules carry an explicit `_time:` filter to widen
  // vmalert's default lookback (one group interval) -- these are once-a-day
  // events, and at a 1m window a failure would be a blip that has to survive
  // Alertmanager's group_wait to reach anyone.
  new Alert(scope, `${id}-homebox`, {
    name: "homebox",
    namespace: namespace,
    logs: true,
    rules: [
      {
        // The phrase must start at "to" -- zerolog's console writer emits raw
        // ANSI escapes, so the line arrives as `\x1b[1mfailed to send notifiers`
        // and LogsQL tokenizes the prefix into `1mfailed`. Matching on "failed"
        // returns nothing.
        alert: "HomeboxNotifierFailed",
        expr: `_time:6h kubernetes.pod_namespace:homebox "to send notifiers" | stats count(*) logs_count | filter logs_count:>0`,
        for: "0m",
        labels: {
          priority: PRIORITY.NORMAL,
          severity: "warning",
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "Homebox failed to deliver a maintenance notification -- check that the notifier target still accepts messages",
        },
      },
      {
        // Catches the case rule 1 cannot see: the task never ran, so nothing was
        // attempted and nothing failed. Homebox prints this line unconditionally
        // at hour 8. Window is 26h, not 24h: the hourly ticker's phase follows
        // pod start time, so a restart shifts the daily run by up to an hour and
        // a 24h window would false-fire in that gap.
        alert: "HomeboxNotifierTaskStale",
        expr: `_time:26h kubernetes.pod_namespace:homebox "run notifiers" | stats count(*) logs_count | filter logs_count:<1`,
        for: "10m",
        labels: {
          priority: PRIORITY.LOW,
          severity: "warning",
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Homebox maintenance-notifier task has not run in over a day",
        },
      },
    ],
  });

  // ledgermain (bjschafer/ledgermain #176): api.ledgermain.whizkid.dev is a
  // Workers custom domain, so it has no origin and the account's Cloudflare
  // notification policy (an *origin* error-rate alert) can never see it 5xx.
  // tf-cloudflare's `ledgermain_api_trace_events` Logpush job is the
  // replacement signal -- every invocation of that Worker lands here via the
  // same VictoriaLogs endpoint the firewall/http_requests jobs already use.
  //
  // Two conditions, because one Worker outcome doesn't cover both failure
  // modes: an uncaught throw sets Outcome to "exception", but the Worker's
  // own try/catch (src/index.ts) returns a 500 response normally, so that
  // path only ever shows up as Event.Response.Status. Confirmed against a
  // real payload (two GET /api/me and /api/nonexistent-route-check probes,
  // 2026-09-12) -- the field is capitalized `Status`, not `status`.
  new Alert(scope, `${id}-ledgermain-api`, {
    name: "ledgermain-api",
    namespace: namespace,
    logs: true,
    rules: [
      {
        alert: "LedgermainApiWorkerError",
        expr: `ScriptName:"ledgermain-api" AND (Outcome:"exception" OR Event.Response.Status:>=500) | stats count(*) logs_count | filter logs_count:>0`,
        for: "0m",
        labels: {
          priority: PRIORITY.NORMAL,
          severity: "warning",
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "ledgermain-api threw an uncaught exception or returned a 5xx",
        },
      },
    ],
  });
}
