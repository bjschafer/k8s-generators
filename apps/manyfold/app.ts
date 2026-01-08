import { App, Size } from "cdk8s";
import { Cpu, EnvValue, Probe, Volume } from "cdk8s-plus-33";
import { Quantity } from "cdk8s-plus-33/lib/imports/k8s";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { NFSVolumeContainer } from "../../lib/nfs";
import { BitwardenSecret } from "../../lib/secrets";
import { Valkey } from "../../lib/valkey";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 3214;

const image = "ghcr.io/manyfold3d/manyfold";

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "digest",
      },
    ],
  },
});

const nfsVol = new NFSVolumeContainer(app, "nfs-volume-container");
nfsVol.Add("nfs-3dprinting", {
  exportPath: "/warp/3DPrinting",
});

// Create a copy of the database credentials in this namespace
// The database and role are defined in apps/postgres/databases.ts
const dbCreds = createAppDatabaseSecret(app, "manyfold");

const manyfoldSecrets = new BitwardenSecret(app, "manyfold-secrets", {
  name: "manyfold-secrets",
  namespace: namespace,
  data: {
    SECRET_KEY_BASE: "b8f60e2c-1436-4365-9c04-b3cc001b52fd",
  },
});

const valkey = new Valkey(app, "valkey", {
  name: name,
  namespace: namespace,
  version: "7-alpine",
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

const server = new AppPlus(app, name, {
  name: name,
  namespace: namespace,
  image: image,
  ports: [port],
  resources: {
    cpu: {
      request: Cpu.units(1),
      limit: Cpu.units(4),
    },
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(256),
    },
  },
  extraEnv: {
    DATABASE_ADAPTER: EnvValue.fromValue("postgresql"),
    DATABASE_HOST: EnvValue.fromValue("prod.postgres.svc.cluster.local"),
    DATABASE_PORT: EnvValue.fromValue("5432"),
    DATABASE_NAME: EnvValue.fromValue(name),
    DATABASE_USER: EnvValue.fromValue(name),
    DATABASE_PASSWORD: EnvValue.fromSecretValue({
      secret: dbCreds.secret,
      key: "password",
    }),
    REDIS_URL: EnvValue.fromValue(`redis://${valkey.Service.name}:6379/1`),
    PUID: EnvValue.fromValue("1006"),
    PGID: EnvValue.fromValue("1004"),
    ...manyfoldSecrets.toEnvValues(),
  },
  livenessProbe: Probe.fromHttpGet("/health", {
    port: port,
  }),
  readinessProbe: Probe.fromHttpGet("/health", {
    port: port,
  }),
  extraIngressHosts: ["models.cmdcentral.xyz", "stls.cmdcentral.xyz"],
});

const nfsMount = Volume.fromPersistentVolumeClaim(
  app,
  "nfs-3dprinting",
  nfsVol.Get("nfs-3dprinting").pvc,
);
server.Deployment.addVolume(nfsMount);
server.Deployment.containers[0].mount("/models", nfsMount, {
  subPath: "STLs",
});

app.synth();
NewKustomize(app.outdir);
