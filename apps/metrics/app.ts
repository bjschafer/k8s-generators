import { basename } from "path";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { StorageClass } from "../../lib/volume";
import { NewHelmApp } from "../../lib/helm";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  VmAgent,
  VmAgentSpecResourcesLimits,
  VmAgentSpecResourcesRequests,
  VmScrapeConfig,
  VmScrapeConfigSpecScheme,
} from "../../imports/operator.victoriametrics.com";

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
      // env: [
      //   {
      //     name: "VM_CONTAINERREGISTRY",
      //     value: "docker.cmdcentral.net",
      //   }, // for stuff deployed by operator
      // ],
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
      enabled: false,
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

class VmResources extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const vmagentPort = 8429;
    new VmAgent(this, "vmagent", {
      metadata: {
        name: "metrics",
        namespace: namespace,
      },
      spec: {
        extraArgs: {
          "memory.allowedPercent": "80", // https://docs.victoriametrics.com/vmagent/#troubleshooting
          "promscrape.dropOriginalLabels": "true",
          "promscrape.streamParse": "true",
        },
        port: `${vmagentPort}`,
        remoteWrite: [
          {
            url: "http://vmsingle-metrics-victoria-metrics-k8s-stack.metrics.svc.cluster.local.:8429/api/v1/write", // TODO this may need to be changed
          },
        ],
        resources: {
          limits: {
            memory: VmAgentSpecResourcesLimits.fromString("512Mi"),
            cpu: VmAgentSpecResourcesLimits.fromString("300m"),
          },
          requests: {
            memory: VmAgentSpecResourcesRequests.fromString("512Mi"),
            cpu: VmAgentSpecResourcesRequests.fromString("300m"),
          },
        },
        scrapeInterval: "20s",
        selectAllByDefault: true,
      },
    });
  }
}

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

    new VmScrapeConfig(this, "hass", {
      metadata: {
        name: "hass",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["home-assistant.hass.svc.cluster.local:8123"],
            labels: { job: "hass" },
          },
        ],
        path: "/api/prometheus",
        scheme: VmScrapeConfigSpecScheme.HTTP,
        // bearer auth
        authorization: {
          credentials: {
            name: "hass-bearer-token",
            key: "token",
          },
        },
      },
    });
  }
}

new ScrapeConfigs(app, "scrapes");
new VmResources(app, "resources");

app.synth();
