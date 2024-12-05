import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { basename } from "path";
import {
  ARGO_DEFAULT_PROPS,
  ARGO_DESTINATION_SERVER,
  ARGO_NAMESPACE,
} from "../../lib/argo";
import { Application } from "../../imports/argoproj.io";

const namespace = basename(__dirname);
const name = namespace;
const version = "0.30.2";
const hostname = "metrics.cmdcentral.xyz";

const helmChartApp = new App(ARGO_DEFAULT_PROPS);
class Metrics extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Application(this, "app", {
      metadata: {
        namespace: ARGO_NAMESPACE,
        name: name,
      },
      spec: {
        destination: {
          namespace: namespace,
          server: ARGO_DESTINATION_SERVER,
        },
        project: "default",
        source: {
          helm: {
            releaseName: "metrics",
            valuesObject: {
              argocdReleaseOverride: "metrics",
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
                },
              },
              vmsingle: {
                create: false,
              },
              vmcluster: {
                create: true,
                spec: {
                  retentionPeriod: "90d",
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
                      secretName: "metrics-tls",
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
          },
          chart: "victoria-metrics-k8s-stack",
          repoUrl: "https://victoriametrics.github.io/helm-charts/",
          targetRevision: version,
        },
        syncPolicy: {
          automated: {
            selfHeal: true,
          },
          syncOptions: ["CreateNamespace=true"],
        },
      },
    });
  }
}

new Metrics(helmChartApp, "metrics");

helmChartApp.synth();
