import { Construct } from "constructs";
import {
  Alert,
  LOGS_RULE,
  SEND_TO_TELEGRAM,
} from "../../lib/monitoring/alerts";
import { namespace } from "./app";

export function addAlerts(scope: Construct, id: string): void {
  new Alert(scope, `${id}-default`, {
    name: "logs",
    namespace: namespace,
    labels: LOGS_RULE,
    rules: [
      {
        alert: "HostFilesystemReadonly",
        expr: `"Remounting filesystem read-only"`,
        for: "0m",
        labels: {
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
