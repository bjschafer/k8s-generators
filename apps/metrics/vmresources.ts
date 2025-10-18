import { Chart } from "cdk8s";
import { HttpIngressPath, KubeIngress } from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import { join } from "path";
import { IngressRule } from "../../imports/k8s";
import {
  VmAgent,
  VmAgentSpecResourcesLimits,
  VmAgentSpecResourcesRequests,
  VmAlert,
  VmAlertmanager,
  VmAlertmanagerConfig,
  VmAlertmanagerSpecResourcesLimits,
  VmAlertmanagerSpecResourcesRequests,
  VmSingle,
  VmSingleSpecResourcesLimits,
  VmSingleSpecResourcesRequests,
} from "../../imports/operator.victoriametrics.com";
import { BACKUP_ANNOTATION_NAME } from "../../lib/consts";
import { AddCRDs } from "../../lib/util";
import { StorageClass } from "../../lib/volume";
import { hostname, namespace } from "./app";

export class VmResources extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    AddCRDs(this, join(__dirname, "crds"));

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
            memory: VmAgentSpecResourcesLimits.fromString("768Mi"),
            cpu: VmAgentSpecResourcesLimits.fromString("1200m"),
          },
          requests: {
            memory: VmAgentSpecResourcesRequests.fromString("768Mi"),
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
          "external.url": "https://metrics.cmdcentral.xyz",
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
        ruleSelector: {
          matchLabels: {
            "alerts.cmdcentral.xyz/kind": "metrics",
          },
        },
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
        disableRouteContinueEnforce: true,
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
            name: "pushover",
            pushoverConfigs: [
              {
                token: {
                  key: "pushover_token",
                  name: "alertmanager-secrets",
                },
                userKey: {
                  key: "pushover_user_key",
                  name: "alertmanager-secrets",
                },
                // -2 to 2
                priority: `{{if .CommonLabels.priority }}{{$CommonLabels.priority}}{{else}}0{{end}}`,
              },
            ],
          },
          {
            name: "blackhole",
          },
        ],
        route: {
          receiver: "blackhole",
          routes: [
            // either explicitly requesting push notifications, or setting PRIORITY.HIGH or PRIORITY.NORMAL will get pushover notifications
            {
              receiver: "pushover",
              matchers: ['push_notify="true"'],
            },
            {
              receiver: "pushover",
              matchers: ['priority=~"0|1"'],
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

    const am_hosts = [
      "metrics-alerts.cmdcentral.xyz",
      "alertmanager.cmdcentral.xyz",
    ];
    new KubeIngress(this, "alertmanager-ingress", {
      metadata: {
        name: "alertmanager",
        namespace: namespace,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt",
        },
      },
      spec: {
        rules: am_hosts.map((hostname: string): IngressRule => {
          return {
            host: hostname,
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
          };
        }),
        tls: [
          {
            secretName: "alertmanager-tls",
            hosts: am_hosts,
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
        podMetadata: {
          annotations: {
            [BACKUP_ANNOTATION_NAME]: "data",
          },
        },
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
            cpu: VmSingleSpecResourcesLimits.fromString("1000m"),
            memory: VmSingleSpecResourcesLimits.fromString("3Gi"),
          },
          requests: {
            cpu: VmSingleSpecResourcesRequests.fromString("1000m"),
            memory: VmSingleSpecResourcesRequests.fromString("3Gi"),
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
                ...["/", "/api/v1", "/api/v2"].map(
                  (path: string): HttpIngressPath => {
                    return {
                      path: path,
                      pathType: "Prefix",
                      backend: {
                        service: {
                          name: "vmsingle-metrics",
                          port: {
                            name: "http",
                          },
                        },
                      },
                    };
                  },
                ),
                {
                  path: "/vmalert",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "vmalert-metrics",
                      port: {
                        name: "http",
                      },
                    },
                  },
                },
                ...[
                  "/targets",
                  "/service-discovery",
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
