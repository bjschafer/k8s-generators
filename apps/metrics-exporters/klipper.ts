import { Chart, Size } from "cdk8s";
import { Cpu } from "cdk8s-plus-33";
import { Construct } from "constructs";
import {
  VmProbe,
  VmServiceScrape,
} from "../../imports/operator.victoriametrics.com";
import { AppPlus } from "../../lib/app-plus";
import { DNS_POLICY_NONE } from "../../lib/consts";
import { namespace } from "./app";

const name = "klipper-exporter";
const labels = {
  app: name,
};
const port = 9101;

const klipper_hosts = [
  "pandora.cmdcentral.xyz:7125",
  "trident.cmdcentral.xyz:7125",
];

export class KlipperExporter extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const app = new AppPlus(this, "klipper-app", {
      name: name,
      namespace: namespace,
      labels: labels,
      image: "ghcr.io/scross01/prometheus-klipper-exporter",
      ports: [
        {
          name: "metrics",
          number: port,
        },
      ],
      resources: {
        cpu: {
          request: Cpu.millis(50),
          limit: Cpu.millis(500),
        },
        memory: {
          request: Size.mebibytes(32),
          limit: Size.mebibytes(64),
        },
      },
      dns: DNS_POLICY_NONE,
      disableIngress: true,
    });

    // self-metrics
    new VmServiceScrape(this, "scrape", {
      metadata: {
        name: `${name}-self`,
        namespace: namespace,
      },
      spec: {
        namespaceSelector: {
          matchNames: [namespace],
        },
        selector: {
          matchLabels: {
            ...labels,
          },
        },
        endpoints: [
          {
            port: "metrics",
          },
        ],
      },
    });

    new VmProbe(this, "probe", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        jobName: "klipper",
        vmProberSpec: {
          url: `${app.Service.name}.${namespace}.svc.cluster.local:${port}`,
          path: "/probe",
        },
        params: {
          modules: [
            "process_stats",
            "job_queue",
            "system_info",
            "printer_objects",
            "history",
          ],
        },
        targets: {
          staticConfig: {
            targets: klipper_hosts,
            relabelingConfigs: [
              {
                sourceLabels: ["__address__"],
                targetLabel: "__param_target",
                action: "replace",
              },
              {
                sourceLabels: ["__param_target"],
                targetLabel: "instance",
                action: "replace",
              },
              {
                targetLabel: "__address__",
                replacement: `${app.Service.name}:${port}`,
                action: "replace",
              },
            ],
          },
        },
      },
    });
  }
}
