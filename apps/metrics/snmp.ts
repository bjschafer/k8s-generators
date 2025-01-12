import { Chart, Size } from "cdk8s";
import { Construct } from "constructs";
import { namespace } from "./app";
import { DEFAULT_SECURITY_CONTEXT, RELOADER_ENABLED } from "../../lib/consts";
import {
  Cpu,
  Deployment,
  DeploymentStrategy,
  DnsPolicy,
  Env,
  Secret,
} from "cdk8s-plus-31";
import { VmScrapeConfig } from "../../imports/operator.victoriametrics.com";

const name = "snmp-exporter";
const labels = {
  app: name,
};
const port = 9116;

export class SnmpExporter extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const deploy = new Deployment(this, "snmp-deployment", {
      metadata: {
        name: name,
        namespace: namespace,
        labels: {
          ...labels,
        },
        annotatations: {
          ...RELOADER_ENABLED,
        },
      },
      replicas: 1,
      strategy: DeploymentStrategy.recreate(),
      securityContext: DEFAULT_SECURITY_CONTEXT,
      dns: {
        policy: DnsPolicy.NONE,
        nameservers: ["10.0.10.100", "10.0.10.101"],
        searches: ["cmdcentral.xyz"],
      },
      containers: [
        {
          name: name,
          image: "quay.io/prometheus/snmp-exporter",
          securityContext: DEFAULT_SECURITY_CONTEXT,
          envFrom: [
            Env.fromSecret(
              Secret.fromSecretName(
                this,
                "proxmox-secrets",
                "proxmox-exporter",
              ),
            ),
          ],
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
        },
      ],
    });

    const svc = deploy.exposeViaService({
      name: name,
      ports: [
        {
          name: "metrics",
          targetPort: port,
          port: port,
        },
      ],
    });
    svc.metadata.addLabel("app", name);

    new VmScrapeConfig(this, "probe", {
      metadata: {
        name: "snmp",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["sw01.cmdcentral.xyz", "sw02.cmdcentral.xyz"],
            labels: { job: "snmp" },
          },
        ],
        path: "/snmp",
        relabelConfigs: [
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
            replacement: `${svc.name}:${port}`,
            action: "replace",
          },
        ],
      },
    });
  }
}
