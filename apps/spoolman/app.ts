import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { basename } from "../../lib/util";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { Cpu, EnvValue, Probe, Secret } from "cdk8s-plus-27";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
    syncOptions: ["CreateNamespace=true"],
  },
  namespace: namespace,
  source: ArgoAppSource.PROD,
  recurse: true,
  autoUpdate: {
    writebackMethod: {
      method: "git",
      gitBranch: "main",
    },
    images: [
      {
        image: "ghcr.io/donkie/spoolman",
        strategy: "digest",
      },
    ],
  },
});

const dbCreds = Secret.fromSecretName(app, `${name}-creds`, `${name}-creds`);

new AppPlus(app, `${name}-app`, {
  name: namespace,
  namespace: namespace,
  image: "ghcr.io/donkie/spoolman:latest",
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(512),
    },
  },
  ports: [8000],
  extraEnv: {
    SPOOLMAN_DB_TYPE: EnvValue.fromValue("postgres"),
    SPOOLMAN_DB_HOST: EnvValue.fromValue("postgres.cmdcentral.xyz"),
    SPOOLMAN_DB_PORT: EnvValue.fromValue("5432"),
    SPOOLMAN_DB_NAME: EnvValue.fromValue(name),
    SPOOLMAN_DB_USERNAME: EnvValue.fromValue(name),
    SPOOLMAN_DB_PASSWORD: EnvValue.fromSecretValue({
      secret: dbCreds,
      key: "SPOOLMAN_DB_PASSWORD",
    }),
    TZ: EnvValue.fromValue("America/Chicago"),
  },
  livenessProbe: Probe.fromHttpGet("/api/v1/health", { port: 8000 }),
  readinessProbe: Probe.fromHttpGet("/api/v1/health", { port: 8000 }),
});

app.synth();

NewKustomize(app.outdir);
