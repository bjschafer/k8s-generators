import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { Namespaces, NetworkPolicy, NetworkPolicyPort, Pods } from "cdk8s-plus-34";
import { basename } from "../../lib/util";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { NewKustomize } from "../../lib/kustomize";
import { GeneratedSecret } from "../../lib/secrets";
import { infraResources } from "../../lib/util";

const name = basename(__dirname);
// Shares ArgoCD's namespace: it reads Applications and the repo credentials
// ArgoCD keeps there.
const namespace = "argocd";
const app = new App(DEFAULT_APP_PROPS(name));
// renovate: datasource=helm depName=argocd-image-updater registryUrl=https://argoproj.github.io/argo-helm
const version = "1.4.2";

// apps/metrics' VmPodScrape targets this port. The chart's default is 8443
// with authn/authz in front of it, which that scrape can't speak.
const metricsPort = 8080;

// The chart's default, and what `mise run image-update` port-forwards to.
const webhookPort = 8082;

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
      // The webhook lets `mise run image-update <app>` ask for an immediate,
      // real update of one image instead of waiting out `interval`.
      // Restarting the controller doesn't do this: its first pass after
      // startup is a dry run, and the restart resets the interval clock.
      //
      // There's no Service or Ingress for it on purpose. GitHub can't reach in,
      // and the only caller is that task, over `kubectl port-forward`. That
      // traffic arrives on the pod's loopback, so the NetworkPolicy below
      // doesn't block it and needs no rule for it, and plain HTTP is fine.
      "webhook.enable": "true",
      "webhook.port": String(webhookPort),
      "disable-tls": "true",
    },
    // Peaks near 200Mi.
    resources: infraResources("25m", "192Mi", "512Mi"),
  },
});

/**
 * The chart ships no NetworkPolicy. Nothing on the pod network needs to reach
 * the pod except the metrics scrape, so allow only that. The webhook's one
 * caller comes in over port-forward, which bypasses this policy.
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

/**
 * The chart reads webhook secrets from this Secret by name but never creates
 * it. With `--webhook-require-secret` (the default), a registry type with no
 * secret has no handler at all.
 *
 * Only the Harbor handler gets a secret, because it is the one generic enough
 * for every image. It takes the registry host from the payload's
 * `resource_url` instead of hardcoding one, and its auth is a plain
 * `Authorization` header. The GHCR handler would need a forged GitHub HMAC for
 * no gain. Upstream matches events to images by registry and repo only, so the
 * payload just says "check this image now", and the normal update logic runs
 * from there.
 */
new GeneratedSecret(app, "webhook-secret", {
  name: "argocd-image-updater-secret",
  namespace: namespace,
  data: {
    "webhook.harbor-secret": {},
  },
});

app.synth();

NewKustomize(app.outdir);
