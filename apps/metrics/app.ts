import { basename } from "path";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { NewHelmApp } from "../../lib/helm";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { App } from "cdk8s";
import { VmResources } from "./vmresources";
import { ScrapeConfigs } from "./scrapeconfigs";
import { BlackboxExporter } from "./blackbox";
import { ProxmoxExporter } from "./proxmox";
import { SnmpExporter } from "./snmp";
import { UnifiExporter } from "./unifi";
import { addAlerts } from "./alerts";

export const namespace = basename(__dirname);
export const name = namespace;
export const version = "0.30.2";
export const hostname = "metrics.cmdcentral.xyz";

NewHelmApp(
  name,
  {
    chart: "victoria-metrics-k8s-stack",
    repoUrl: "https://victoriametrics.github.io/helm-charts/",
    targetRevision: version,
  },
  {
    namespace: namespace,
    source: ArgoAppSource.GENERATORS,
    sync_policy: {
      automated: {
        prune: true,
        selfHeal: true,
      },
    },
  },
  {
    argocdReleaseOverride: "metrics",
    defaultDashboards: {
      defaultTimezone: "america/chicago",
      annotations: {
        "argocd.argoproj.io/sync-options": "ServerSideApply=true",
      },
    },
    "victoria-metrics-operator": {
      image: {
        registry: "docker.cmdcentral.net", // for operator itself
      },
      env: [
        {
          name: "VM_CONTAINERREGISTRY",
          value: "docker.cmdcentral.net",
        }, // for stuff deployed by operator
      ],
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
          cpu: "60m",
          memory: "32Mi",
        },
        limits: {
          cpu: "750m",
          memory: "96Mi",
        },
      },
      vmScrape: {
        enabled: true,
      },
    },
  },
);

const app = new App(DEFAULT_APP_PROPS(namespace));
NewArgoApp(`${name}-config`, {
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

new BlackboxExporter(app, "blackbox");
new ProxmoxExporter(app, "proxmox");
new ScrapeConfigs(app, "scrapes");
new SnmpExporter(app, "snmp");
new UnifiExporter(app, "unifi");
new VmResources(app, "resources");

addAlerts(app, "alerts");

app.synth();
