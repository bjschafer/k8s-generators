import { App, Chart } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { HelmApp } from "../../lib/helm";
import { BitwardenSmValuesSchema } from "../../imports/helm-values/bitwarden-sm-values.schema";
import { Construct } from "constructs";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const version = "0.1.0";

NewArgoApp(name, {
  namespace: namespace,
});

new HelmApp<BitwardenSmValuesSchema>(app, "helm", {
  chart: "sm-operator",
  repo: "https://charts.bitwarden.com/",
  version: version,
  releaseName: name,
  namespace: namespace,
  values: {
    settings: {
      bwSecretsManagerRefreshInterval: 360, // seconds
      cloudRegion: "US",
    },
  },
});

class BitwardenConfig extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new VmServiceScrape(this, "scrape", {
      metadata: {
        name: "scrape",
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            "app.kubernetes.io/component": "kube-rbac-proxy",
          },
        },
        endpoints: [
          {
            port: "https",
          },
        ],
      },
    });
  }
}

new BitwardenConfig(app, "config");

app.synth();
