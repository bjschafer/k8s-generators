import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, Probe } from "cdk8s-plus-34";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, NONROOT_SECURITY_CONTEXT_UID, TZ } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { WellKnownLabels } from "../../lib/labels";
import { OpenBaoSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

// print-dis: the print request queue (github.com/bjschafer/print-dis).
// Stateless: requests live in prod Postgres, uploads in the print-dis bucket
// on versitygw. Reachable from the internet through the cmdcentral tunnel,
// behind Cloudflare Access (tf/cloudflare); who may sign in is the
// "print-dis users" group in tf/authentik.
const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

const image = "ghcr.io/bjschafer/print-dis";
const port = 8080;
const host = "prints.cmdcentral.xyz";

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
        image: image,
        strategy: "digest",
        versionConstraint: "main",
      },
    ],
  },
});

const dbCreds = createAppDatabaseSecret(app, "printdis");

// client_id / client_secret, published by tf/authentik (local.kv_oauth2_clients).
const oidc = new OpenBaoSecret(app, "authentik", {
  name: "authentik",
  namespace: namespace,
  keys: ["client_id", "client_secret"],
});

// The print-dis account and bucket on versitygw (vmhost03).
const s3 = new OpenBaoSecret(app, "s3", {
  name: "s3",
  namespace: namespace,
  keys: ["access_key_id", "secret_access_key"],
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:main`,
  resources: {
    cpu: {
      request: Cpu.millis(20),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(256),
    },
  },
  labels: {
    [WellKnownLabels.Name]: name,
    [WellKnownLabels.ManagedBy]: "generators",
  },
  ports: [{ number: port, name: "http" }],
  ingressHosts: [{ host: host }],
  ingressLabels: {
    "cmdcentral.xyz/external": "true",
  },
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
    BASE_URL: EnvValue.fromValue(`https://${host}`),
    // Declaration order matters: $(DB_PASSWORD) only expands against env vars
    // declared earlier in the container. The primary, not the pooler, because
    // migrations run at boot.
    DB_PASSWORD: EnvValue.fromSecretValue({ secret: dbCreds.secret, key: "password" }),
    DATABASE_URL: EnvValue.fromValue(
      "postgres://printdis:$(DB_PASSWORD)@prod.postgres.svc.cluster.local:5432/printdis",
    ),
    // Authentik's issuer carries a trailing slash, and go-oidc matches it exactly.
    OIDC_ISSUER: EnvValue.fromValue("https://login.cmdcentral.xyz/application/o/print-dis/"),
    OIDC_CLIENT_ID: EnvValue.fromSecretValue({ secret: oidc.secret, key: "client_id" }),
    OIDC_CLIENT_SECRET: EnvValue.fromSecretValue({ secret: oidc.secret, key: "client_secret" }),
    ADMIN_GROUP: EnvValue.fromValue("print-dis admins"),
    SPOOLMAN_URL: EnvValue.fromValue("http://spoolman.spoolman.svc.cluster.local:8000"),
    // The link-preview fetch refuses private addresses; Manyfold resolves to
    // the ingress, which is one.
    PREVIEW_ALLOW_HOSTS: EnvValue.fromValue("manyfold.cmdcentral.xyz,models.cmdcentral.xyz"),
    FILES_BACKEND: EnvValue.fromValue("s3"),
    // Path-style is hard-coded in the app; versitygw needs it.
    S3_ENDPOINT: EnvValue.fromValue("https://s3.cmdcentral.xyz"),
    S3_REGION: EnvValue.fromValue("us-east-1"),
    S3_BUCKET: EnvValue.fromValue("print-dis"),
    S3_ACCESS_KEY_ID: EnvValue.fromSecretValue({ secret: s3.secret, key: "access_key_id" }),
    S3_SECRET_ACCESS_KEY: EnvValue.fromSecretValue({ secret: s3.secret, key: "secret_access_key" }),
  },
  // distroless/static:nonroot runs as 65532 and writes nothing to disk:
  // uploads are streamed straight to S3.
  securityContext: NONROOT_SECURITY_CONTEXT_UID(65532, 65532),
  containerSecurityContext: {
    ...NONROOT_SECURITY_CONTEXT_UID(65532, 65532),
    readOnlyRootFilesystem: true,
  },
  readinessProbe: Probe.fromHttpGet("/readyz", { port: port }),
  livenessProbe: Probe.fromHttpGet("/healthz", { port: port }),
  // Migrations run before the listener comes up.
  startupProbe: Probe.fromHttpGet("/healthz", {
    port: port,
    failureThreshold: 30,
    periodSeconds: Duration.seconds(2),
  }),
});

app.synth();

NewKustomize(app.outdir);
