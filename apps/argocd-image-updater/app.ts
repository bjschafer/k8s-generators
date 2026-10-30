import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { Namespaces, NetworkPolicy, NetworkPolicyPort, Pods } from "cdk8s-plus-34";
import { basename } from "../../lib/util";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { NewKustomize } from "../../lib/kustomize";
import { infraResources } from "../../lib/util";

const name = basename(__dirname);
// Shares ArgoCD's namespace: it reads Applications and the repo credentials
// ArgoCD keeps there.
const namespace = "argocd";
const app = new App(DEFAULT_APP_PROPS(name));
// renovate: datasource=helm depName=argocd-image-updater registryUrl=https://argoproj.github.io/argo-helm
const version = "1.4.0";

// apps/metrics' VmPodScrape targets this port. The chart's default is 8443
// with authn/authz in front of it, which that scrape can't speak.
const metricsPort = 8080;

/**
 * argocd-image-updater, which ImageUpdater CRs from lib/argo.ts's `autoUpdate`
 * drive.
 *
 * Its own version follows the chart via Renovate, rather than an ImageUpdater
 * pointed at itself the way it was in k8s-prod.
 */
NewArgoApp(name, {
  namespace: namespace,
});

new HelmApp(app, "helm", {
  chart: "argocd-image-updater",
  repo: "https://argoproj.github.io/argo-helm",
  version: version,
  releaseName: name,
  namespace: namespace,
  values: {
    extraArgs: ["--metrics-secure=false"],
    containerPorts: { metrics: metricsPort },
    // Declares the metrics containerPort. Its Service and auth ClusterRoles
    // come along for the ride; nothing uses them.
    metrics: { enabled: true, service: { servicePort: metricsPort } },
    config: {
      interval: "1h",
      "log.format": "json",
    },
    // Peaks near 200Mi.
    resources: infraResources("25m", "192Mi", "512Mi"),
  },
});

/**
 * The chart ships no NetworkPolicy. Nothing needs to reach the pod except the
 * metrics scrape -- the webhook listener is off -- so allow only that.
 */
class ImageUpdaterNetworkPolicy extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: namespace });

    new NetworkPolicy(this, "allow-metrics", {
      metadata: { name: "argocd-image-updater-allow-metrics" },
      selector: Pods.select(this, "updater-pods", {
        labels: { "app.kubernetes.io/name": "argocd-image-updater" },
      }),
      ingress: {
        rules: [
          {
            peer: Namespaces.select(this, "metrics-ns", {
              labels: { "kubernetes.io/metadata.name": "metrics" },
            }),
            ports: [NetworkPolicyPort.tcp(metricsPort)],
          },
        ],
      },
    });
  }
}

new ImageUpdaterNetworkPolicy(app, "netpol");

app.synth();

NewKustomize(app.outdir);
