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
  namespace: string;
  ruleGroups: VmRuleSpecGroups[];
}

export class MonitoringRule extends Chart {
  constructor(scope: Construct, id: string, props: MonitoringRuleProps) {
    super(scope, id);

    new VmRule(this, "rule", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      spec: {
        groups: props.ruleGroups,
      },
    });
  }
}
