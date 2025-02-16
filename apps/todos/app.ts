import { App, Size } from "cdk8s";
import { basename } from "../../lib/util";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { EnvValue, Secret } from "cdk8s-plus-31";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "donetick/donetick";
const port = 2021;

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

const secrets = Secret.fromSecretName(app, `${name}-creds`, "secrets");

new AppPlus(app, "donetick", {
  name,
  namespace,
  image: image,
  resources: {
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(384),
    },
  },
  ports: [port],
  extraEnv: {
    DT_ENV: EnvValue.fromValue("selfhosted"),
    DT_NAME: EnvValue.fromValue("Cmdcentral Todos"),
    DT_IS_USER_CREATION_DISABLED: EnvValue.fromValue("true"),

    // database config
    DT_DATABASE_TYPE: EnvValue.fromValue("postgres"),
    DT_DATABASE_HOST: EnvValue.fromValue("prod.postgres.svc.cluster.local"),
    DT_DATABASE_PORT: EnvValue.fromValue("5432"),
    DT_DATABASE_USER: EnvValue.fromValue("donetick"),
    DT_DATABASE_NAME: EnvValue.fromValue("donetick"),
    DT_DATABASE_MIGRATION: EnvValue.fromValue("true"), // enable automatic migrations
    DT_DATABASE_PASSWORD: EnvValue.fromSecretValue({
      secret: secrets,
      key: "DT_DATABASE_PASSWORD",
    }),

    // SSO
    DT_OAUTH2_NAME: EnvValue.fromValue("Cmdcentral Login"),
    DT_OAUTH2_CLIENT_ID: EnvValue.fromSecretValue({
      secret: secrets,
      key: "DT_OAUTH2_CLIENT_ID",
    }),
    DT_OAUTH2_CLIENT_SECRET: EnvValue.fromSecretValue({
      secret: secrets,
      key: "DT_OAUTH2_CLIENT_SECRET",
    }),
    DT_OAUTH2_REDIRECT_URL: EnvValue.fromValue(
      "https://todos.cmdcentral.xyz/auth/oauth2",
    ), // this is weird
    DT_OAUTH2_SCOPES: EnvValue.fromValue("openid,profile,email"),
    DT_OAUTH2_AUTH_URL: EnvValue.fromValue(
      "https://login.cmdcentral.xyz/application/o/authorize/",
    ),
    DT_OAUTH2_TOKEN_URL: EnvValue.fromValue(
      "https://login.cmdcentral.xyz/application/o/token/",
    ),
    DT_OAUTH2_USER_INFO_URL: EnvValue.fromValue(
      "https://login.cmdcentral.xyz/application/o/userinfo/",
    ),
  },

  extraIngressHosts: ["donetick.cmdcentral.xyz", "tasks.cmdcentral.xyz"],

  volumes: [
    {
      name: "data",
      mountPath: "/donetick-data",
      enableBackups: true,
      props: {
        storage: Size.gibibytes(5),
      },
    },
  ],
});

app.synth();
NewKustomize(app.outdir);
