import { Chart } from "cdk8s";
import {
  VmPodScrape,
  VmRule,
  VmRuleSpecGroups,
  VmServiceScrape,
  VmServiceScrapeSpec,
} from "../../imports/operator.victoriametrics.com";
import { Construct } from "constructs";

export interface CmdcentralServiceMonitorProps {
  name: string;
  namespace: string;
  matchLabels: { [key: string]: string };
  portName?: string;
  extraConfig?: Partial<VmServiceScrapeSpec>;
}

export class CmdcentralServiceMonitor extends Chart {
  constructor(scope: Construct, id: string, props: CmdcentralServiceMonitorProps) {
    super(scope, id);

    new VmServiceScrape(this, "servicemonitor", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      spec: {
        namespaceSelector: {
          matchNames: [props.namespace],
        },
        endpoints: [{ port: props.portName ?? "metrics" }],
        selector: {
          matchLabels: props.matchLabels,
        },
        ...props.extraConfig,
      },
    });
  }
}

export interface CmdcentralPodMonitorProps {
  name: string;
  namespace: string;
  matchLabels: { [key: string]: string };
  /** Port name on the pod (matches the named container port) */
  portName: string;
}

export class CmdcentralPodMonitor extends Chart {
  constructor(scope: Construct, id: string, props: CmdcentralPodMonitorProps) {
    super(scope, id);

    new VmPodScrape(this, "podmonitor", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      spec: {
        namespaceSelector: {
          matchNames: [props.namespace],
        },
        podMetricsEndpoints: [{ port: props.portName }],
        selector: {
          matchLabels: props.matchLabels,
        },
      },
    });
  }
}

export interface MonitoringRuleProps {
  name: string;
  ruleGroups: VmRuleSpecGroups[];
  /**
   * Extra labels for the VMRule. Merged on top of the defaults, winning on key
   * collision.
   */
  labels?: { [key: string]: string };
}

/**
 * Namespace that every VMRule must live in to be evaluated.
 *
 * The `metrics` VMAlert sets `ruleSelector` but leaves `ruleNamespaceSelector`
 * nil. In the VM operator's selector logic `selectAllByDefault: true` only
 * means "all namespaces" when *both* selectors are nil -- once `ruleSelector`
 * is set, the nil namespace selector falls back to its default meaning of "the
 * VMAlert's own namespace". So a VMRule outside `metrics` is never selected by
 * any VMAlert, the operator leaves `.status.updateStatus` unset (or marks it
 * `ignored`), and ArgoCD's VM operator health check parks the whole app on
 * "Progressing" forever.
 */
const RULE_NAMESPACE = "metrics";

export class MonitoringRule extends Chart {
  constructor(scope: Construct, id: string, props: MonitoringRuleProps) {
    super(scope, id);

    new VmRule(this, "rule", {
      metadata: {
        name: props.name,
        namespace: RULE_NAMESPACE,
        labels: {
          // Matches the `metrics` VMAlert's ruleSelector.
          "alerts.cmdcentral.xyz/kind": "metrics",
          ...props.labels,
        },
      },
      spec: {
        groups: props.ruleGroups,
      },
    });
  }
}
