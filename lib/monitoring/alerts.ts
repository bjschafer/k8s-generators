import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  VmRule,
  VmRuleSpecGroupsRules,
} from "../../imports/operator.victoriametrics.com";

export const SEND_TO_TELEGRAM = {
  push_notify: "true",
};

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
            rules: props.rules,
          },
        ],
      },
    });
  }
}
