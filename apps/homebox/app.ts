import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { App } from "cdk8s/lib/app";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { Size } from "cdk8s";
import { EnvValue, PersistentVolumeAccessMode, Probe } from "cdk8s-plus-27";
import { NewKustomize } from "../../lib/kustomize";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/hay-kot/homebox";
const port = 7745;

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.GENERATORS,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "digest",
      },
    ],
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:latest`,
  resources: {
    memory: {
      request: Size.mebibytes(192),
      limit: Size.mebibytes(512),
    },
  },
  ports: [port],
  livenessProbe: Probe.fromHttpGet("", { port: port }),
  readinessProbe: Probe.fromHttpGet("", { port: port }),
  volumes: [
    {
      name: "data",
      mountPath: "/data",
      enableBackups: true,
      props: {
        storageClassName: StorageClass.CEPH_RBD,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        storage: Size.gibibytes(5),
      },
    },
  ],
  extraEnv: {
    HBOX_LOG_LEVEL: EnvValue.fromValue("info"),
    HBOX_LOG_FORMAT: EnvValue.fromValue("json"),
    HBOX_WEB_MAX_UPLOAD_SIZE: EnvValue.fromValue("30"), // MB
  },
});

app.synth();

NewKustomize(app.outdir);
