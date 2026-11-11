import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, Probe, Volume } from "cdk8s-plus-34";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, NONROOT_SECURITY_CONTEXT_UID, TZ } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 3000;

// Served under one name only. STL Quest derives its public origin from the
// forwarded Host header and rejects state-changing requests from any other
// origin, so a second hostname would be a second thing to keep trusted (and a
// second OIDC redirect URI).
const domain = "prints.cmdcentral.xyz";

const image = "ghcr.io/richardsolomou/stl.quest";

// The image's USER is `node` by name, which the kubelet cannot check against
// runAsNonRoot, so the uid is spelled out.
const NODE_UID = 1000;

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

// Create a copy of the database credentials in this namespace
// The database and role are defined in apps/postgres/databases.ts
const dbCreds = createAppDatabaseSecret(app, name);

const stlquest = new AppPlus(app, name, {
  name: name,
  namespace: namespace,
  image: `${image}:latest`,
  ports: [port],
  resources: {
    cpu: {
      request: Cpu.millis(100),
      limit: Cpu.units(2),
    },
    memory: {
      request: Size.mebibytes(256),
      limit: Size.gibibytes(2),
    },
  },
  ingressHosts: [{ host: domain }],
  // fsGroup is what makes the freshly provisioned RBD volumes writable for a
  // process that never runs as root.
  securityContext: { ...NONROOT_SECURITY_CONTEXT_UID(NODE_UID, NODE_UID), fsGroup: NODE_UID },
  // Upstream's compose file runs the image read-only with a tmpfs at /tmp, so
  // this is the supported shape rather than an experiment.
  containerSecurityContext: {
    ...NONROOT_SECURITY_CONTEXT_UID(NODE_UID, NODE_UID),
    readOnlyRootFilesystem: true,
  },
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
    // Declaration order matters: Kubernetes expands a $(VAR) reference only
    // against env vars declared *earlier* in the same container, so the
    // password has to precede the URL that interpolates it.
    DB_PASSWORD: EnvValue.fromSecretValue({ secret: dbCreds.secret, key: "password" }),
    // Direct to the primary rather than through the pooler: migrations run on
    // boot, and the pooler's transaction mode is not something to find out
    // about from a half-applied schema.
    DATABASE_URL: EnvValue.fromValue(
      `postgresql://${name}:$(DB_PASSWORD)@prod.postgres.svc.cluster.local:5432/${name}`,
    ),
    // Thumbnail and preview generation. Upstream defaults to 8 jobs sharing a
    // 4 GiB budget, which is sized for a print farm and is twice this
    // container's memory limit.
    ASSET_WORKER_CONCURRENCY: EnvValue.fromValue("2"),
    ASSET_WORKER_MEMORY_MB: EnvValue.fromValue("1024"),
  },
  // /api/health checks the database and upload staging, not just the listener.
  // Migrations run before the server accepts requests, hence the startup probe.
  startupProbe: Probe.fromHttpGet("/api/health", {
    port: port,
    periodSeconds: Duration.seconds(5),
    failureThreshold: 36,
  }),
  livenessProbe: Probe.fromHttpGet("/api/health", { port: port }),
  readinessProbe: Probe.fromHttpGet("/api/health", { port: port }),
  volumes: [
    // Upload staging plus the generated integration-encryption and realtime
    // signing keys. Still required with a remote database; back it up with it.
    {
      name: "data",
      mountPath: "/data",
      props: {
        storage: Size.gibibytes(5),
      },
    },
    // Uploaded models and their generated previews.
    {
      name: "prints",
      mountPath: "/prints",
      props: {
        storage: Size.gibibytes(20),
      },
    },
  ],
});

const tmpVol = Volume.fromEmptyDir(stlquest, "tmp-vol", "tmp");
stlquest.Deployment.addVolume(tmpVol);
stlquest.Deployment.containers[0].mount("/tmp", tmpVol);

app.synth();
NewKustomize(app.outdir);
