import { App } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { ArgoApp, ArgoAppSource } from "../../lib/argo";
import { AuthentikIngressRoute } from "../../lib/traefik";
import { IntOrString, Quantity } from "../../imports/k8s";
import { basename } from "../../lib/util";
import { BasicApp } from "../../lib/app";
import { StorageClass } from "../../lib/volume";
import { PersistentVolumeAccessMode } from "cdk8s-plus-29";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

new ArgoApp(app, "paperless", {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.PROD,
  recurse: true,
});

new AuthentikIngressRoute(app, "paperless-ingress", {
  namespace: namespace,
  hostname: "paperless.cmdcentral.xyz",
  upstreamService: {
    name: "paperless-web",
    port: IntOrString.fromNumber(8000),
  },
  tlsSecretName: "paperless-tls",
});

new BasicApp(app, "paperless-app", {
  namespace: namespace,
  image: "ghcr.io/paperless-ngx/paperless-ngx:latest",
  ports: [8000],
  useExternalDNS: false,
  labels: { component: "web" },
  pvcProps: {
    name: "paperless-data-new",
    storageClass: StorageClass.CEPH_RBD,
    size: Quantity.fromString("5Gi"),
    accessMode: PersistentVolumeAccessMode.READ_WRITE_ONCE,
    mountPath: "",
  },
});

app.synth();
