import { App, Size, Yaml } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS, RELOADER_ENABLED } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { BitwardenSecret } from "../../lib/secrets";
import { AppPlus } from "../../lib/app-plus";
import { Cpu, EnvValue, Probe } from "cdk8s-plus-32";
import { DataConfigMap } from "../../lib/config";
import { NewKustomize } from "../../lib/kustomize";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { WellKnownLabels } from "../../lib/labels";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(name));
const image = "ghcr.io/gotify/server";
const port = 80;

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "digest",
      },
      {
        image: "ghcr.io/druggeri/alertmanager_gotify_bridge",
        strategy: "semver",
        versionConstraint: "2.x.x",
      },
    ],
  },
});

const dbCreds = new BitwardenSecret(app, "db-creds", {
  name: "secrets",
  namespace: namespace,
  data: {
    DB_PASSWORD: "c34eb868-9512-42a7-b168-b2bc00337830",
    GOTIFY_DEFAULTUSER_PASS: "ac003e8d-8fdf-4e58-ab3b-b2bc018a3dfc",
  },
});

new DataConfigMap(app, "config", {
  name: "config",
  namespace: namespace,
  data: {
    "config.yml": Yaml.stringify({
      server: {
        keepaliveperiodseconds: 0, // 0 = use Go default(15s); - 1 = disable keepalive; set the interval in which keepalive packets will be sent.Only change this value if you know what you are doing.
        listenaddr: "", // the address to bind on, leave empty to bind on all addresses.Prefix with "unix:" to create a unix socket.Example: "unix:/tmp/gotify.sock".
        port: 80, // the port the HTTP server will listen on

        ssl: {
          // handled via ingress
          enabled: false, // if https should be enabled
          redirecttohttps: false, // redirect to https if site is accessed by http
          listenaddr: "", // the address to bind on, leave empty to bind on all addresses.Prefix with "unix:" to create a unix socket.Example: "unix:/tmp/gotify.sock".
          port: 443, // the https port
        },

        responseheaders: {}, // response headers are added to every response(default : none)
        trustedproxies: ["127.0.0.1/8", "10.42.0.0/16", "10.43.0.0/16"], // IPs or IP ranges of trusted proxies.Used to obtain the remote ip via the X- Forwarded - For header. (configure 127.0.0.1 to trust sockets)

        cors: {
          // Sets cors headers only when needed and provides support for multiple allowed origins.Overrides Access-Control-* Headers in response headers.
          alloworigins: [],
          // - ".+.example.com"
          // - "otherdomain.com"
          allowmethods: [],
          // - "GET"
          // - "POST"
          allowheaders: [],
          // - "Authorization"
          // - "content-type"
        },
        stream: {
          pingperiodseconds: 45, // the interval in which websocket pings will be sent.Only change this value if you know what you are doing.
          allowedorigins: [], // allowed origins for websocket connections(same origin is always allowed)
          // - ".+.example.com"
          // - "otherdomain.com"
        },

        passstrength: 10, // the bcrypt password strength(higher = better but also slower)
        uploadedimagesdir: "data/images", // the directory for storing uploaded images
        pluginsdir: "data/plugins", // the directory where plugin resides
        registration: false, // enable registrations
      },
    }),
  },
});

new AppPlus(app, "gotify", {
  name: name,
  namespace: namespace,
  image: image,
  resources: {
    cpu: {
      request: Cpu.millis(100),
      limit: Cpu.millis(100),
    },
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(128),
    },
  },
  annotations: {
    ...RELOADER_ENABLED,
  },
  ports: [port],
  livenessProbe: Probe.fromHttpGet("/", { port: port }),
  readinessProbe: Probe.fromHttpGet("/", { port: port }),
  extraEnv: {
    DB_PASSWORD: EnvValue.fromSecretValue({
      secret: dbCreds.secret,
      key: "DB_PASSWORD",
    }),
    GOTIFY_DATABASE_CONNECTION: EnvValue.fromValue(
      "host=prod.postgres.svc.cluster.local port=5432 user=gotify dbname=gotify password=$(DB_PASSWORD)",
    ),
    GOTIFY_DATABASE_DIALECT: EnvValue.fromValue("postgres"),
    GOTIFY_DEFAULTUSER_NAME: EnvValue.fromValue("bschafer"),
    GOTIFY_DEFAULTUSER_PASS: EnvValue.fromSecretValue({
      secret: dbCreds.secret,
      key: "GOTIFY_DEFAULTUSER_PASS",
    }),
  },
  volumes: [
    {
      name: "data",
      mountPath: "/app/data",
      enableBackups: true,
      props: {
        storage: Size.gibibytes(5),
      },
    },
  ],
  configmapMounts: [
    {
      mountPath: "/etc/gotify/config.yml",
      name: "config",
      subPath: "config.yml",
    },
  ],
  extraIngressHosts: ["notifications.cmdcentral.xyz", "notify.cmdcentral.xyz"],
});

const amToken = new BitwardenSecret(app, "am-token", {
  name: "am-token",
  namespace: namespace,
  data: {
    GOTIFY_TOKEN: "1e2958be-ffa8-4c2b-a49e-b2cc01018abd",
  },
});

new AppPlus(app, "am-bridge", {
  name: "alertmanager-bridge",
  namespace: namespace,
  image: "ghcr.io/druggeri/alertmanager_gotify_bridge",
  resources: {
    cpu: {
      request: Cpu.millis(50),
      limit: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(64),
    },
  },
  ports: [8080],
  extraEnv: {
    GOTIFY_ENDPOINT: EnvValue.fromValue(
      `http://${name}.${namespace}.svc.cluster.local:${port}/message`,
    ),
    GOTIFY_TOKEN: EnvValue.fromSecretValue({
      secret: amToken.secret,
      key: "GOTIFY_TOKEN",
    }),
  },
});

new CmdcentralServiceMonitor(app, "am-bridge-sm", {
  name: "am-bridge",
  namespace: namespace,
  matchLabels: {
    [WellKnownLabels.Name]: "alertmanager-bridge",
  },
  portName: "http",
});

app.synth();

NewKustomize(app.outdir);
