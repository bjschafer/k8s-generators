import { Chart, Size, Yaml } from "cdk8s";
import { Construct } from "constructs";
import { namespace } from "./app";
import { DEFAULT_SECURITY_CONTEXT, RELOADER_ENABLED } from "../../lib/consts";
import {
  ConfigMap,
  Cpu,
  Deployment,
  DeploymentStrategy,
  DnsPolicy,
  Env,
  ImagePullPolicy,
  Probe,
  Secret,
  Volume,
} from "cdk8s-plus-31";
import { VmProbe } from "../../imports/operator.victoriametrics.com";

const name = "proxmox-exporter";
const labels = {
  app: name,
};
const port = 9221;

export class ProxmoxExporter extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const deploy = new Deployment(this, "proxmox-deployment", {
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
          image: "prompve/prometheus-pve-exporter",
          imagePullPolicy: ImagePullPolicy.ALWAYS,
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
          liveness: Probe.fromHttpGet("/", {
            port: port,
          }),
          readiness: Probe.fromHttpGet("/", {
            port: port,
          }),
        },
      ],
    });

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

    const cm_vol = Volume.fromConfigMap(this, "cm-vol", cm);
    deploy.addVolume(cm_vol);
    deploy.containers[0].mount("/etc/pve.yml", cm_vol, {
      subPath: "pve.yml",
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

    new VmProbe(this, "probe", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        jobName: "proxmox",
        vmProberSpec: {
          url: `${svc.name}:${port}`,
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
                replacement: `${svc.name}:${port}`,
                action: "replace",
              },
            ],
          },
        },
      },
    });
  }
}
