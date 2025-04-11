import { App, Chart } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { EsoValuesSchema } from "../../imports/helm-values/eso-values.schema";
import { Certificate, ClusterIssuer } from "../../imports/cert-manager.io";
import { Construct } from "constructs";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import { NewArgoApp } from "../../lib/argo";
import {
  ClusterSecretStore,
  ClusterSecretStoreV1Beta1,
  ClusterSecretStoreV1Beta1SpecProviderBitwardensecretsmanagerCaProviderType,
  ExternalSecret,
  ExternalSecretSpecSecretStoreRefKind,
  ExternalSecretV1Beta1,
  ExternalSecretV1Beta1SpecSecretStoreRefKind,
  SecretStore,
  SecretStoreV1Beta1,
} from "../../imports/external-secrets.io";
import { KeyObject } from "crypto";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const version = "0.15.1";

NewArgoApp(name, {
  namespace: namespace,
});

new HelmApp<EsoValuesSchema>(app, "helm", {
  chart: "external-secrets",
  repo: "https://charts.external-secrets.io",
  version: version,
  releaseName: name,
  namespace: namespace,
  values: {
    "bitwarden-sdk-server": {
      enabled: true,
    },
    openshiftFinalizers: false,
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
          cpu: "50m",
          memory: "64Mi",
        },
        limits: {
          cpu: "50m",
          memory: "64Mi",
        },
      },
    },
  },
});

class EsoConfig extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Certificate(this, "bitwarden-tls-certs", {
      metadata: {
        name: "bitwarden-tls-certs",
        namespace: namespace,
      },
      spec: {
        issuerRef: {
          kind: ClusterIssuer.GVK.kind,
          group: ClusterIssuer.GVK.apiVersion.split("/")[0],
          name: "webhook-selfsigned",
        },
        secretName: "bitwarden-tls-certs",
        commonName: "bitwarden-sdk-server",
        duration: "8760h",
        dnsNames: [
          "bitwarden-sdk-server",
          `bitwarden-sdk-server.${namespace}`,
          `bitwarden-sdk-server.${namespace}.svc`,
          `bitwarden-sdk-server.${namespace}.svc.cluster.local`,
        ],
      },
    });

    ["external-secrets", "external-secrets-webhook"].forEach(
      (selector: string) => {
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
      },
    );

    new ClusterSecretStoreV1Beta1(this, "bw-secret-store", {
      metadata: {
        name: "bitwarden",
      },
      spec: {
        provider: {
          bitwardensecretsmanager: {
            apiUrl: "https://api.bitwarden.com",
            identityUrl: "https://identity.bitwarden.com",
            auth: {
              secretRef: {
                credentials: {
                  key: "token",
                  name: "bitwarden-access-token",
                  namespace: namespace,
                },
              },
            },
            bitwardenServerSdkurl:
              "https://bitwarden-sdk-server.external-secrets.svc.cluster.local:9998",
            organizationId: "f629d5a2-5bbe-4647-9189-b0dd017dca43",
            projectId: "01e3e960-5d95-4bbc-b63c-b2bc00226981",
            caProvider: {
              type: ClusterSecretStoreV1Beta1SpecProviderBitwardensecretsmanagerCaProviderType.SECRET,
              namespace: namespace,
              name: "bitwarden-tls-certs",
              key: "ca.crt",
            },
          },
        },
      },
    });

    new ExternalSecretV1Beta1(this, "testing", {
      metadata: {
        name: "testing",
        namespace: namespace,
      },
      spec: {
        secretStoreRef: {
          kind: ExternalSecretV1Beta1SpecSecretStoreRefKind.CLUSTER_SECRET_STORE,
          name: "bitwarden",
        },
        data: [
          {
            secretKey: "test",
            remoteRef: {
              key: "test",
            },
          },
        ],
        target: {
          name: "testing",
        },
      },
    });
  }
}

new EsoConfig(app, "config");

app.synth();
