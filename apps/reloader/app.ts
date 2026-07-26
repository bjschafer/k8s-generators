import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { basename } from "../../lib/util";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { NewKustomize } from "../../lib/kustomize";
import { VmPodScrape } from "../../imports/operator.victoriametrics.com";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
// renovate: datasource=helm depName=reloader registryUrl=https://stakater.github.io/stakater-charts
const version = "2.2.14";

NewArgoApp(name, {
  namespace: namespace,
});

new HelmApp(app, "helm", {
  chart: "reloader",
  repo: "https://stakater.github.io/stakater-charts",
  version: version,
  releaseName: name,
  namespace: namespace,
  values: {
    // without this the chart names everything reloader-reloader
    fullnameOverride: name,
    reloader: {
      deployment: {
        resources: {
          limits: {
            cpu: "200m",
            memory: "512Mi",
          },
          requests: {
            cpu: "10m",
            memory: "512Mi",
          },
        },
        pod: {
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            seccompProfile: {
              type: "RuntimeDefault",
            },
          },
        },
      },
    },
  },
});

class ReloaderMonitoring extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: namespace });

    // the chart ships no Service, so scrape the pod directly
    new VmPodScrape(this, "podscrape", {
      metadata: {
        name: name,
        namespace: namespace,
        labels: { app: name },
      },
      spec: {
        jobLabel: name,
        namespaceSelector: {
          matchNames: [namespace],
        },
        podMetricsEndpoints: [
          {
            path: "/metrics",
            port: "http",
          },
        ],
        selector: {
          matchLabels: { app: name },
        },
      },
    });
  }
}

new ReloaderMonitoring(app, "monitoring");

app.synth();

NewKustomize(app.outdir);
