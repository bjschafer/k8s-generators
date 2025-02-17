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
  ImagePullPolicy,
  Probe,
  Volume,
} from "cdk8s-plus-31";
import {
  VmProbe,
  VmServiceScrape,
} from "../../imports/operator.victoriametrics.com";
import { Alert, SEND_TO_TELEGRAM } from "../../lib/monitoring/alerts";

const name = "blackbox-exporter";
const labels = {
  app: name,
};
const port = 9115;

export class BlackboxExporter extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const deploy = new Deployment(this, "bb-deployment", {
      metadata: {
        name: name,
        namespace: namespace,
        labels: {
          ...labels,
        },
        annotations: {
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
          image: "quay.io/prometheus/blackbox-exporter:latest",
          imagePullPolicy: ImagePullPolicy.ALWAYS,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          args: ["--config.file=/config/blackbox.yaml"],
          ports: [
            {
              name: "metrics",
              number: port,
            },
          ],
          resources: {
            cpu: {
              request: Cpu.millis(100),
              limit: Cpu.millis(200),
            },
            memory: {
              request: Size.mebibytes(32),
              limit: Size.mebibytes(64),
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
        name: "blackbox-config",
        namespace: namespace,
        labels: {
          ...labels,
        },
      },
      data: {
        "blackbox.yaml": Yaml.stringify({
          modules: {
            http_2xx: {
              prober: "http",
              http: {
                valid_http_versions: ["HTTP/1.1", "HTTP/2.0"],
                method: "GET",
                preferred_ip_protocol: "ip4",
                follow_redirects: true,
                enable_http2: true,
                tls_config: {
                  insecure_skip_verify: true,
                },
              },
            },
            http_post_2xx: {
              prober: "http",
              http: {
                method: "POST",
                tls_config: {
                  insecure_skip_verify: true,
                },
              },
            },
            tcp_connect: {
              prober: "tcp",
            },
            pop3s_banner: {
              prober: "tcp",
              tcp: {
                query_response: [
                  {
                    expect: "^+OK",
                  },
                ],
                tls: true,
              },
            },
            ssh_banner: {
              prober: "tcp",
              tcp: {
                query_response: [
                  {
                    expect: "^SSH-2.0-",
                  },
                  {
                    send: "SSH-2.0-blackbox-ssh-check",
                  },
                ],
              },
            },
            dns_udp: {
              prober: "dns",
              dns: {
                query_name: "gateway.cmdcentral.xyz",
              },
            },
            ping: {
              prober: "icmp",
              timeout: "5s",
              icmp: {
                preferred_ip_protocol: "ipv4",
              },
            },
          },
        }),
      },
    });

    const cm_vol = Volume.fromConfigMap(this, "cm-vol", cm);
    deploy.addVolume(cm_vol);
    deploy.containers[0].mount("/config", cm_vol);

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
        endpoints: [{ port: "metrics" }],
        selector: { matchLabels: { ...labels } },
      },
    });

    this.newBlackboxProbe("bgp", "http_2xx", ["https://vmhost.cmdcentral.xyz"]);

    this.newBlackboxProbe("dns", "dns_udp", ["10.0.10.100", "10.0.10.101"]);
    this.newBlackboxProbe("ping-dns", "ping", [
      "1.1.1.1",
      "8.8.8.8",
      "9.9.9.9",
      "208.67.222.222",
    ]);

    this.newBlackboxProbe("ping-lakelair", "ping", [
      "192.168.0.1", // gateway
      "192.168.0.3", // west-switch
    ]);

    this.newBlackboxProbe("ping-other", "ping", ["google.com"]);

    this.newBlackboxProbe("proxmox", "http_2xx", [
      "https://vmhost03.cmdcentral.xyz",
      "https://vmhost03.cmdcentral.xyz:8006",
      "https://vmhost03.cmdcentral.xyz:8007",
    ]);

    new Alert(this, "alerts", {
      name: name,
      namespace: namespace,
      rules: [
        {
          alert: "BlackboxDNSProbesFailing",
          expr: `probe_dns_query_succeeded < 1`,
          for: "15m",
          labels: {
            severity: "warning",
            ...SEND_TO_TELEGRAM,
          },
          annotations: {
            summary:
              "Blackbox DNS probes failing for 15 minutes for {{ $labels.instance }}",
          },
        },
        {
          alert: "BlackboxHTTPNotReturningSuccess",
          expr: `probe_http_status_code != 200`,
          for: "15m",
          labels: {
            severity: "warning",
            ...SEND_TO_TELEGRAM,
          },
          annotations: {
            summary:
              "Blackbox HTTP probes to {{ $labels.instance }} returning {{ $value }}",
          },
        },
      ],
    });
  }

  private newBlackboxProbe(
    probeName: string,
    module: blackbox_module,
    targets: string[],
  ) {
    new VmProbe(this, `probe-${probeName}`, {
      metadata: {
        name: probeName,
        namespace: namespace,
      },
      spec: {
        jobName: `blackbox-${probeName}`,
        vmProberSpec: {
          url: `${name}:${port}`,
          path: "/probe",
        },
        module: module,
        targets: {
          staticConfig: {
            targets: targets,
          },
        },
      },
    });
  }
}

type blackbox_module =
  | "http_2xx"
  | "http_post_2xx"
  | "tcp_connect"
  | "pop3s_banner"
  | "ssh_banner"
  | "dns_udp"
  | "ping";
