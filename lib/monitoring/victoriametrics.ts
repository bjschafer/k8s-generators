import { Chart } from "cdk8s";
import {
  VmServiceScrape,
  VmServiceScrapeSpec,
} from "../../imports/operator.victoriametrics.com";
import { Construct } from "constructs";

export interface CmdcentralServiceMonitorProps {
  name: string;
  namespace: string;
  matchLabels: { [key: string]: string };
  extraConfig?: Partial<VmServiceScrapeSpec>;
}

export class CmdcentralServiceMonitor extends Chart {
  constructor(
    scope: Construct,
    id: string,
    props: CmdcentralServiceMonitorProps,
  ) {
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
        endpoints: [{ port: "metrics" }],
        selector: {
          matchLabels: props.matchLabels,
        },
        ...props.extraConfig,
      },
    });
  }
}
