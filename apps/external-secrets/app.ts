import { App, Chart } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { EsoValuesSchema } from "../../imports/helm-values/eso-values.schema";
import { Certificate, ClusterIssuer } from "../../imports/cert-manager.io";
import { Construct } from "constructs";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import { NewArgoApp } from "../../lib/argo";

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
  }
}

new EsoConfig(app, "config");

app.synth();
