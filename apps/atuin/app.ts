import { App, Size } from "cdk8s";
import {
  Cpu,
  EnvValue,
  PersistentVolumeAccessMode,
  Secret,
} from "cdk8s-plus-29";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { basename } from "../../lib/util";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 8888;

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
        image: "ghcr.io/atuinsh/atuin",
        strategy: "latest", // until and unless they publish any stable tags
      },
    ],
  },
});

new AppPlus(app, "atuin", {
  name,
  namespace,
  image: "ghcr.io/atuinsh/atuin",
  args: ["server", "start"],
  resources: {
    cpu: {
      request: Cpu.millis(5),
    },
    memory: {
      request: Size.mebibytes(32),
      limit: Size.mebibytes(128),
    },
  },
  ports: [port],
  monitoringConfig: {
    port: 9001,
  },
  volumes: [
    {
      name: "data",
      mountPath: "/config",
      enableBackups: true,
      props: {
        storage: Size.gibibytes(1),
        storageClassName: StorageClass.CEPH_RBD,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      },
    },
  ],
  extraEnv: {
    ATUIN_HOST: EnvValue.fromValue("0.0.0.0"), // bind address
    ATUIN_PORT: EnvValue.fromValue("8888"),
    ATUIN_OPEN_REGISTRATION: EnvValue.fromValue("false"),
    ATUIN_DB_URI: EnvValue.fromSecretValue({
      secret: Secret.fromSecretName(app, "db-creds", "db-creds"),
      key: "ATUIN_DB_URI",
    }),
    ATUIN_METRICS__ENABLE: EnvValue.fromValue("true"), // at 9001
    ATUIN_METRICS__HOST: EnvValue.fromValue("0.0.0.0"),
  },
});

app.synth();
