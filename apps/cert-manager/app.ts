import { App, Chart } from "cdk8s";
import { basename, join } from "path";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { Construct } from "constructs";
import { ClusterIssuer } from "../../imports/cert-manager.io";
import { BitwardenSecret } from "../../lib/secrets";
import { AddCRDs } from "../../lib/util";

export const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
// renovate: datasource=github-releases depName=cert-manager/cert-manager extractVersion=^v(?<version>.*)$
const version = "1.20.3";

NewArgoApp(name, {
  namespace: namespace,
});

// HIGH RISK cutover: consumed by the ACME DNS01 solver on every cert
// issuance/renewal. Only delete the legacy SealedSecret from the prod repo
// during a maintenance window and verify issuance immediately afterwards.
new BitwardenSecret(app, "cloudflare-api-token", {
  name: "cloudflare-api-token",
  namespace: namespace,
  data: {
    "api-token": "1f8d71e2-21e2-42e7-9eb4-b47e01820565",
  },
});

new HelmApp(app, "helm", {
  chart: "cert-manager",
  repo: "https://charts.jetstack.io",
  version: version,
  releaseName: name,
  namespace: namespace,
  values: {
    crds: {
      enabled: true,
    },
    dns01RecursiveNameservers: "1.1.1.1:53,1.0.0.1:53",
    dns01RecursiveNameserversOnly: true,
  },
});

class CertManagerConfig extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const certManagerEmail = "certs@cmdcentral.xyz";
    const cfEmail = "braxton@cmdcentral.xyz";

    AddCRDs(this, join(__dirname, "crds"));

    new ClusterIssuer(this, "letsencrypt-staging", {
      metadata: {
        name: "letsencrypt-staging",
      },
      spec: {
        acme: {
          email: certManagerEmail,
          server: "https://acme-staging-v02.api.letsencrypt.org/directory",
          privateKeySecretRef: {
            name: "staging-issuer-account-key",
          },
          solvers: [
            {
              dns01: {
                cloudflare: {
                  email: cfEmail,
                  apiTokenSecretRef: {
                    name: "cloudflare-api-token",
                    key: "api-token",
                  },
                },
              },
            },
          ],
        },
      },
    });

    new ClusterIssuer(this, "letsencrypt-prod", {
      metadata: {
        name: "letsencrypt",
      },
      spec: {
        acme: {
          email: certManagerEmail,
          server: "https://acme-v02.api.letsencrypt.org/directory",
          privateKeySecretRef: {
            name: "prod-issuer-account-key",
          },
          solvers: [
            {
              dns01: {
                cloudflare: {
                  email: cfEmail,
                  apiTokenSecretRef: {
                    name: "cloudflare-api-token",
                    key: "api-token",
                  },
                },
              },
            },
          ],
        },
      },
    });

    // for validating/mutating webhooks that need _a_ cert
    // but it doesn't matter if it's self-signed
    new ClusterIssuer(this, "webhook-selfsigned", {
      metadata: {
        name: "webhook-selfsigned",
      },
      spec: {
        selfSigned: {},
      },
    });
  }
}

new CertManagerConfig(app, "config");

app.synth();
