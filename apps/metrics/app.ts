import { App } from "cdk8s";
import { basename } from "path";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { BitwardenSecret } from "../../lib/secrets";
import { addAlerts } from "./alerts";
import { BlackboxExporter } from "./blackbox";
import { ScrapeConfigs } from "./scrapeconfigs";
import { VmResources } from "./vmresources";

export const namespace = basename(__dirname);
export const name = namespace;
// renovate: datasource=docker depName=ghcr.io/victoriametrics/helm-charts/victoria-metrics-k8s-stack
export const version = "0.91.2";
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
      extraArgs: {
        "controller.disableReconcileFor":
          "PrometheusRule,ScrapeConfig,ServiceMonitor,PodMonitor,AlertmanagerConfig,Probe",
        // Defaults (15s/10s) are too tight when etcd stalls under Velero backup
        // load: the operator loses its lease and exits 1. Renewal now gets 45s
        // of retries. Must keep renew-deadline < lease-duration.
        "leader-elect-lease-duration": "60s",
        "leader-elect-renew-deadline": "45s",
      },
    },
    "kube-state-metrics": {
      // /livez proxies a call to the apiserver, so an apiserver stall kills KSM
      // even though KSM itself is healthy — and restarting it fixes nothing.
      // 12 x 10s tolerates 2min of apiserver unavailability before a restart.
      livenessProbe: {
        failureThreshold: 12,
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
        // group names must match victoria-metrics-k8s-stack's default rule
        // group keys exactly (hyphenated, not camelCase) or the disable is a no-op
        "kube-scheduler.rules": {
          create: false,
        },
        // k3s doesn't run kube-scheduler
        "kubernetes-system-scheduler": {
          create: false,
        },
        // k3s doesn't run controller-manager
        "kubernetes-system-controller-manager": {
          create: false,
        },
        "kube-state-metrics": {
          create: false,
        },
        // duplicates our own KubernetesPod*/KubernetesDaemonset*/KubernetesStatefulset*
        // alerts in alerts.ts
        "kubernetes-apps": {
          create: false,
        },
        // duplicates our own KubernetesVolumeOutOfDiskSpace/KubernetesPersistentvolumeError
        "kubernetes-storage": {
          create: false,
        },
        // duplicates our own KubernetesPodCpuThrottling
        "kubernetes-resources": {
          create: false,
        },
        // Permanently firing since 2026-08-24 and 100% attributable to one benign
        // client. CNPG's instance manager readiness-probes its own Cluster every 10s
        // with a hardcoded ~500ms deadline (not .spec.probes.readiness.timeoutSeconds,
        // which is the kubelet->manager hop); ~6% of those quorum reads now miss it
        // because dropping cache=unsafe took apiserver->etcd read p99 from ~45ms to
        // ~1.3s. The client cancels, the handler finishes ~3ms late, and the apiserver
        // books it as a 500. CNPG catches this and falls back to its cached Cluster
        // definition, so nothing is degraded -- and the latency is the honest
        // sync-write floor of these disks, not something software can tune away.
        //
        // Excluding that one client leaves *zero* 5xx on the apiserver, so this group
        // measures nothing else, and our own KubernetesApiServerErrors (fires at 3% of
        // all requests; currently 0.2%) still catches a genuinely broken apiserver.
        // Only the alert group goes -- kube-apiserver-{burnrate,availability,histogram}
        // .rules stay, because the Grafana apiserver dashboards read them.
        "kube-apiserver-slos": {
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
        "--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|var/lib/docker/.+|var/lib/kubelet/pods/.+)($|/)",
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

// referenced by name in vmresources.ts (alertmanager receivers)
new BitwardenSecret(app, "alertmanager-secrets", {
  name: "alertmanager-secrets",
  namespace: namespace,
  data: {
    email_pass: "b4144e49-f4cf-4ce3-bc9b-b47e01821aa9",
    pushover_token: "e2f31a93-29fb-4984-8634-b47e01821aec",
    pushover_user_key: "480c76dd-7b5e-4199-becb-b47e01821b15",
    telegram_bot_token: "2a9a2416-f4ff-4256-8637-b47e01821b48",
  },
});

// referenced by name in scrapeconfigs.ts (hass bearer auth)
new BitwardenSecret(app, "hass-bearer-token", {
  name: "hass-bearer-token",
  namespace: namespace,
  data: {
    token: "3e00741c-1684-494d-a5f3-b47e01821c2b",
  },
});

new BlackboxExporter(app, "blackbox");
new ScrapeConfigs(app, "scrapes");
new VmResources(app, "resources");

addAlerts(app, "alerts");

app.synth();
