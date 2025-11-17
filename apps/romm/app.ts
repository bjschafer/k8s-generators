import { App, Duration, Size } from "cdk8s";
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
const port = 8080;

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
    OIDC_CLIENT_SECRET: "c8455351-69c8-4c7b-a2a8-b3970045bc37",
    STEAMGRIDDB_API_KEY: "a8eb88f1-883f-4d4b-8a68-b39500311177",
    IGDB_CLIENT_ID: "dbd8a5ac-244f-45a3-9761-b3950031deac",
    IGDB_CLIENT_SECRET: "55c730d8-d24b-47eb-9243-b3950031f0d9",
    RETROACHIEVEMENTS_API_KEY: "e9deabc9-41bd-4771-ba72-b3950032ac28",
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

    HASHEOUS_API_ENABLED: EnvValue.fromValue("true"),
    HLTB_API_ENABLED: EnvValue.fromValue("true"),

    DISABLE_USERPASS_LOGIN: EnvValue.fromValue("true"),
    OIDC_ENABLED: EnvValue.fromValue("true"),
    OIDC_PROVIDER: EnvValue.fromValue("authentik"),
    OIDC_CLIENT_ID: EnvValue.fromValue(
      "fU7QdKmVDx3WeOV0UGAkUbMNAJsMOX2j7gc7ExX5",
    ),
    OIDC_REDIRECT_URI: EnvValue.fromValue(
      "https://roms.cmdcentral.xyz/api/oauth/openid",
    ),
    OIDC_SERVER_APPLICATION_URL: EnvValue.fromValue(
      "https://login.cmdcentral.xyz/application/o/romm",
    ),

    ROMM_DB_DRIVER: EnvValue.fromValue("postgresql"),
    ROMM_PORT: EnvValue.fromValue(`${port}`), // this seems to be a bug

    REDIS_HOST: EnvValue.fromValue(valkey.Service.name),
    REDIS_PASSWORD: EnvValue.fromSecretValue({
      secret: valkey.secret,
      key: "valkey-password",
    }),

    SCAN_WORKERS: EnvValue.fromValue("4"),

    TZ: EnvValue.fromValue("America/Chicago"),

    ...rommSecrets.toEnvValues(),
  },
  livenessProbe: Probe.fromHttpGet("/api/heartbeat", {
    initialDelaySeconds: Duration.seconds(45),
    failureThreshold: 5,
    port: port,
  }),
  readinessProbe: Probe.fromHttpGet("/api/heartbeat", {
    initialDelaySeconds: Duration.seconds(45),
    failureThreshold: 5,
    port: port,
  }),
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

const dataVolume = server.Deployment.volumes[0];
["assets", "config", "resources"].forEach((path) => {
  server.Deployment.containers[0].mount(`/romm/${path}`, dataVolume, {
    subPath: path,
  });
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
