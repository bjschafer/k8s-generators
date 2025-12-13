import { App, Chart } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { EsoValuesSchema } from "../../imports/helm-values/eso-values.schema";
import { Certificate, ClusterIssuer, Issuer } from "../../imports/cert-manager.io";
import { Construct } from "constructs";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import { ENABLE_SERVERSIDE_APPLY, NewArgoApp } from "../../lib/argo";
import {
  ClusterSecretStore,
  ClusterSecretStoreSpecProviderBitwardensecretsmanagerCaProviderType,
} from "../../imports/external-secrets.io";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const version = "1.1.1";

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

    const tlsSecretName = "bitwarden-tls-certs";
    const caSecretName = "bitwarden-ca-certs";

    // bootstrap a self-signed issuer used to create the CA
    const bootstrapIssuer = new Issuer(this, "bootstrap-issuer", {
      metadata: {
        name: "bitwarden-bootstrap-issuer",
        namespace,
      },
      spec: {
        selfSigned: {},
      },
    });
    new Certificate(this, "bitwarden-bootstrap-certs", {
      metadata: {
        name: "bitwarden-bootstrap-certs",
        namespace: namespace,
      },
      spec: {
        isCa: true,
        subject: {
          organizations: ["external-secrets.io"],
        },
        issuerRef: {
          kind: Issuer.GVK.kind,
          group: Issuer.GVK.apiVersion.split("/")[0],
          name: bootstrapIssuer.name,
        },
        secretName: caSecretName,
        commonName: "bitwarden-sdk-server",
        duration: "8760h",
        dnsNames: [
          "bitwarden-sdk-server",
          `bitwarden-sdk-server.${namespace}`,
          `bitwarden-sdk-server.${namespace}.svc`,
          `bitwarden-sdk-server.${namespace}.svc.cluster.local`,
        ],
        ipAddresses: [
          "127.0.0.1",
          "::1",
        ],
      },
    });

    // create a CA issuer 
    const issuer = new Issuer(this, "bitwarden-issuer", {
      metadata: {
        name: "bitwarden-certificate-issuer",
        namespace,
      },
      spec: {
        ca: {
          secretName: caSecretName,
        },
      },
    });

    // actual issuer used by bitwarden-sdk-server
    new Certificate(this, "bitwarden-tls-certs", {
      metadata: {
        name: "bitwarden-tls-certs",
        namespace: namespace,
      },
      spec: {
        subject: {
          organizations: ["external-secrets.io"],
        },
        issuerRef: {
          kind: Issuer.GVK.kind,
          group: Issuer.GVK.apiVersion.split("/")[0],
          name: issuer.name,
        },
        secretName: tlsSecretName,
        commonName: "bitwarden-sdk-server",
        duration: "8760h",
        dnsNames: [
          "bitwarden-sdk-server",
          `bitwarden-sdk-server.${namespace}`,
          `bitwarden-sdk-server.${namespace}.svc`,
          `bitwarden-sdk-server.${namespace}.svc.cluster.local`,
          "localhost",
        ],
        ipAddresses: [
          "127.0.0.1",
          "::1",
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

    new ClusterSecretStore(this, "bw-secret-store", {
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
              type: ClusterSecretStoreSpecProviderBitwardensecretsmanagerCaProviderType.SECRET,
              namespace: namespace,
              name: caSecretName,
              key: "ca.crt",
            },
          },
        },
      },
    });
  }
}

new EsoConfig(app, "config");

app.synth();
