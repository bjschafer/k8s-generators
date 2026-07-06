import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvFrom, EnvValue, Probe } from "cdk8s-plus-34";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, TZ } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { WellKnownLabels } from "../../lib/labels";
import { BitwardenSecret } from "../../lib/secrets";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 9000;

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: "ghcr.io/mealie-recipes/mealie",
        strategy: "semver",
        versionConstraint: "v3.x.x",
      },
    ],
  },
});

const dbCreds = new BitwardenSecret(app, "db-creds", {
  name: "db-creds",
  namespace: namespace,
  data: {
    POSTGRES_PASSWORD: "6ba20123-688f-4926-9ba9-b47e01820757",
  },
});

const oidcCreds = new BitwardenSecret(app, "oidc-creds", {
  name: "oidc-creds",
  namespace: namespace,
  data: {
    OIDC_CLIENT_SECRET: "ec54b3ed-071d-42bc-a7fd-b47e0182080d",
  },
});

const aiSecrets = new BitwardenSecret(app, "ai-secrets", {
  name: "ai",
  namespace: namespace,
  data: {
    OPENAI_BASE_URL: "90a0d4c6-87fc-4636-9be6-b3c90019c136",
    OPENAI_API_KEY: "8144578e-f1ce-4360-b797-b3c90019d91e",
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: "ghcr.io/mealie-recipes/mealie",
  labels: {
    [WellKnownLabels.Name]: name,
  },
  resources: {
    cpu: {
      request: Cpu.millis(100),
      limit: Cpu.millis(1000),
    },
    memory: {
      request: Size.mebibytes(512),
      limit: Size.mebibytes(1024),
    },
  },
  ports: [port],
  livenessProbe: Probe.fromTcpSocket({
    port: port,
    initialDelaySeconds: Duration.seconds(45),
    periodSeconds: Duration.seconds(20),
    failureThreshold: 3,
  }),
  readinessProbe: Probe.fromTcpSocket({
    port: port,
    initialDelaySeconds: Duration.seconds(45),
    periodSeconds: Duration.seconds(20),
    failureThreshold: 3,
  }),
  extraIngressHosts: ["recipes.cmdcentral.xyz"],
  extraEnv: {
    // shared-config
    API_URL: EnvValue.fromValue("http://mealie-api:9000"),
    API_PORT: EnvValue.fromValue("9000"),
    BASE_URL: EnvValue.fromValue("https://mealie.cmdcentral.xyz"),
    TZ: EnvValue.fromValue(TZ),

    // db-config
    DB_ENGINE: EnvValue.fromValue("postgres"),
    POSTGRES_USER: EnvValue.fromValue("mealie"),
    POSTGRES_SERVER: EnvValue.fromValue("prod.postgres.svc.cluster.local"),
    POSTGRES_PORT: EnvValue.fromValue("5432"),
    POSTGRES_DB: EnvValue.fromValue("mealie"),

    // oidc config
    OIDC_AUTH_ENABLED: EnvValue.fromValue("true"),
    OIDC_SIGNUP_ENABLED: EnvValue.fromValue("true"),
    OIDC_CONFIGURATION_URL: EnvValue.fromValue(
      "https://login.cmdcentral.xyz/application/o/recipes/.well-known/openid-configuration",
    ),
    OIDC_CLIENT_ID: EnvValue.fromValue("rjTPdiqrJJrjrFYasLpcZG9gNfU0xoaqLdNZJXX9"),
    OIDC_AUTO_REDIRECT: EnvValue.fromValue("true"),
    OIDC_REMEMBER_ME: EnvValue.fromValue("true"),
    OIDC_ADMIN_GROUP: EnvValue.fromValue("wheel"),
    OIDC_USER_GROUP: EnvValue.fromValue("Mealie users"),
    OIDC_PROVIDER_NAME: EnvValue.fromValue("Cmdcentral Login"),

    // ai config
    OPENAI_MODEL: EnvValue.fromValue("@cf/meta/llama-4-scout-17b-16e-instruct"),
    ...aiSecrets.toEnvValues(),
  },
  envFrom: [
    new EnvFrom(undefined, undefined, dbCreds.secret),
    new EnvFrom(undefined, undefined, oidcCreds.secret),
  ],
  volumes: [
    {
      name: "config",
      mountPath: "/app/data/",
      props: {
        storage: Size.gibibytes(2),
      },
    },
  ],
});

app.synth();
NewKustomize(app.outdir);
