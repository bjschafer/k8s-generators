import { App, Size } from "cdk8s";
import { Cpu, EnvValue } from "cdk8s-plus-33";
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
const port = 7745;

const image = "ghcr.io/sysadminsmedia/homebox";

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
const dbCreds = createAppDatabaseSecret(app, "homebox");

const secrets = new BitwardenSecret(app, "secrets", {
  name: "secrets",
  namespace: namespace,
  data: {
    HBOX_OIDC_CLIENT_SECRET: "1d512c7f-865f-4f81-a3b2-b3cf00063f49",
  },
});

new AppPlus(app, name, {
  name: name,
  namespace: namespace,
  image: image,
  ports: [port],
  resources: {
    cpu: {
      request: Cpu.millis(100),
      limit: Cpu.millis(500),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(256),
    },
  },
  extraIngressHosts: ["inventory.cmdcentral.xyz"],
  extraEnv: {
    HBOX_OPTIONS_ALLOW_REGISTRATION: EnvValue.fromValue("false"),
    TZ: EnvValue.fromValue("America/Chicago"),
    HBOX_OPTIONS_TRUST_PROXY: EnvValue.fromValue("true"),

    // database
    HBOX_DATABASE_DRIVER: EnvValue.fromValue("postgres"),
    HBOX_DATABASE_HOST: EnvValue.fromValue(
      "prod-pg17-rw.postgres.svc.cluster.local",
    ),
    HBOX_DATABASE_PORT: EnvValue.fromValue("5432"),
    HBOX_DATABASE_DATABASE: EnvValue.fromValue(name),
    HBOX_DATABASE_USERNAME: EnvValue.fromValue(name),
    HBOX_DATABASE_PASSWORD: EnvValue.fromSecretValue({
      secret: dbCreds.secret,
      key: "password",
    }),

    // oidc
    HBOX_OIDC_ENABLED: EnvValue.fromValue("true"),
    HBOX_OIDC_ISSUER_URL: EnvValue.fromValue(
      "https://login.cmdcentral.xyz/application/o/homebox/",
    ),
    HBOX_OIDC_CLIENT_ID: EnvValue.fromValue(
      "szrAnUchZOMEJ6oc8ajcYh1jqMBsuUVPeErulame",
    ),
    HBOX_OIDC_ALLOWED_GROUPS: EnvValue.fromValue("Family"),
    HBOX_OIDC_AUTO_REDIRECT: EnvValue.fromValue("true"),
    HBOX_OPTIONS_ALLOW_LOCAL_LOGIN: EnvValue.fromValue("false"),
    HBOX_OIDC_BUTTON_TEXT: EnvValue.fromValue("Cmdcentral Login"),
    ...secrets.toEnvValues(),
  },
  volumes: [
    {
      name: "data",
      mountPath: "/data",
      enableBackups: true,
      props: {
        storage: Size.gibibytes(20),
      },
    },
  ],
});

app.synth();
NewKustomize(app.outdir);
