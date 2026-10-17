import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, Probe } from "cdk8s-plus-34";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, NONROOT_SECURITY_CONTEXT_UID } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { OpenBaoSecret } from "../../lib/secrets";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 3000;

const image = "registry.cmdcentral.xyz/cmdcentral/noms";

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        versionConstraint: "main",
        strategy: "digest",
      },
    ],
  },
});

// Create a copy of the database credentials in this namespace
// The database and role are defined in apps/postgres/databases.ts
const dbCreds = createAppDatabaseSecret(app, "noms");
const nomsSecrets = new OpenBaoSecret(app, "noms-secrets", {
  name: "secrets",
  namespace: namespace,
  keys: ["CF_API_TOKEN", "BRAVE_API_KEY", "PUSHOVER_APP_TOKEN"],
  refs: {
    CF_ACCOUNT_ID: { path: "_all/cloudflare-account-id", property: "value" },
    PUSHOVER_USER_KEY: { path: "_all/pushover-user-key", property: "value" },
  },
});

new AppPlus(app, name, {
  name: name,
  namespace: namespace,
  image: `${image}:main`,
  ports: [port],
  // image ships USER bun, uid/gid 1000
  securityContext: NONROOT_SECURITY_CONTEXT_UID(1000, 1000),
  containerSecurityContext: NONROOT_SECURITY_CONTEXT_UID(1000, 1000),
  resources: {
    cpu: {
      request: Cpu.millis(100),
      limit: Cpu.millis(750),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(256),
    },
  },
  extraEnv: {
    ...nomsSecrets.toEnvValues(),
    TZ: EnvValue.fromValue("America/Chicago"),
    LLM_PROVIDER: EnvValue.fromValue("cloudflare"),
    CF_GATEWAY_ID: EnvValue.fromValue("cmdcentral"),
    LLM_MODEL: EnvValue.fromValue("@cf/openai/gpt-oss-120b"),
    PORT: EnvValue.fromValue(port.toString()),

    DB_HOST: EnvValue.fromValue("prod.postgres.svc.cluster.local"),
    DB_PORT: EnvValue.fromValue("5432"),
    DB_NAME: EnvValue.fromValue(name),
    DB_USER: EnvValue.fromValue(name),
    DB_PASSWORD: EnvValue.fromSecretValue({
      secret: dbCreds.secret,
      key: "password",
    }),

    WEB_SEARCH_ENABLED: EnvValue.fromValue("true"),
    WEB_SEARCH_PROVIDER: EnvValue.fromValue("brave"),
    SEARCH_CLASSIFIER_MODEL: EnvValue.fromValue("@cf/meta/llama-3.2-3b-instruct"),
  },
  livenessProbe: Probe.fromHttpGet("/health", {
    initialDelaySeconds: Duration.seconds(10),
    failureThreshold: 3,
    port: port,
  }),
  readinessProbe: Probe.fromHttpGet("/health", {
    initialDelaySeconds: Duration.seconds(10),
    failureThreshold: 3,
    port: port,
  }),
});

app.synth();
NewKustomize(app.outdir);
