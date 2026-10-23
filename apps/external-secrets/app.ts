import { App, Chart } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS, HOMELAB_CRITICAL_PRIORITY_CLASS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { EsoValuesSchema } from "../../imports/helm-values/eso-values.schema";
import { ClusterIssuer } from "../../imports/cert-manager.io";
import { Construct } from "constructs";
import { ServiceAccount } from "cdk8s-plus-34";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import { ENABLE_SERVERSIDE_APPLY, NewArgoApp } from "../../lib/argo";
import {
  ClusterSecretStore,
  ClusterSecretStoreSpecProviderKubernetesServerCaProviderType,
  ClusterSecretStoreSpecProviderVaultVersion,
} from "../../imports/external-secrets.io";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
// renovate: datasource=helm depName=external-secrets registryUrl=https://charts.external-secrets.io
const version = "2.14.0";

NewArgoApp(name, {
  namespace: namespace,
  ...ENABLE_SERVERSIDE_APPLY,
});

new HelmApp<EsoValuesSchema>(app, "helm", {
  chart: "external-secrets",
  repo: "https://charts.external-secrets.io",
  version: version,
  releaseName: name,
  namespace: namespace,
  values: {
    openshiftFinalizers: false,
    priorityClassName: HOMELAB_CRITICAL_PRIORITY_CLASS,
    certController: { priorityClassName: HOMELAB_CRITICAL_PRIORITY_CLASS },
    livenessProbe: { enabled: true },
    resources: {
      requests: {
        cpu: "50m",
        memory: "64Mi",
      },
      limits: {
        cpu: "500m",
        memory: "512Mi",
      },
    },
    metrics: {
      service: {
        enabled: true,
      },
    },
    webhook: {
      priorityClassName: HOMELAB_CRITICAL_PRIORITY_CLASS,
      livenessProbe: { enabled: true },
      certManager: {
        enabled: true,
        cert: {
          issuerRef: {
            kind: ClusterIssuer.GVK.kind,
            group: ClusterIssuer.GVK.apiVersion.split("/")[0],
            name: "webhook-selfsigned",
          },
        },
      },
      metrics: {
        service: {
          enabled: true,
        },
      },
      resources: {
        requests: {
          cpu: "100m",
          memory: "64Mi",
        },
        limits: {
          cpu: "100m",
          memory: "64Mi",
        },
      },
    },
  },
});

class EsoConfig extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    ["external-secrets", "external-secrets-webhook"].forEach((selector: string) => {
      new VmServiceScrape(this, selector, {
        metadata: {
          name: selector,
          namespace: namespace,
        },
        spec: {
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": selector,
            },
          },
          endpoints: [
            {
              port: "metrics",
            },
          ],
        },
      });
    });

    // OpenBao (openbao.cmdcentral.xyz). ESO mints a short-lived token for this
    // ServiceAccount and bao validates it against the cluster's signing key, so
    // the SA needs no RBAC of its own. Its subject and the audience are bound on
    // the `kubernetes/eso` role in tf-authentik's openbao.tf.
    const openbaoSa = new ServiceAccount(this, "openbao-auth", {
      metadata: { name: "openbao-auth", namespace },
    });

    new ClusterSecretStore(this, "openbao-secret-store", {
      metadata: {
        name: "openbao",
      },
      spec: {
        provider: {
          vault: {
            server: "https://openbao.cmdcentral.xyz",
            path: "kv",
            version: ClusterSecretStoreSpecProviderVaultVersion.V2,
            auth: {
              jwt: {
                path: "kubernetes",
                role: "eso",
                kubernetesServiceAccountToken: {
                  serviceAccountRef: {
                    name: openbaoSa.name,
                    namespace,
                    audiences: ["https://openbao.cmdcentral.xyz"],
                  },
                  expirationSeconds: 600,
                },
              },
            },
          },
        },
      },
    });

    // Kubernetes secret store for cross-namespace secret access
    // Used to copy generated database passwords from postgres namespace to app namespaces
    new ClusterSecretStore(this, "k8s-secret-store", {
      metadata: {
        name: "kubernetes",
      },
      spec: {
        provider: {
          kubernetes: {
            // Read secrets from the postgres namespace
            remoteNamespace: "postgres",
            auth: {
              serviceAccount: {
                name: "external-secrets",
                namespace: namespace,
              },
            },
            server: {
              // Use the cluster CA from the standard ConfigMap
              caProvider: {
                type: ClusterSecretStoreSpecProviderKubernetesServerCaProviderType.CONFIG_MAP,
                name: "kube-root-ca.crt",
                namespace: "kube-system",
                key: "ca.crt",
              },
            },
          },
        },
      },
    });
  }
}

new EsoConfig(app, "config");

app.synth();
