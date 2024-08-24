import { basename } from "path";
import { App, Duration, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import {
  Cpu,
  EnvValue,
  PersistentVolumeAccessMode,
  Probe,
} from "cdk8s-plus-29";
import { StorageClass } from "../../lib/volume";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

const image = "danielszabo99/microbin";
const port = 8080;

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.GENERATORS,
  recurse: true,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "digest",
      },
    ],
  },
});

new AppPlus(app, "paste", {
  name,
  namespace,
  image,
  resources: {
    cpu: {
      request: Cpu.millis(100),
    },
    memory: {
      request: Size.mebibytes(32),
      limit: Size.gibibytes(2),
    },
  },
  ports: [port],
  livenessProbe: Probe.fromHttpGet("/", {
    port: port,
    initialDelaySeconds: Duration.seconds(5),
  }),
  readinessProbe: Probe.fromHttpGet("/", {
    port: port,
    initialDelaySeconds: Duration.seconds(5),
  }),
  volumes: [
    {
      name: "data",
      mountPath: "/app/microbin_data",
      enableBackups: false,
      props: {
        storage: Size.gibibytes(25),
        storageClassName: StorageClass.CEPHFS,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_MANY],
      },
    },
  ],
  extraEnv: {
    MICROBIN_DISABLE_TELEMETRY: EnvValue.fromValue("true"),
    MICROBIN_JSON_DB: EnvValue.fromValue("true"),
    MICROBIN_HASH_IDS: EnvValue.fromValue("true"),
    MICROBIN_TITLE: EnvValue.fromValue("Cmdcentral Paste"),
  },
  extraIngressHosts: ["p.cmdcentral.xyz", "share.cmdcentral.xyz"],
});

app.synth();

NewKustomize(app.outdir);
