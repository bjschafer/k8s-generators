import { App, Chart, Helm } from "cdk8s";
import { KubeIngress } from "../../imports/k8s";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { Construct } from "constructs";

const namespace = "longhorn-system";
const name = "longhorn";
const app = new App(DEFAULT_APP_PROPS(name));

NewArgoApp(name, {
  namespace: namespace,
  recurse: true,
});

class Longhorn extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Helm(this, "longhorn", {
      chart: "longhorn",
      repo: "https://charts.longhorn.io",
      releaseName: namespace, // to avoid SharedResourceWarning
      namespace: namespace,
      values: {}, // surprisingly
    });

    new KubeIngress(this, "longhorn-ui", {
      metadata: {
        name: "longhorn-ui",
        namespace: namespace,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt",
        },
      },
      spec: {
        rules: [
          {
            host: "longhorn.cmdcentral.xyz",
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "longhorn-frontend",
                      port: {
                        number: 80,
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
            secretName: "longhorn-tls",
            hosts: ["longhorn.cmdcentral.xyz"],
          },
        ],
      },
    });
  }
}
new Longhorn(app, "longhorn");

app.synth();
