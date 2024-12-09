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
  VmAlert,
  VmAlertmanager,
  VmAlertmanagerConfig,
  VmAlertmanagerSpecResourcesLimits,
  VmAlertmanagerSpecResourcesRequests,
  VmScrapeConfig,
  VmScrapeConfigSpecScheme,
  VmSingle,
  VmSingleSpecResourcesRequests,
} from "../../imports/operator.victoriametrics.com";
import { KubeIngress } from "cdk8s-plus-30/lib/imports/k8s";

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

    new VmAlert(this, "vmalert", {
      metadata: {
        name: "metrics",
        namespace: namespace,
      },
      spec: {
        datasource: {
          url: "http://vmsingle-metrics-victoria-metrics-k8s-stack.metrics.svc.cluster.local.:8429",
        },
        evaluationInterval: "15s",
        extraArgs: {
          "http.pathPrefix": "/",
          "remoteWrite.disablePathAppend": "true",
        },
        notifiers: [
          {
            url: "http://alertmanager-metrics-alertmanager.metrics.svc.cluster.local.:9093",
          },
        ],
        port: "8080",
        remoteRead: {
          url: "http://vmsingle-metrics-victoria-metrics-k8s-stack.metrics.svc.cluster.local.:8429",
        },
        remoteWrite: {
          url: "http://vmsingle-metrics-victoria-metrics-k8s-stack.metrics.svc.cluster.local.:8429/api/v1/write",
        },
        selectAllByDefault: true,
      },
    });

    new VmAlertmanager(this, "alertmanager", {
      metadata: {
        name: "metrics",
        namespace: namespace,
      },
      spec: {
        externalUrl: "https://alertmanager.cmdcentral.xyz",
        resources: {
          requests: {
            memory: VmAlertmanagerSpecResourcesRequests.fromString("256Mi"),
          },
          limits: {
            memory: VmAlertmanagerSpecResourcesLimits.fromString("256Mi"),
          },
        },
      },
    });
    new VmAlertmanagerConfig(this, "alertmanager-config", {
      metadata: {
        name: "default",
        namespace: namespace,
      },
      spec: {
        receivers: [
          {
            name: "email",
            emailConfigs: [
              {
                smarthost: "smtp.fastmail.com:465",
                from: "alertmanager@cmdcentral.xyz",
                hello: "alertmanager@cmdcentral.xyz",
                authUsername: "braxton@cmdcentral.xyz",
                requireTls: false,
                authPassword: {
                  key: "email_pass",
                  name: "alertmanager-secrets",
                },
              },
            ],
          },
          {
            name: "telegram",
            telegramConfigs: [
              {
                apiUrl: "https://api.telegram.org",
                chatId: 834388479,
                botToken: {
                  key: "telegram_bot_token",
                  name: "alertmanager-secrets",
                },
              },
            ],
          },
          {
            name: "blackhole",
          },
        ],
        route: {
          receiver: "blackhole",
          continue: true,
          groupBy: ["alertname", "cluster"],
          routes: [
            {
              receiver: "telegram",
              matchers: ['push_notify="true"'],
            },
            {
              receiver: "email",
              match: {
                severity: "critical",
              },
            },
          ],
        },
        inhibitRules: [
          {
            sourceMatchers: ['severity="critical"'],
            targetMatchers: ['severity="warning"'],
            equal: ["alertname"]
          },
        ],
      },
    });

    new KubeIngress(this, "alertmanager-ingress", {
      metadata: {
        name: "alertmanager",
        namespace: namespace,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt",
        },
      },
      spec: {
        rules: [
          {
            host: "metrics-alerts.cmdcentral.xyz",
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "vmalertmanager-metrics",
                      port: {
                        name: "http",
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
            secretName: "alertmanager-tls",
            hosts: ["metrics-alerts.cmdcentral.xyz"],
          },
        ],
      },
    });

    new VmSingle(this, "vmsingle", {
      metadata: {
        name: "metrics",
        namespace: namespace,
      },
      spec: {
        replicaCount: 1, // This'll set replicas=n on deployment, so you run into PVC multi-attach errors
        retentionPeriod: "90d",
        storage: {
          storageClassName: StorageClass.CEPH_RBD,
          resources: {
            requests: {
              storage: VmSingleSpecResourcesRequests.fromString("80Gi"),
            },
          },
        },
      },
    });

    new KubeIngress(this, "vmsingle-ingress", {
      metadata: {
        name: "metrics",
        namespace: namespace,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt",
        },
      },
      spec: {
        rules: [
          {
            host: hostname,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "vmsingle-metrics",
                      port: {
                        name: "http",
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
            secretName: "alertmanager-tls",
            hosts: [hostname],
          },
        ],
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
