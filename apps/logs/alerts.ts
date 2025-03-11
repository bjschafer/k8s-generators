import { Construct } from "constructs";
import { Alert, SEND_TO_TELEGRAM } from "../../lib/monitoring/alerts";
import { namespace } from "./app";

export function addAlerts(scope: Construct, id: string): void {
  new Alert(scope, `${id}-default`, {
    name: "logs",
    namespace: namespace,
    logs: true,
    rules: [
      {
        alert: "HostFilesystemReadonly",
        expr: `hostname:"k8s" AND job:"systemd-journal" AND "Remounting filesystem read-only" | stats by (hostname) count(*)>0`,
        for: "0m",
        labels: {
          priority: "0",
          severity: "critical",
          ...SEND_TO_TELEGRAM,
        },
        annotations: {
          summary:
            "Filesystem on host {{ $labels.hostname }} is read-only, probable longhorn issue",
        },
      },
    ],
  });
}
