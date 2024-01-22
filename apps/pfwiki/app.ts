import { App, Size } from "cdk8s";
import {
  Cpu,
  EnvValue,
  PersistentVolumeAccessMode,
  Probe,
  Secret,
} from "cdk8s-plus-27";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { MysqlInstance } from "../../lib/mysql";
import { basename } from "../../lib/util";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 80;

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
        image: "lscr.io/linuxserver/bookstack",
        strategy: "digest",
      },
    ],
  },
});

new MysqlInstance(app, "db", {
  namespace: namespace,
  instance: namespace,
  enableBackups: true,
  resources: {
    memory: {
      limit: Size.mebibytes(512),
      request: Size.mebibytes(128),
    },
    cpu: {
      request: Cpu.millis(50),
    },
  },
  pvcSize: Size.gibibytes(20),
});

new AppPlus(app, "pfwiki", {
  name: "pfwiki",
  namespace: namespace,
  image: "lscr.io/linuxserver/bookstack:latest",
  resources: {
    cpu: {
      request: Cpu.millis(150),
    },
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(512),
    },
  },
  ports: [port],
  livenessProbe: Probe.fromHttpGet("", { port: port }),
  readinessProbe: Probe.fromHttpGet("", { port: port }),
  volumes: [
    {
      name: "data",
      mountPath: "/config",
      enableBackups: true,
      props: {
        storage: Size.gibibytes(5),
        storageClassName: StorageClass.CEPH_RBD,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      },
    },
  ],
  extraEnv: {
    TZ: EnvValue.fromValue("America/Chicago"),
    APP_URL: EnvValue.fromValue("https://pfwiki.cmdcentral.xyz"),
    DB_HOST: EnvValue.fromValue("db"),
    DB_PORT: EnvValue.fromValue("3306"),
    DB_USER: EnvValue.fromValue("root"),
    DB_PASS: EnvValue.fromSecretValue({
      secret: Secret.fromSecretName(app, "app-creds", "db-creds"),
      key: "MARIADB_ROOT_PASSWORD",
    }),
    DB_DATABASE: EnvValue.fromValue("bookstack"),
  },
  extraIngressHosts: ["pathfinder.cmdcentral.xyz"],
});

app.synth();
