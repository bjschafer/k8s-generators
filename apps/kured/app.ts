import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { join } from "path";
import { basename } from "../../lib/util";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { AddCRDs } from "../../lib/util";
import {
  VmPodScrape,
  VmPodScrapeSpecPodMetricsEndpointsTargetPort,
} from "../../imports/operator.victoriametrics.com";

const name = basename(__dirname);
// kured reboots nodes, so it lives alongside the other node-level components
// rather than in a namespace of its own.
const namespace = "kube-system";
const app = new App(DEFAULT_APP_PROPS(name));

NewArgoApp(name, {
  namespace: namespace,
});

class Kured extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: namespace });

    // The whole upstream release bundle (DaemonSet + RBAC + ServiceAccount),
    // vendored by `mise run update-crds kured`. We run upstream's defaults, so
    // it's included verbatim -- see tools/sources.ts.
    AddCRDs(this, join(__dirname, "crds"));

    // kured serves metrics on the DaemonSet pods directly; there's no Service.
    new VmPodScrape(this, "podscrape", {
      metadata: {
        name: name,
        namespace: namespace,
        labels: {
          "app.kubernetes.io/instance": name,
        },
      },
      spec: {
        namespaceSelector: {
          matchNames: [namespace],
        },
        podMetricsEndpoints: [
          {
            targetPort: VmPodScrapeSpecPodMetricsEndpointsTargetPort.fromString("metrics"),
          },
        ],
        selector: {
          matchLabels: { name: name },
        },
      },
    });
  }
}

new Kured(app, name);

app.synth();

NewKustomize(app.outdir);
