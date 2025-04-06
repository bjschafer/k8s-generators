import { Chart, Size } from "cdk8s";
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
  EnvValue,
  ImagePullPolicy,
  Probe,
  ResourceFieldPaths,
  Secret,
  Volume,
} from "cdk8s-plus-32";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import heredoc from "tsheredoc";

const name = "unifi-exporter";
const labels = {
  app: name,
};
const port = 9130;

export class UnifiExporter extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const deploy = new Deployment(this, "unifi-deployment", {
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
          image: "ghcr.io/unpoller/unpoller:latest",
          imagePullPolicy: ImagePullPolicy.ALWAYS,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          envVariables: {
            GOMAXPROCS: EnvValue.fromResource(ResourceFieldPaths.CPU_LIMIT),
            GOMEMLIMIT: EnvValue.fromResource(ResourceFieldPaths.MEMORY_LIMIT),
          },
          envFrom: [
            Env.fromSecret(
              Secret.fromSecretName(this, "unifi-secrets", "unifi-creds"),
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
              request: Cpu.millis(100),
              limit: Cpu.millis(1000),
            },
            memory: {
              request: Size.mebibytes(96),
              limit: Size.mebibytes(256),
            },
          },
          liveness: Probe.fromHttpGet("/health", {
            port: port,
          }),
          readiness: Probe.fromHttpGet("/health", {
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
        "up.conf": heredoc`
        [prometheus]
          disable = false
          http_listen = "0.0.0.0:9130"
          report_errors = false

        [influxdb]
          disable = true

        [unifi]
          dynamic = false

        [unifi.defaults]
          url = "https://10.0.10.1"
          user = "unifipoller"
          # pass in secret

          sites = ["all"]
          save_ids = true
          save_dpi = true
          save_events = true
          save_alarms = true
          save_anomalies = true
          hash_pii = false
          verify_ssl = false

        [loki]
          url = "https://loki.cmdcentral.xyz"
        `,
      },
    });

    const cm_vol = Volume.fromConfigMap(this, "cm-vol", cm);
    deploy.addVolume(cm_vol);
    deploy.containers[0].mount("/etc/unpoller/up.conf", cm_vol, {
      subPath: "up.conf",
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

    new VmServiceScrape(this, "scrape", {
      metadata: {
        name: name,
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
  }
}
