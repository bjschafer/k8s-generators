import { App, Size } from "cdk8s";
import { EnvValue, Probe, Secret } from "cdk8s-plus-27";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { basename } from "../../lib/util";

const namespace = basename(__dirname);
const name = namespace;
const image = "ghcr.io/kovah/linkace";
const semverConstraint = "v1.x.x-simple";
const port = 80;
const app = new App(DEFAULT_APP_PROPS(namespace));

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
        image: `image:${semverConstraint}`,
        strategy: "semver",
      },
    ],
  },
});

const secrets = Secret.fromSecretName(app, `${name}-creds`, "db-creds");

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:v1.14.1-simple`,
  resources: {
    memory: {
      request: Size.mebibytes(384),
      limit: Size.gibibytes(1),
    },
  },
  ports: [port],
  extraEnv: {
    DB_CONNECTION: EnvValue.fromValue("pgsql"),
    DB_HOST: EnvValue.fromValue("postgres.cmdcentral.xyz"),
    DB_DATABASE: EnvValue.fromValue("linkace"),
    DB_USERNAME: EnvValue.fromValue("linkace"),
    DB_PORT: EnvValue.fromValue("5432"),
    DB_PASSWORD: EnvValue.fromSecretValue({
      secret: secrets,
      key: "DB_PASSWORD",
    }),
    SETUP_COMPLETED: EnvValue.fromValue("true"), // required for postgres
  },
  livenessProbe: Probe.fromHttpGet("/", { port: port }),
  readinessProbe: Probe.fromHttpGet("/", { port: port }),
});

app.synth();

NewKustomize(app.outdir);
