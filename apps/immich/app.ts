import { App, Size } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NFSVolumeContainer } from "../../lib/nfs";
import { NewKustomize } from "../../lib/kustomize";
import { NewArgoApp } from "../../lib/argo";
import { Redis } from "../../lib/redis";
import { Quantity } from "../../imports/k8s";
import { AppPlus } from "../../lib/app-plus";
import {
  ConfigMap,
  Cpu,
  Env,
  EnvValue,
  PersistentVolumeAccessMode,
  Probe,
  Volume,
} from "cdk8s-plus-32";
import { StorageClass } from "../../lib/volume";
import { BitwardenSecret } from "../../lib/secrets";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { WellKnownLabels } from "../../lib/labels";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

const version = "v1.135.3";

NewArgoApp(namespace, {
  namespace: namespace,
});

const nfsVol = new NFSVolumeContainer(app, "nfs-volume-container");
nfsVol.Add("nfs-media-pictures", {
  exportPath: "/warp/Media/Pictures",
});

const dbCreds = new BitwardenSecret(app, "dbcreds", {
  name: "db-creds",
  namespace: namespace,
  data: {
    DB_PASSWORD: "1997c120-dc1b-4de6-8a69-b3120136b812",
  },
});

const commonEnv: Record<string, EnvValue> = {
  IMMICH_MACHINE_LEARNING_URL: EnvValue.fromValue(
    "http://immich-machine-learning:3003",
  ),
  REDIS_HOSTNAME: EnvValue.fromValue("redis"),
  DB_DATABASE_NAME: EnvValue.fromValue("immich"),
  DB_HOSTNAME: EnvValue.fromValue("immich-pg16-rw.postgres.svc.cluster.local"),
  DB_PORT: EnvValue.fromValue("5432"),
  DB_USERNAME: EnvValue.fromValue("immich"),
  ...dbCreds.toEnvValues(),
};

new Redis(app, "redis", {
  name: "redis",
  namespace: namespace,
  version: "7.4",
  resources: {
    requests: {
      cpu: Quantity.fromString("100m"),
      memory: Quantity.fromString("64Mi"),
    },
    limits: {
      cpu: Quantity.fromString("100m"),
      memory: Quantity.fromString("64Mi"),
    },
  },
});

const server = new AppPlus(app, "immich-server", {
  name: "immich-server",
  namespace: namespace,
  image: `ghcr.io/immich-app/immich-server:${version}`,
  resources: {
    cpu: {
      request: Cpu.millis(2000),
    },
    memory: {
      request: Size.gibibytes(1.5),
      limit: Size.gibibytes(4),
    },
  },
  ports: [2283],
  livenessProbe: Probe.fromHttpGet("/server-info/ping", {
    port: 2283,
  }),
  readinessProbe: Probe.fromHttpGet("/server-info/ping", {
    port: 2283,
  }),
  monitoringConfig: {
    port: 8081,
  },
  extraEnv: {
    IMMICH_WORKERS_INCLUDE: EnvValue.fromValue("api"),
    IMMICH_TELEMETRY_INCLUDE: EnvValue.fromValue("all"),
    ...commonEnv,
  },
  extraIngressHosts: ["photos.cmdcentral.xyz"],
  labels: {
    [WellKnownLabels.Name]: "immich",
    [WellKnownLabels.Component]: "server",
  },
});

const nfsMount = Volume.fromPersistentVolumeClaim(
  app,
  "nfs-mount",
  nfsVol.Get("nfs-media-pictures").pvc,
);
server.Deployment.addVolume(nfsMount);
server.Deployment.containers[0].mount("/opt/pictures", nfsMount);
server.Deployment.containers[0].mount("/usr/src/app/upload", nfsMount, {
  subPath: "immich",
});

new AppPlus(app, "immich-machine-learning", {
  name: "immich-machine-learning",
  namespace: namespace,
  image: `ghcr.io/immich-app/immich-machine-learning:${version}`,
  resources: {
    cpu: {
      request: Cpu.millis(1500),
    },
    memory: {
      request: Size.mebibytes(512),
      limit: Size.gibibytes(4),
    },
  },
  extraEnv: {
    ...commonEnv,
    TRANSFORMERS_CACHE: EnvValue.fromValue("/cache"),
  },
  ports: [3003],
  livenessProbe: Probe.fromHttpGet("/ping"),
  readinessProbe: Probe.fromHttpGet("/ping"),
  disableIngress: true,
  volumes: [
    {
      name: "cache",
      mountPath: "/cache",
      enableBackups: false,
      props: {
        storageClassName: StorageClass.CEPHFS,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_MANY],
        storage: Size.gibibytes(5),
      },
    },
  ],
  labels: {
    [WellKnownLabels.Name]: "immich",
    [WellKnownLabels.Component]: "machine-learning",
  },
});

const microservices = new AppPlus(app, "immich-microservices", {
  name: "immich-microservices",
  namespace: namespace,
  image: `ghcr.io/immich-app/immich-server:${version}`,
  resources: {
    cpu: {
      request: Cpu.millis(2000),
    },
    memory: {
      request: Size.gibibytes(2),
      limit: Size.gibibytes(6),
    },
  },
  ports: [3001],
  monitoringConfig: {
    port: 8082,
  },
  livenessProbe: Probe.fromHttpGet("/server-info/ping", {
    port: 3001,
  }),
  readinessProbe: Probe.fromHttpGet("/server-info/ping", {
    port: 3001,
  }),
  extraEnv: {
    ...commonEnv,
    IMMICH_WORKERS_EXCLUDE: EnvValue.fromValue("api"),
    IMMICH_TELEMETRY_INCLUDE: EnvValue.fromValue("all"),
    ...dbCreds.toEnvValues(),
  },
  disableIngress: true,
  labels: {
    [WellKnownLabels.Name]: "immich",
    [WellKnownLabels.Component]: "microservices",
  },
});
microservices.Deployment.addVolume(nfsMount);
microservices.Deployment.containers[0].mount("/opt/pictures", nfsMount);
microservices.Deployment.containers[0].mount("/usr/src/app/upload", nfsMount, {
  subPath: "immich",
});

new CmdcentralServiceMonitor(app, "server-monitoring", {
  name: "immich-server",
  namespace: namespace,
  matchLabels: {
    [WellKnownLabels.Name]: "immich",
    [WellKnownLabels.Component]: "server",
  },
});

new CmdcentralServiceMonitor(app, "microservices-monitoring", {
  name: "immich-server",
  namespace: namespace,
  matchLabels: {
    [WellKnownLabels.Name]: "immich",
    [WellKnownLabels.Component]: "microservices",
  },
});

app.synth();
NewKustomize(app.outdir);
