import { App, Size, Yaml } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { BitwardenSecret } from "../../lib/secrets";
import { AppPlus } from "../../lib/app-plus";
import { Cpu, EnvValue, Probe } from "cdk8s-plus-32";
import { DataConfigMap } from "../../lib/config";
import { NewKustomize } from "../../lib/kustomize";

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

        responseheaders: [], // response headers are added to every response(default : none)
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

        database: {
          // for database see(configure database section)
          dialect: "postgres",
          // connection configured via environment
        },

        defaultuser: {
          // on database creation, gotify creates an admin user
          name: "bschafer", // the username of the default user
          // pass configured via environment
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

app.synth();

NewKustomize(app.outdir);
