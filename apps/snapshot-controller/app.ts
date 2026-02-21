import { App } from "cdk8s";
import { NewArgoApp, ArgoAppSource, ENABLE_SERVERSIDE_APPLY } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { NewKustomize } from "../../lib/kustomize";

const name = "snapshot-controller";
const namespace = "ceph";
const app = new App(DEFAULT_APP_PROPS(name));

NewArgoApp(name, {
  namespace,
  directoryName: name,
  source: ArgoAppSource.GENERATORS,
  ...ENABLE_SERVERSIDE_APPLY,
});

new HelmApp(app, "helm", {
  chart: "snapshot-controller",
  repo: "https://piraeus.io/helm-charts/",
  version: "5.0.3",
  releaseName: name,
  namespace,
  values: {
    controller: {
      replicaCount: 2,
    },
    webhook: {
      enabled: true,
      tls: {
        // Use the cluster-wide self-signed ClusterIssuer so cert-manager manages
        // the conversion webhook cert instead of committing a plain-text secret.
        certManagerIssuerRef: {
          kind: "ClusterIssuer",
          group: "cert-manager.io",
          name: "webhook-selfsigned",
        },
      },
    },
  },
});

app.synth();
NewKustomize(app.outdir);
