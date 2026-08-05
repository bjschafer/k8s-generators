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
}
