import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { App } from "cdk8s/lib/app";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { Size } from "cdk8s";
import { StorageClass } from "../../lib/volume";
import { PersistentVolumeAccessMode, Probe } from "cdk8s-plus-32";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "powerdnsadmin/pda-legacy";

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.PROD,
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
  ports: [80],
  volumes: [
    {
      props: {
        storageClassName: StorageClass.LONGHORN,
        storage: Size.gibibytes(1),
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      },
      mountPath: "/data",
      enableBackups: true,
      name: "config",
    },
  ],
  livenessProbe: Probe.fromHttpGet("", { port: 80 }),
  readinessProbe: Probe.fromHttpGet("", { port: 80 }),
  extraIngressHosts: ["dnsadmin.cmdcentral.xyz"],
  limitToAMD64: true,
});

app.synth();

NewKustomize(app.outdir);
