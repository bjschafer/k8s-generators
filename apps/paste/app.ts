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
  Secret,
} from "cdk8s-plus-33";
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

const secrets = Secret.fromSecretName(app, `${name}-secrets`, "secrets");

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
      mountPath: "/app",
      enableBackups: false,
      props: {
        storage: Size.gibibytes(25),
        storageClassName: StorageClass.CEPH_RBD,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      },
    },
  ],
  extraEnv: {
    MICROBIN_ADMIN_USERNAME: EnvValue.fromValue("bschafer"),
    MICROBIN_ADMIN_PASSWORD: EnvValue.fromSecretValue({
      secret: secrets,
      key: "MICROBIN_ADMIN_PASSWORD",
    }),
    MICROBIN_DEFAULT_EXPIRY: EnvValue.fromValue("1week"),
    MICROBIN_DISABLE_TELEMETRY: EnvValue.fromValue("true"),
    MICROBIN_ENABLE_READONLY: EnvValue.fromValue("true"),
    MICROBIN_GC_DAYS: EnvValue.fromValue("0"),
    MICROBIN_HASH_IDS: EnvValue.fromValue("true"),
    MICROBIN_HIDE_FOOTER: EnvValue.fromValue("true"),
    MICROBIN_HIDE_LOGO: EnvValue.fromValue("true"),
    MICROBIN_HIGHLIGHTSYNTAX: EnvValue.fromValue("true"),
    MICROBIN_PRIVATE: EnvValue.fromValue("true"),
    MICROBIN_PUBLIC_PATH: EnvValue.fromValue("https://paste.cmdcentral.xyz/"),
    MICROBIN_QR: EnvValue.fromValue("true"),
    MICROBIN_TITLE: EnvValue.fromValue("Cmdcentral Paste"),
  },
  extraIngressHosts: ["p.cmdcentral.xyz", "share.cmdcentral.xyz"],
});

app.synth();

NewKustomize(app.outdir);
