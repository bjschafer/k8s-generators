import { App, Chart, Helm } from "cdk8s";
import { KubeIngress } from "../../imports/k8s";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { Construct } from "constructs";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import { Alert, SEND_TO_TELEGRAM } from "../../lib/monitoring/alerts";

const namespace = "longhorn-system";
const name = "longhorn";
const app = new App(DEFAULT_APP_PROPS(name));

NewArgoApp(name, {
  namespace: namespace,
  recurse: true,
});

class Longhorn extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Helm(this, "longhorn", {
      chart: "longhorn",
      repo: "https://charts.longhorn.io",
      version: "1.8.0",
      releaseName: name,
      namespace: namespace,
      values: {
        preUpgradeChecker: {
          jobEnabled: false,
        },
        longhornManager: {
          log: {
            format: "json",
          },
        },
        defaultSettings: {
          defaultDataLocality: "best-effort",
        },
        persistence: {
          defaultDataLocality: "best-effort",
        },
      },
    });

    new KubeIngress(this, "longhorn-ui", {
      metadata: {
        name: "longhorn-ui",
        namespace: namespace,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt",
        },
      },
      spec: {
        rules: [
          {
            host: "longhorn.cmdcentral.xyz",
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "longhorn-frontend",
                      port: {
                        number: 80,
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
        tls: [
          {
            secretName: "longhorn-tls",
            hosts: ["longhorn.cmdcentral.xyz"],
          },
        ],
      },
    });

    new VmServiceScrape(this, "servicescrape", {
      metadata: {
        name: "longhorn",
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            app: "longhorn-manager",
          },
        },
        endpoints: [
          {
            port: "manager",
          },
        ],
      },
    });

    new Alert(this, `${id}-alerts`, {
      name: "alerts",
      namespace: namespace,
      rules: [
        {
          alert: "LonghornVolumeStatusCritical",
          annotations: {
            description:
              "Longhorn volume {{$labels.volume}} on {{$labels.node}} is Fault for more than 2 minutes.",
            summary: "Longhorn volume {{$labels.volume}} is Fault",
          },
          expr: "longhorn_volume_robustness == 3",
          for: "5m",
          labels: {
            issue: "Longhorn volume {{$labels.volume}} is Fault.",
            severity: "critical",
            ...SEND_TO_TELEGRAM,
          },
        },
        {
          alert: "LonghornVolumeStatusWarning",
          annotations: {
            description:
              "Longhorn volume {{$labels.volume}} on {{$labels.node}} is Degraded for more than 5 minutes.",
            summary: "Longhorn volume {{$labels.volume}} is Degraded",
          },
          expr: "longhorn_volume_robustness == 2",
          for: "5m",
          labels: {
            issue: "Longhorn volume {{$labels.volume}} is Degraded.",
            severity: "warning",
          },
        },
        {
          alert: "LonghornNodeStorageWarning",
          annotations: {
            description:
              "The used storage of node {{$labels.node}} is at {{$value}}% capacity for more than 5 minutes.",
            summary: "The used storage of node is over 70% of the capacity.",
          },
          expr: "(longhorn_node_storage_usage_bytes / longhorn_node_storage_capacity_bytes) * 100 > 70",
          for: "5m",
          labels: {
            issue: "The used storage of node {{$labels.node}} is high.",
            severity: "warning",
          },
        },
        {
          alert: "LonghornDiskStorageWarning",
          annotations: {
            description:
              "The used storage of disk {{$labels.disk}} on node {{$labels.node}} is at {{$value}}% capacity for more than 5 minutes.",
            summary: "The used storage of disk is over 70% of the capacity.",
          },
          expr: "(longhorn_disk_usage_bytes / longhorn_disk_capacity_bytes) * 100 > 70",
          for: "5m",
          labels: {
            issue:
              "The used storage of disk {{$labels.disk}} on node {{$labels.node}} is high.",
            severity: "warning",
          },
        },
        {
          alert: "LonghornNodeDown",
          annotations: {
            description:
              "There are {{$value}} Longhorn nodes which have been offline for more than 5 minutes.",
            summary: "Longhorn nodes is offline",
          },
          expr: '(avg(longhorn_node_count_total) or on() vector(0)) - (count(longhorn_node_status{condition="ready"} == 1) or on() vector(0)) > 0',
          for: "5m",
          labels: {
            issue: "There are {{$value}} Longhorn nodes are offline",
            severity: "critical",
          },
        },
        {
          alert: "LonghornInstanceManagerCPUUsageWarning",
          annotations: {
            description:
              "Longhorn instance manager {{$labels.instance_manager}} on {{$labels.node}} has CPU Usage / CPU request is {{$value}}% for more than 5 minutes.",
            summary:
              "Longhorn instance manager {{$labels.instance_manager}} on {{$labels.node}} has CPU Usage / CPU request is over 300%.",
          },
          expr: "(longhorn_instance_manager_cpu_usage_millicpu/longhorn_instance_manager_cpu_requests_millicpu) * 100 > 300",
          for: "5m",
          labels: {
            issue:
              "Longhorn instance manager {{$labels.instance_manager}} on {{$labels.node}} consumes 3 times the CPU request.",
            severity: "warning",
          },
        },
        {
          alert: "LonghornNodeCPUUsageWarning",
          annotations: {
            description:
              "Longhorn node {{$labels.node}} has CPU Usage / CPU capacity is {{$value}}% for more than 5 minutes.",
            summary:
              "Longhorn node {{$labels.node}} experiences high CPU pressure for more than 5m.",
          },
          expr: "(longhorn_node_cpu_usage_millicpu / longhorn_node_cpu_capacity_millicpu) * 100 > 90",
          for: "5m",
          labels: {
            issue:
              "Longhorn node {{$labels.node}} experiences high CPU pressure.",
            severity: "warning",
          },
        },
      ],
    });
  }
}
new Longhorn(app, "longhorn");

app.synth();
