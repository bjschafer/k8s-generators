import { Chart, Size, Yaml } from "cdk8s";
import { ConfigMap, Cpu, EnvValue, Probe } from "cdk8s-plus-33";
import { Construct } from "constructs";
import { VmProbe } from "../../imports/operator.victoriametrics.com";
import { AppPlus } from "../../lib/app-plus";
import { DNS_POLICY_NONE, RELOADER_ENABLED } from "../../lib/consts";
import { BitwardenSecret } from "../../lib/secrets";
import { namespace } from "./app";

const name = "proxmox-exporter";
const labels = {
  app: name,
};
const port = 9221;

export class ProxmoxExporter extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const cm = new ConfigMap(this, "config", {
      metadata: {
        name: name,
        namespace: namespace,
        labels: {
          ...labels,
        },
      },
      data: {
        "pve.yml": Yaml.stringify({
          default: {
            verify_ssl: true,
          },
        }),
      },
    });

    const secrets = new BitwardenSecret(this, "proxmox-secrets", {
      name: name,
      namespace: namespace,
      data: {
        PVE_TOKEN_VALUE: "d1c7fc87-8d90-465e-a004-b3c40166efa3",
      },
    });

    const app = new AppPlus(this, "proxmox-app", {
      name: name,
      namespace: namespace,
      labels: labels,
      annotations: RELOADER_ENABLED,
      image: "prompve/prometheus-pve-exporter",
      ports: [
        {
          name: "metrics",
          number: port,
        },
      ],
      extraEnv: {
        PVE_USER: EnvValue.fromValue("prometheus@pve"),
        PVE_TOKEN_NAME: EnvValue.fromValue("k8s"),
        ...secrets.toEnvValues(),
      },
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
      livenessProbe: Probe.fromHttpGet("/", {
        port: port,
      }),
      readinessProbe: Probe.fromHttpGet("/", {
        port: port,
      }),
      configmapMounts: [
        {
          name: cm.name,
          mountPath: "/etc/pve.yml",
          subPath: "pve.yml",
        },
      ],
      dns: DNS_POLICY_NONE,
      disableIngress: true,
    });

    new VmProbe(this, "probe", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        jobName: "proxmox",
        vmProberSpec: {
          url: `${app.Service.name}.${namespace}.svc.cluster.local:${port}`,
          path: "/pve",
        },
        targets: {
          staticConfig: {
            targets: ["vmhost.cmdcentral.xyz:443"],
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
