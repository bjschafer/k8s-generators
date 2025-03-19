import { App, Chart, Helm } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { Construct } from "constructs";

const namespace = "openebs";
const name = namespace;
const version = "4.2.0";
const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(name, {
  namespace: namespace,
});

class OpenEBS extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Helm(this, "openebs", {
      chart: "openebs",
      repo: "https://openebs.github.io/openebs",
      version: version,
      releaseName: name,
      namespace: namespace,
      values: {
        engines: {
          local: {
            zfs: {
              enabled: false,
            },
          },
        },
        mayastor: {
          "loki-stack": {
            enabled: false,
          },
        },
        "openebs-crds": {
          csi: {
            volumeSnapshots: {
              enabled: false,
            },
          },
        },
      },
    });
  }
}

new OpenEBS(app, "openebs");

app.synth();
