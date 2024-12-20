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
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";

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
          liveness: Probe.fromTcpSocket({ port }),
          readiness: Probe.fromTcpSocket({ port }),
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
  }
}

/*
---
          volumeMounts:
            - name: config
              mountPath: /config
      volumes:
        - name: config
          configMap:
            name: blackbox-config
...
---
apiVersion: v1
kind: Service
metadata:
  name: blackbox-exporter
  namespace: prometheus
  labels:
    app: blackbox-exporter
spec:
  selector:
    app: blackbox-exporter
  ports:
    - name: metrics
      port: 9115
      protocol: TCP
      targetPort: 9115
...
---
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: blackbox-exporter-self-metrics
  namespace: prometheus
  labels:
    release: prometheus-kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
      - prometheus
  selector:
    matchLabels:
      app: blackbox-exporter
  podMetricsEndpoints:
  - port: metrics
...
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: blackbox-config
  namespace: prometheus
  labels:
    app: blackbox-exporter
data:
  blackbox.yaml: |
    modules:
      http_2xx:
        prober: http
        http:
          valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
          method: GET
          preferred_ip_protocol: "ip4"
          follow_redirects: true
          enable_http2: true
          tls_config:
            insecure_skip_verify: true
      http_post_2xx:
        prober: http
        http:
          method: POST
          tls_config:
            insecure_skip_verify: true
      tcp_connect:
        prober: tcp
      pop3s_banner:
        prober: tcp
        tcp:
          query_response:
          - expect: "^+OK"
          tls: true
      ssh_banner:
        prober: tcp
        tcp:
          query_response:
          - expect: "^SSH-2.0-"
          - send: "SSH-2.0-blackbox-ssh-check"
      dns_udp:
        prober: dns
        dns:
          query_name: "gateway.cmdcentral.xyz"
      ping:
        prober: icmp
        timeout: 5s
        icmp:
          preferred_ip_protocol: "ipv4"
...

*/
