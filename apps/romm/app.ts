import { App, Size } from "cdk8s";
import { Cpu, EnvValue, Volume } from "cdk8s-plus-33";
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

const image = "ghcr.io/rommapp/romm";

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
nfsVol.Add("nfs-media-roms", {
  exportPath: "/warp/Media/Roms",
});

// Create a copy of the database credentials in this namespace
// The database and role are defined in apps/postgres/databases.ts
const dbCreds = createAppDatabaseSecret(app, "romm");

const rommSecrets = new BitwardenSecret(app, "romm-secrets", {
  name: "romm-secrets",
  namespace: namespace,
  data: {
    ROMM_AUTH_SECRET_KEY: "a3aba159-fc66-439f-a5e3-b392004420dc",
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
  ports: [8080],
  resources: {
    cpu: {
      request: Cpu.millis(100),
    },
    memory: {
      request: Size.mebibytes(256),
    },
  },
  extraIngressHosts: ["roms.cmdcentral.xyz"],
  extraEnv: {
    DB_HOST: EnvValue.fromValue("prod.postgres.svc.cluster.local"),
    DB_PORT: EnvValue.fromValue("5432"),
    DB_NAME: EnvValue.fromValue(name),
    DB_USER: EnvValue.fromValue(name),
    DB_PASSWD: EnvValue.fromSecretValue({
      secret: dbCreds.secret,
      key: "password",
    }),
    ROMM_DB_DRIVER: EnvValue.fromValue("postgresql"),
    REDIS_HOST: EnvValue.fromValue(valkey.Service.name),
    REDIS_PASSWORD: EnvValue.fromSecretValue({
      secret: valkey.secret,
      key: "valkey-password",
    }),
    TZ: EnvValue.fromValue("America/Chicago"),
    ...rommSecrets.toEnvValues(),
    /*
      - SCREENSCRAPER_USER= # These are the recommended metadata providers
      - SCREENSCRAPER_PASSWORD= # https://docs.romm.app/latest/Getting-Started/Metadata-Providers/#screenscraper
      - RETROACHIEVEMENTS_API_KEY= # https://docs.romm.app/latest/Getting-Started/Metadata-Providers/#retroachievements
      - STEAMGRIDDB_API_KEY= # https://docs.romm.app/latest/Getting-Started/Metadata-Providers/#steamgriddb
      - HASHEOUS_API_ENABLED=true # https://docs.romm.app/latest/Getting-Started/Metadata-Providers/#hasheous
      */
  },
  volumes: [
    {
      name: "data",
      mountPath: "/romm",
      enableBackups: true,
      props: {
        storage: Size.gibibytes(20),
      },
    },
  ],
});

const nfsMount = Volume.fromPersistentVolumeClaim(
  app,
  "nfs-media-roms",
  nfsVol.Get("nfs-media-roms").pvc,
);
server.Deployment.addVolume(nfsMount);
server.Deployment.containers[0].mount("/romm/library", nfsMount, {
  subPath: "managed",
});

app.synth();
NewKustomize(app.outdir);
