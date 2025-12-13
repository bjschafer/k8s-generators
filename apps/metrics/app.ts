import { App } from "cdk8s";
import { basename } from "path";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { addAlerts } from "./alerts";
import { BlackboxExporter } from "./blackbox";
import { ProxmoxExporter } from "./proxmox";
import { ScrapeConfigs } from "./scrapeconfigs";
import { UnifiExporter } from "./unifi";
import { VmResources } from "./vmresources";

export const namespace = basename(__dirname);
export const name = namespace;
export const version = "0.65.1";
export const hostname = "metrics.cmdcentral.xyz";

const app = new App(DEFAULT_APP_PROPS(namespace));
NewArgoApp(`${name}`, {
  namespace: namespace,
  directoryName: namespace,
});

new HelmApp(app, "stack", {
  chart: "victoria-metrics-k8s-stack",
  repo: "https://victoriametrics.github.io/helm-charts/",
  releaseName: name,
  namespace: namespace,
  version: version,
  values: {
    argocdReleaseOverride: "metrics",
    "victoria-metrics-operator": {
      admissionWebhooks: {
        certManager: {
          enabled: true,
          issuer: {
            kind: "ClusterIssuer",
            name: "webhook-selfsigned",
          },
        },
      },
    },
    defaultDashboards: {
      defaultTimezone: "america/chicago",
      annotations: {
        "argocd.argoproj.io/sync-options": "ServerSideApply=true",
      },
    },
    defaultRules: {
      groups: {
        // k3s doesn't run kube-scheduler
        kubeScheduler: {
          create: false,
        },
        // k3s doesn't run kube-scheduler
        kubernetesSystemScheduler: {
          create: false,
        },
        // k3s doesn't run controller-manager
        kubernetesSystemControllerManager: {
          create: false,
        },
        kubeStateMetrics: {
          create: false,
        },
        kubernetesApps: {
          create: false,
        },
      },
      labels: {
        "alerts.cmdcentral.xyz/kind": "metrics",
      },
    },
    vmsingle: {
      enabled: false,
    },
    vmagent: {
      enabled: false,
    },
    vmalert: {
      enabled: false,
    },
    alertmanager: {
      enabled: false,
    },
    grafana: {
      enabled: false,
      ingress: {
        enabled: false,
        hosts: ["grafana.cmdcentral.xyz"], // ensures links to dashboards are correct
      },
    },
    kubeControllerManager: {
      enabled: false,
    },
    kubeScheduler: {
      enabled: false,
    },
    kubeEtcd: {
      enabled: false,
    },
    kubelet: {
      vmScrape: {
        metricRelabelConfigs: [
          {
            action: "labeldrop",
            regex: "(plan_upgrade_cattle_io.*)",
          },
          {
            action: "labeldrop",
            regex: "(beta_kubernetes_io.*)",
          },
        ],
      },
    },
    "prometheus-node-exporter": {
      fullnameOverride: "node-exporter",
      tolerations: [
        {
          effect: "NoSchedule",
          operator: "Exists",
        },
        {
          key: "k3s-controlplane",
          effect: "NoExecute",
          operator: "Exists",
        },
      ],
      extraArgs: [
        // first two are default
        "--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|var/lib/docker/.+|var/lib/kubelet/.+)($|/)",
        "--collector.filesystem.fs-types-exclude=^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|procfs|pstore|rpc_pipefs|securityfs|selinuxfs|squashfs|sysfs|tracefs)$",
        "--collector.netdev.address-info",
      ],
      resources: {
        requests: {
          cpu: "250m",
          memory: "32Mi",
        },
        limits: {
          cpu: "1",
          memory: "96Mi",
        },
      },
      vmScrape: {
        enabled: false, // we'll manually do this, too
      },
    },
  },
});

new BlackboxExporter(app, "blackbox");
new ProxmoxExporter(app, "proxmox");
new ScrapeConfigs(app, "scrapes");
new UnifiExporter(app, "unifi");
new VmResources(app, "resources");

addAlerts(app, "alerts");

app.synth();
