import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { basename } from "path";
import {
  ARGO_DEFAULT_PROPS,
  ARGO_DESTINATION_SERVER,
  ARGO_NAMESPACE,
} from "../../lib/argo";
import { StorageClass } from "../../lib/volume";
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
            prune: true,
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
