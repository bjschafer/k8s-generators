import { basename } from "path";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { StorageClass } from "../../lib/volume";
import { NewHelmApp } from "../../lib/helm";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { VmScrapeConfig } from "../../imports/operator.victoriametrics.com";

const namespace = basename(__dirname);
const name = namespace;
const version = "0.30.2";
const hostname = "metrics.cmdcentral.xyz";

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
      enabled: true,
      spec: {
        replicaCount: 1, // This'll set replicas=n on deployment, so you run into PVC multi-attach errors
        retentionPeriod: "90d",
        storage: {
          storageClassName: StorageClass.CEPH_RBD,
          resources: {
            requests: {
              storage: "80Gi",
            },
          },
        },
      },
      ingress: {
        enabled: true,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt",
        },
        hosts: [hostname],
        tls: [
          {
            secretName: "metrics-tls",
            hosts: [hostname],
          },
        ],
      },
    },
    vmagent: {
      spec: {
        resources: {
          limits: {
            memory: "1Gi",
            cpu: "500m",
          },
          requests: {
            memory: "384Mi",
            cpu: "200m",
          },
        },
      },
    },
    alertmanager: {
      ingress: {
        enabled: true,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt",
        },
        hosts: ["metrics-alerts.cmdcentral.xyz"],
        tls: [
          {
            secretName: "alertmanager-tls",
            hosts: ["metrics-alerts.cmdcentral.xyz"],
          },
        ],
      },
      spec: {
        externalUrl: "https://alertmanager.cmdcentral.xyz",
        resources: {
          requests: {
            memory: "256Mi",
          },
          limits: {
            memory: "256Mi",
          },
        },
      },
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
    "prometheus-node-exporter": {
      enabled: false, // for now
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

class ScrapeConfigs extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new VmScrapeConfig(this, "ceph", {
      metadata: {
        name: "ceph",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["vmhost03.cmdcentral.xyz:9283"],
            labels: { job: "ceph" },
          },
        ],
      },
    });
  }
}

new ScrapeConfigs(app, "scrapes");

app.synth();
