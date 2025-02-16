import { App, Chart, Size, Yaml } from "cdk8s";
import { basename } from "../../lib/util";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { ConfigMap, EnvValue, Secret } from "cdk8s-plus-31";
import { NewKustomize } from "../../lib/kustomize";
import { Construct } from "constructs";

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

// Viper only knows about config fields in the config file. The built-in config file does not have some fields we need (such as for database).
// Meaning, we need a config file that has the format/structure of all the values, but it can be filled with dummy values and overridden by environment variables.
class Config extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const cm = new ConfigMap(this, `${id}-cm`, {
      metadata: {
        name: "config",
        namespace: namespace,
      },
    });

    cm.addData(
      "selfhosted.yaml",
      Yaml.stringify({
        name: "Cmdcentral Todos",
        is_user_creation_disabled: true,
        telegram: {
          token: "",
        },
        pushover: {
          token: "",
        },
        database: {
          type: "",
          host: "",
          password: "",
          port: 5432,
          user: "",
          name: "",
          migration: true,
        },
        server: {
          port: 2021,
          read_timeout: "10s",
          write_timeout: "10s",
          rate_period: "60s",
          rate_limit: 300,
          cors_allow_origins: [
            "http://localhost:5173",
            "http://localhost:7926",
            "https://localhost",
            "capacitor://localhost",
          ],
          serve_frontend: true,
        },
        scheduler_jobs: {
          due_job: "30m",
          overdue_job: "3h",
          pre_due_job: "3h",
        },
        oauth2: {
          auth_url: "",
          token_url: "",
          user_info_url: "",
          redirect_url: "",
          name: "",
          scopes: ["openid", "profile", "email"],
        },
      }),
    );
  }
}
new Config(app, "donetick-config");

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
  configmapMounts: [
    {
      name: "config",
      mountPath: "/config/selfhosted.yaml",
      subPath: "selfhosted.yaml",
    },
  ],
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
