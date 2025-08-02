import { App, Chart, Helm } from "cdk8s";
import { basename } from "path";
import {
  CLUSTER_ISSUER,
  DEFAULT_APP_PROPS,
  EXTERNAL_DNS_ANNOTATION_KEY,
} from "../../lib/consts";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { Construct } from "constructs";
import { StorageClass } from "../../lib/volume";
import {
  VmAlert,
  VmPodScrape,
  VmServiceScrape,
} from "../../imports/operator.victoriametrics.com";
import { IntOrString, KubeService } from "../../imports/k8s";
import { LOGS_RULE } from "../../lib/monitoring/alerts";
import { addAlerts } from "./alerts";

export const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const version = "0.11.5";

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.GENERATORS,
  recurse: true,
});

class VMLogs extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const hostname =
      "http://prod-victoria-logs-single-server.logs.svc.cluster.local:9428";

    new Helm(this, "vmlogs", {
      chart: "victoria-logs-single",
      repo: "https://victoriametrics.github.io/helm-charts/",
      version: version,
      releaseName: "prod",
      namespace: namespace,
      values: {
        server: {
          extraArgs: {
            maxConcurrentInserts: "32",
            "syslog.listenAddr.tcp": ":1514",
            "syslog.listenAddr.udp": ":1514",
            "syslog.timezone": "America/Chicago",
            "memory.allowedPercent": "80", // https://docs.victoriametrics.com/vmagent/#troubleshooting
          },
          retentionPeriod: "3", // months
          retentionDiskSpaceUsage: "75GiB",
          persistentVolume: {
            enabled: true,
            storageClassName: StorageClass.CEPH_RBD,
            size: "80Gi",
          },
          resources: {
            limits: {
              cpu: "1200m",
              memory: "3Gi",
            },
            requests: {
              cpu: "400m",
              memory: "3Gi",
            },
          },
          ingress: {
            enabled: true,
            annotations: {
              "cert-manager.io/cluster-issuer": CLUSTER_ISSUER.name,
            },
            hosts: [
              {
                name: "logs.cmdcentral.xyz",
                path: ["/"],
                port: "http",
              },
            ],
            tls: [
              {
                secretName: "logs-ingress-tls",
                hosts: ["logs.cmdcentral.xyz"],
              },
            ],
          },
        },

        vector: {
          enabled: true,
          resources: {
            limits: {
              cpu: "400m",
              memory: "768Mi",
            },
            requests: {
              cpu: "250m",
              memory: "128Mi",
            },
          },
          customConfig: {
            sinks: {
              vlogs: {
                endpoints: [`${hostname}/insert/elasticsearch`],
              },
            },
          },
          tolerations: [
            {
              effect: "NoSchedule",
              key: "node-role.kubernetes.io/master",
              operator: "Exists",
            },
            {
              effect: "NoSchedule",
              key: "node-role.kubernetes.io/control-plane",
              operator: "Exists",
            },
            {
              effect: "NoExecute",
              key: "k3s-controlplane",
              operator: "Exists",
            },
            {
              effect: "NoExecute",
              key: "node.kubernetes.io/not-ready",
              operator: "Exists",
            },
            {
              effect: "NoExecute",
              key: "node.kubernetes.io/unreachable",
              operator: "Exists",
            },
            {
              effect: "NoSchedule",
              key: "node.kubernetes.io/disk-pressure",
              operator: "Exists",
            },
            {
              effect: "NoSchedule",
              key: "node.kubernetes.io/memory-pressure",
              operator: "Exists",
            },
            {
              effect: "NoSchedule",
              key: "node.kubernetes.io/pid-pressure",
              operator: "Exists",
            },
            {
              effect: "NoSchedule",
              key: "node.kubernetes.io/unschedulable",
              operator: "Exists",
            },
          ],
        },
      },
    });

    new KubeService(this, "syslog", {
      metadata: {
        name: "syslog",
        namespace: namespace,
        annotations: {
          [EXTERNAL_DNS_ANNOTATION_KEY]: "syslog.cmdcentral.xyz",
        },
      },
      spec: {
        type: "LoadBalancer",
        ports: [
          {
            name: "tcp",
            port: 514,
            targetPort: IntOrString.fromNumber(1514),
            protocol: "TCP",
          },
          {
            name: "udp",
            port: 514,
            targetPort: IntOrString.fromNumber(1514),
            protocol: "UDP",
          },
        ],
        selector: {
          app: "server",
          "app.kubernetes.io/instance": "prod",
          "app.kubernetes.io/name": "victoria-logs-single",
        },
      },
    });

    new VmServiceScrape(this, "servicescrape", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            app: "server",
            "app.kubernetes.io/name": "victoria-logs-single",
          },
        },
        endpoints: [
          {
            port: "http",
          },
        ],
      },
    });

    new VmPodScrape(this, "vector-podmonitor", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            "app.kubernetes.io/name": "vector",
            "app.kubernetes.io/instance": "prod",
          },
        },
        podMetricsEndpoints: [{ port: "prom-exporter" }],
      },
    });

    new VmAlert(this, "alert", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        datasource: {
          url: hostname,
        },
        notifiers: [
          {
            url: "http://vmalertmanager-metrics.metrics.svc.cluster.local.:9093",
          },
        ],
        remoteRead: {
          url: "http://vmsingle-metrics.metrics.svc.cluster.local.:8429",
        },
        remoteWrite: {
          url: "http://vmsingle-metrics.metrics.svc.cluster.local.:8429",
        },
        ruleSelector: {
          matchLabels: LOGS_RULE,
        },
        extraArgs: { "rule.defaultRuleType": "vlogs" },
      },
    });
  }
}

addAlerts(app, "alerts");

new VMLogs(app, "vm-logs");
app.synth();
