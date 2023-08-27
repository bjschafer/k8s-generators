import { basename } from "path";
import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { StorageClass } from "../../lib/volume";
import { PersistentVolumeAccessMode, Probe } from "cdk8s-plus-27";
import { NewKustomize } from "../../lib/kustomize";
import { HomeRbac } from "./rbac";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
    syncOptions: ["CreateNamespace=true"],
  },
  namespace: namespace,
  recurse: true,
  autoUpdate: {
    writebackMethod: {
      method: "git",
      gitBranch: "main",
    },
    images: [
      {
        image: "ghcr.io/benphelps/homepage",
        strategy: "digest",
      },
    ],
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: "ghcr.io/benphelps/homepage:latest",
  resources: {
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(256),
    },
  },
  ports: [3000],
  volumes: [
    {
      props: {
        storageClassName: StorageClass.CEPHFS,
        storage: Size.gibibytes(1),
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_MANY],
      },
      mountPath: "/app/config",
      enableBackups: true,
      name: "config",
    },
  ],
  livenessProbe: Probe.fromHttpGet("", { port: 3000 }),
  readinessProbe: Probe.fromHttpGet("", { port: 3000 }),
  serviceAccountName: name,
  automountServiceAccount: true,
});

new HomeRbac(app, `${name}-rbac`);

app.synth();

NewKustomize(app.outdir);
