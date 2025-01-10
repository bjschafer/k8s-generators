import { App, Chart, Helm } from "cdk8s";
import { basename } from "path";
import { CLUSTER_ISSUER, DEFAULT_APP_PROPS } from "../../lib/consts";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { Construct } from "constructs";
import { StorageClass } from "../../lib/volume";
import {
  VmPodScrape,
  VmServiceScrape,
} from "../../imports/operator.victoriametrics.com";
import { IntOrString, KubeService } from "../../imports/k8s";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

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

    new Helm(this, "vmlogs", {
      chart: "victoria-logs-single",
      repo: "https://victoriametrics.github.io/helm-charts/",
      releaseName: "prod",
      namespace: namespace,
      values: {
        server: {
          extraArgs: {
            maxConcurrentInserts: "32",
            "syslog.listenAddr.tcp": ":1514",
            "syslog.listenAddr.udp": ":1514",
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
              memory: "2Gi",
            },
            requests: {
              cpu: "400m",
              memory: "1Gi",
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
              memory: "512Mi",
            },
            requests: {
              cpu: "50m",
              memory: "128Mi",
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
          "external-dns.alpha.kubernetes.io/hostname": "syslog.cmdcentral.xyz",
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
  }
}

new VMLogs(app, "vm-logs");
app.synth();
