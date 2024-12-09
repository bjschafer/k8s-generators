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
  VmPodScrape,
  VmRule,
  VmScrapeConfig,
  VmScrapeConfigSpecScheme,
  VmServiceScrape,
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
            url: "http://vmsingle-metrics.metrics.svc.cluster.local.:8429/api/v1/write",
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
          url: "http://vmsingle-metrics.metrics.svc.cluster.local.:8429",
        },
        evaluationInterval: "15s",
        extraArgs: {
          "http.pathPrefix": "/",
          "remoteWrite.disablePathAppend": "true",
        },
        notifiers: [
          {
            url: "http://vmalert-metrics.metrics.svc.cluster.local.:9093",
          },
        ],
        port: "8080",
        remoteRead: {
          url: "http://vmsingle-metrics.metrics.svc.cluster.local.:8429",
        },
        remoteWrite: {
          url: "http://vmsingle-metrics.metrics.svc.cluster.local.:8429/api/v1/write",
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
        selectAllByDefault: true, // automatically pick up all VmAlertmanagerConfigs
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
                to: "braxton@cmdcentral.xyz",
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
            equal: ["alertname"],
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
            secretName: "metrics-tls",
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

    new VmScrapeConfig(this, "infra", {
      metadata: {
        name: "infra",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "infra1.cmdcentral.xyz:9100",
              "infra2.cmdcentral.xyz:9100",
            ],
            labels: { job: "infra" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "lakelair-gateway", {
      metadata: {
        name: "lakelair-gateway",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            labels: { job: "lakelair-gateway" },
            targets: ["gateway.lakelair.net:9100"],
          },
        ],
      },
    });

    new VmScrapeConfig(this, "mgt", {
      metadata: {
        name: "mgt",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["mgt.cmdcentral.xyz:9100"],
            labels: { job: "mgt" },
          },
        ],
      },
    });

    ["cluster", "node"].forEach((kind: string) => {
      new VmScrapeConfig(this, `minio-${kind}`, {
        metadata: {
          name: `minio-${kind}`,
          namespace: namespace,
        },
        spec: {
          staticConfigs: [
            {
              labels: { job: `minio-${kind}` },
              targets: ["minio.cmdcentral.xyz:9000"],
            },
          ],
          path: `/minio/v2/metrics/${kind}`,
          authorization: {
            credentials: {
              name: "minio-bearer-token",
              key: "token",
            },
          },
        },
      });
    });

    new VmScrapeConfig(this, "nut", {
      metadata: {
        name: "nut",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            labels: { job: "nut" },
            targets: ["infra2.cmdcentral.xyz:3493"], // address of nut server
          },
        ],
        relabelConfigs: [
          {
            action: "replace",
            sourceLabels: ["__address__"],
            targetLabel: "__param_target",
          },
          {
            action: "replace",
            sourceLabels: ["__param_target"],
            targetLabel: "instance",
          },
          {
            action: "replace",
            replacement: "infra2.cmdcentral.xyz:9995", // address of nut exporter
            targetLabel: "__address__",
          },
        ],
      },
    });
    new VmRule(this, "nut-power-usage", {
      metadata: {
        name: "nut-power-usage",
        namespace: namespace,
      },
      spec: {
        groups: [
          {
            name: "nut_power_usage_watts",
            rules: [
              {
                record: "ups:power_usage_watts:rackmount",
                expr: 'nut_load{ups="rackmount"} * nut_power_nominal_watts{ups="rackmount"}',
              },
              {
                record: "ups:power_usage_watts:network",
                expr: 'nut_load{ups="network"} * nut_power_nominal_watts{ups="network"}',
              },
              {
                record: "ups:power_usage_watts:a_side",
                expr: 'nut_load{ups="a-side"} * 1000',
              },
              {
                record: "ups:power_usage_watts:b_side",
                expr: 'nut_load{ups="b-side"} * 1350',
              },
            ],
          },
        ],
      },
    });

    new VmScrapeConfig(this, "pdns", {
      metadata: {
        name: "pdns",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "infra1.cmdcentral.xyz:8081",
              "infra1.cmdcentral.xyz:8082",
              "infra2.cmdcentral.xyz:8081",
              "infra2.cmdcentral.xyz:8082",
            ],
            labels: { job: "pdns" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "printers", {
      metadata: {
        name: "printers",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "endertres.cmdcentral.xyz:9100",
              "pandora.cmdcentral.xyz:9100",
              "trident.cmdcentral.xyz:9100",
            ],
            labels: { job: "printers" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "snmp", {
      metadata: {
        name: "snmp",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["sw01.cmdcentral.xyz", "sw02.cmdcentral.xyz"], // snmp targets to scrape
            labels: { job: "snmp" },
          },
        ],
        path: "/snmp",
        relabelConfigs: [
          {
            action: "replace",
            sourceLabels: ["__address__"],
            targetLabel: "__param_target",
          },
          {
            action: "replace",
            sourceLabels: ["__param_target"],
            targetLabel: "instance",
          },
          {
            action: "replace",
            targetLabel: "__address__",
            replacement: "snmp-exporter.prometheus.svc.cluster.local:9116", // address of snmp exporter
          },
        ],
      },
    });

    new VmScrapeConfig(this, "servers", {
      metadata: {
        name: "servers",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "jellyfin.cmdcentral.xyz:9100",
              "plex.cmdcentral.xyz:9100",
            ],
            labels: { job: "servers" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "vmhost", {
      metadata: {
        name: "vmhost",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "vmhost01.cmdcentral.xyz:9100",
              "vmhost02.cmdcentral.xyz:9100",
              "vmhost03.cmdcentral.xyz:9100",
            ],
            labels: { job: "vmhost" },
          },
        ],
      },
    });

    // --- pods
    new VmPodScrape(this, "argocd-image-updater", {
      metadata: {
        name: "argocd-image-updater",
        namespace: namespace,
      },
      spec: {
        namespaceSelector: {
          matchNames: ["argocd"],
        },
        podMetricsEndpoints: [{ port: "metrics" }],
        selector: {
          matchLabels: { "app.kubernetes.io/name": "argocd-image-updater" },
        },
      },
    });

    // --- services

    [
      { name: "argocd", serviceName: "argocd-metrics" },
      { name: "server", serviceName: "server-metrics" },
      { name: "repo-server", serviceName: "repo-server" },
      {
        name: "applicationset-controller",
        serviceName: "applicationset-controller",
      },
    ].forEach((obj: { name: string; serviceName: string }) => {
      const name = `${obj.name}-metrics`;
      new VmServiceScrape(this, name, {
        metadata: {
          name: name,
          namespace: namespace,
        },
        spec: {
          namespaceSelector: {
            matchNames: ["argocd"],
          },
          endpoints: [{ port: "metrics" }],
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": `argocd-${obj.serviceName}`,
            },
          },
        },
      });
    });
  }
}

new ScrapeConfigs(app, "scrapes");
new VmResources(app, "resources");

app.synth();
