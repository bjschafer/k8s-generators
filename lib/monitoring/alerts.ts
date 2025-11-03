import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  VmRule,
  VmRuleSpecGroupsRules,
} from "../../imports/operator.victoriametrics.com";

export const SEND_TO_PUSHOVER = {
  push_notify: "true",
};

export enum PRIORITY {
  /** Bypass quiet hours */
  HIGH = "1",
  /** Normal priority */
  NORMAL = "0",
  /** No sound */
  LOW = "-1",
}

export const LOGS_RULE = {
  "alerts.cmdcentral.xyz/kind": "logs",
};

export interface AlertProps {
  name: string;
  namespace: string;
  rules: VmRuleSpecGroupsRules[];
  logs?: boolean;
}

export class Alert extends Chart {
  constructor(scope: Construct, id: string, props: AlertProps) {
    super(scope, id);

    // Automatically inject namespace label for alerts with pushover routing
    // VMAlertmanagerConfig routes are wrapped with namespace matchers, so alerts
    // must have namespace set to match the config's namespace for routing to work
    const processedRules = props.rules.map((rule) => {
      const shouldInjectNamespace =
        rule.labels &&
        (rule.labels.push_notify === "true" ||
          (rule.labels.priority !== undefined &&
            (rule.labels.priority === "0" ||
              rule.labels.priority === "1" ||
              rule.labels.priority === PRIORITY.NORMAL ||
              rule.labels.priority === PRIORITY.HIGH)));

      if (shouldInjectNamespace && !rule.labels!.namespace) {
        return {
          ...rule,
          labels: {
            ...rule.labels,
            namespace: props.namespace,
          },
        };
      }
      return rule;
    });

    new VmRule(this, `${id}-rule`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: {
          "alerts.cmdcentral.xyz/kind": props.logs ? "logs" : "metrics",
        },
      },
      spec: {
        groups: [
          {
            name: props.name,
            type: props.logs ? "vlogs" : undefined,
            rules: processedRules,
          },
        ],
      },
    });
  }
}
