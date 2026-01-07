import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, Probe } from "cdk8s-plus-33";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { BitwardenSecret } from "../../lib/secrets";
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
const nomsSecrets = new BitwardenSecret(app, "noms-secrets", {
  name: "secrets",
  namespace: namespace,
  data: {
    CF_ACCOUNT_ID: "8be44aed-b92e-49dd-9c58-b3c901742785",
    CF_API_TOKEN: "06b6eb68-a6a9-4715-b2ab-b3c90174460c",
    BRAVE_API_KEY: "8fe64461-304b-4ea1-9e3d-b3cb0024d794",
  },
});

new AppPlus(app, name, {
  name: name,
  namespace: namespace,
  image: `${image}:main`,
  ports: [port],
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
    SEARCH_CLASSIFIER_MODEL: EnvValue.fromValue(
      "@cf/meta/llama-3.2-3b-instruct",
    ),
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
