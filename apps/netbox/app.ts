import { App, Chart, Duration, Size } from "cdk8s";
import {
  ConfigMap,
  Cpu,
  EnvFrom,
  EnvValue,
  PersistentVolume,
  PersistentVolumeAccessMode,
  Probe,
} from "cdk8s-plus-34";
import { Construct } from "constructs";
import { readFileSync } from "fs";
import { basename, join } from "path";
import { Quantity } from "../../imports/k8s";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, RELOADER_ENABLED } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { WellKnownLabels } from "../../lib/labels";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { BitwardenSecret } from "../../lib/secrets";
import { Valkey, VALKEY_VERSION } from "../../lib/valkey";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 8080;
// Renovate watches this for v5 only; the updater already moves it within v4
// (constraint below derives from this same const, so the two cannot disagree).
// renovate: datasource=docker depName=netboxcommunity/netbox
const netboxVersion = "v4.6.5";
const image = `netboxcommunity/netbox:${netboxVersion}`;

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: "netboxcommunity/netbox",
        strategy: "semver",
        versionConstraint: `${netboxVersion.split(".")[0]}.x.x`,
        // upstream also publishes `vX.Y.Z-a.b.c` (netbox-docker build) and
        // `snapshot`/`feature` tags -- only take plain releases.
        allowTags: "^v[0-9]+\\.[0-9]+\\.[0-9]+$",
      },
      {
        image: "ghcr.io/valkey-io/valkey",
        strategy: "semver",
        versionConstraint: VALKEY_VERSION,
        allowTags: "^[v]?[0-9]+\\.[0-9]+\\.[0-9]+$",
      },
    ],
  },
});

const dbCreds = new BitwardenSecret(app, "db-creds", {
  name: "db-creds",
  namespace: namespace,
  data: {
    password: "421b33c5-ec6c-40ec-a488-b47e01827cbc",
  },
});

// Django SECRET_KEY -- signs sessions/CSRF. Regenerating it only forces re-login.
const netboxSecret = new BitwardenSecret(app, "netbox-secret", {
  name: name,
  namespace: namespace,
  data: {
    SECRET_KEY: "1131094d-5258-4d6f-bf9d-b47e01827d5c",
  },
});

const oidcSecret = new BitwardenSecret(app, "oidc", {
  name: "oidc",
  namespace: namespace,
  data: {
    SOCIAL_AUTH_OIDC_KEY: "63035698-a60b-4ea0-915d-b47e01827df8",
    SOCIAL_AUTH_OIDC_SECRET: "ce4cbbd8-3fa5-44da-bdef-b47e01827e30",
  },
});

// One valkey serves both roles netbox needs: the RQ task queue (database 0) and the
// django cache (database 1). No --maxmemory/eviction policy: netbox's cache entries
// are written without a TTL, so there's nothing an eviction policy is allowed to
// reclaim without also dropping queued jobs. The container limit is the bound, as it
// was when these were two separate instances.
const valkey = new Valkey(app, "valkey", {
  name: name,
  namespace: namespace,
  version: VALKEY_VERSION,
  password: "netbox",
  resources: {
    requests: {
      cpu: Quantity.fromString("50m"),
      memory: Quantity.fromString("64Mi"),
    },
    limits: {
      memory: Quantity.fromString("256Mi"),
    },
  },
});

class NetboxConfig extends Chart {
  public readonly config: ConfigMap;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.config = new ConfigMap(this, "config", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      data: {
        DB_HOST: "prod.postgres.svc.cluster.local",
        DB_NAME: name,
        DB_PORT: "5432",
        DB_USER: name,

        EMAIL_FROM: "netbox@cmdcentral.xyz",

        // REDIS_CACHE_* falls back to the corresponding REDIS_* value in netbox's
        // configuration.py, so only the differing database index is set here.
        REDIS_HOST: valkey.Service.name,
        REDIS_PORT: "6379",
        REDIS_SSL: "false",
        REDIS_DATABASE: "0",
        REDIS_CACHE_DATABASE: "1",

        REMOTE_AUTH_AUTO_CREATE_USER: "true",
        REMOTE_AUTH_BACKEND: "social_core.backends.open_id_connect.OpenIdConnectAuth",
        REMOTE_AUTH_ENABLED: "true",

        SOCIAL_AUTH_OIDC_OIDC_ENDPOINT: "https://login.cmdcentral.xyz/application/o/netbox/",
        SOCIAL_AUTH_OIDC_SCOPE: '["openid", "profile", "email", "roles"]',
        LOGOUT_REDIRECT_URL: "https://login.cmdcentral.xyz/application/o/netbox/end-session/",

        LOGIN_PERSISTENCE: "true",

        METRICS_ENABLED: "true", // served on the http port under /metrics
      },
    });

    // Extra django settings netbox merges in from /etc/netbox/config, plus the
    // social-auth pipeline that maps authentik groups onto netbox groups/roles.
    new ConfigMap(this, "authentik", {
      metadata: {
        name: "authentik",
        namespace: namespace,
      },
      data: {
        "authentik.py": readFileSync(join(__dirname, "config", "authentik.py"), "utf-8"),
        "custom_pipeline.py": readFileSync(
          join(__dirname, "config", "custom_pipeline.py"),
          "utf-8",
        ),
      },
    });
  }
}

const config = new NetboxConfig(app, "netbox-config");

const sharedEnvFrom = [
  new EnvFrom(config.config, undefined, undefined),
  new EnvFrom(undefined, undefined, netboxSecret.secret),
  new EnvFrom(undefined, undefined, oidcSecret.secret),
];

const sharedEnv = {
  REDIS_PASSWORD: EnvValue.fromSecretValue({
    secret: valkey.secret!,
    key: "valkey-password",
  }),
  DB_PASSWORD: EnvValue.fromSecretValue({
    secret: dbCreds.secret,
    key: "password",
  }),
};

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: image,
  replicas: 2,
  annotations: RELOADER_ENABLED,
  labels: {
    [WellKnownLabels.Name]: name,
    [WellKnownLabels.Component]: "app",
  },
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.gibibytes(1),
      limit: Size.gibibytes(2),
    },
  },
  ports: [{ number: port, name: "http" }],
  envFrom: sharedEnvFrom,
  extraEnv: sharedEnv,
  // netbox runs db migrations on boot, which can take a while on a version bump.
  startupProbe: Probe.fromTcpSocket({
    port: port,
    initialDelaySeconds: Duration.seconds(15),
    periodSeconds: Duration.seconds(5),
    failureThreshold: 30,
  }),
  readinessProbe: Probe.fromTcpSocket({
    port: port,
    initialDelaySeconds: Duration.seconds(15),
    periodSeconds: Duration.seconds(10),
  }),
  volumes: [
    {
      name: "data",
      mountPath: "/etc/netbox/media",
      props: {
        storage: Size.gibibytes(5),
        storageClassName: StorageClass.CEPHFS,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_MANY],
        // Pinned to the volume that has held netbox's uploaded media since 2022.
        // Without this the claim is satisfied by dynamic provisioning, so anything
        // that recreates it (a namespace prune, say) silently comes back empty.
        volume: PersistentVolume.fromPersistentVolumeName(
          app,
          "netbox-media-pv",
          "pvc-ee0b6284-d5ba-4d57-8464-fdedfccb61b9",
        ),
      },
    },
  ],
  configmapMounts: [
    {
      name: "authentik",
      mountPath: "/etc/netbox/config/authentik.py",
      subPath: "authentik.py",
    },
    {
      name: "authentik",
      mountPath: "/opt/netbox/netbox/netbox/custom_pipeline.py",
      subPath: "custom_pipeline.py",
    },
  ],
  enableServiceLinks: false,
});

// Runs the RQ queue that backs scripts, reports, webhooks, and housekeeping.
new AppPlus(app, `${name}-worker`, {
  name: `${name}-worker`,
  namespace: namespace,
  image: image,
  annotations: RELOADER_ENABLED,
  labels: {
    [WellKnownLabels.Name]: name,
    [WellKnownLabels.Component]: "worker",
  },
  command: ["/opt/netbox/venv/bin/python3", "/opt/netbox/netbox/manage.py", "rqworker"],
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(128),
      limit: Size.gibibytes(1),
    },
  },
  envFrom: sharedEnvFrom,
  extraEnv: sharedEnv,
  enableServiceLinks: false,
  disableService: true,
  disableIngress: true,
  disableProbes: true,
});

new CmdcentralServiceMonitor(app, "monitoring", {
  name: name,
  namespace: namespace,
  matchLabels: {
    [WellKnownLabels.Name]: name,
    [WellKnownLabels.Component]: "app",
  },
  portName: "http",
});

app.synth();
NewKustomize(app.outdir);
