import { Chart } from "cdk8s";
import { KubeIngress, HttpIngressPath } from "cdk8s-plus-31/lib/imports/k8s";
import { Construct } from "constructs";
import {
  VmAgent,
  VmAgentSpecResourcesLimits,
  VmAgentSpecResourcesRequests,
  VmAlert,
  VmAlertmanager,
  VmAlertmanagerSpecResourcesRequests,
  VmAlertmanagerSpecResourcesLimits,
  VmAlertmanagerConfig,
  VmSingle,
  VmSingleSpecResourcesRequests,
  VmSingleSpecResourcesLimits,
} from "../../imports/operator.victoriametrics.com";
import { StorageClass } from "../../lib/volume";
import { hostname, namespace } from "./app";

export class VmResources extends Chart {
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
          "promscrape.dropOriginalLabels": "false",
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
            cpu: VmAgentSpecResourcesLimits.fromString("1200m"),
          },
          requests: {
            memory: VmAgentSpecResourcesRequests.fromString("512Mi"),
            cpu: VmAgentSpecResourcesRequests.fromString("1200m"),
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
            url: "http://vmalertmanager-metrics.metrics.svc.cluster.local.:9093",
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
        resources: {
          limits: {
            cpu: VmSingleSpecResourcesLimits.fromString("1200m"),
            memory: VmSingleSpecResourcesLimits.fromString("3Gi"),
          },
          requests: {
            cpu: VmSingleSpecResourcesRequests.fromString("200m"),
            memory: VmSingleSpecResourcesRequests.fromString("1Gi"),
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
                ...[
                  "/targets",
                  "/service-discovery",
                  "/api/v1/targets",
                  "/config",
                  "/target-relabel-debug",
                  "/metric-relabel-debug",
                  "/target_response",
                ].map((path: string): HttpIngressPath => {
                  return {
                    path: path,
                    pathType: "Prefix",
                    backend: {
                      service: {
                        name: "vmagent-metrics",
                        port: { name: "http" },
                      },
                    },
                  };
                }),
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
