import { Chart, Size } from "cdk8s";
import {
  ConfigMap,
  Cpu,
  EnvValue,
  Probe,
  ResourceFieldPaths,
} from "cdk8s-plus-33";
import { Construct } from "constructs";
import heredoc from "tsheredoc";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import { AppPlus } from "../../lib/app-plus";
import { DNS_POLICY_NONE, RELOADER_ENABLED } from "../../lib/consts";
import { BitwardenSecret } from "../../lib/secrets";
import { namespace } from "./app";

const name = "unifi-exporter";
const labels = {
  app: name,
};
const port = 9130;

export class UnifiExporter extends Chart {
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
        `,
      },
    });

    const secrets = new BitwardenSecret(this, "unifi-secrets", {
      name: name,
      namespace: namespace,
      data: {
        UP_UNIFI_DEFAULT_PASS: "630a6f72-fe9c-4d32-9273-b3c40165eddf",
      },
    });

    new AppPlus(this, "unifi-app", {
      name: name,
      namespace: namespace,
      labels: labels,
      annotations: RELOADER_ENABLED,
      image: "ghcr.io/unpoller/unpoller:latest",
      ports: [{
        name: "metrics",
        number: port,
      }],
      extraEnv: {
        GOMAXPROCS: EnvValue.fromResource(ResourceFieldPaths.CPU_LIMIT),
        GOMEMLIMIT: EnvValue.fromResource(ResourceFieldPaths.MEMORY_LIMIT),
        ...secrets.toEnvValues(),
      },
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
      livenessProbe: Probe.fromHttpGet("/health", {
        port: port,
      }),
      readinessProbe: Probe.fromHttpGet("/health", {
        port: port,
      }),
      configmapMounts: [
        {
          name: cm.name,
          mountPath: "/etc/unpoller/up.conf",
          subPath: "up.conf",
        },
      ],
      dns: DNS_POLICY_NONE,
      disableIngress: true,
    });

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
