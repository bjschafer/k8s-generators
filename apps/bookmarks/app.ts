import { App, Chart, Cron, Duration, Size } from "cdk8s";
import {
  ConcurrencyPolicy,
  Cpu,
  CronJob,
  EnvValue,
  ImagePullPolicy,
  Probe,
  RestartPolicy,
  Secret,
} from "cdk8s-plus-27";
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
        image: image,
        versionConstraint: semverConstraint,
        strategy: "semver",
        allowTags: String.raw`^v[0-9]+\.[0-9]+\.[0-9]+-simple$`,
      },
    ],
  },
});

const dbCreds = Secret.fromSecretName(app, `${name}-creds`, "db-creds");
const appKey = Secret.fromSecretName(app, `${name}-appkey`, "appkey");

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:v1.14.1-simple`,
  resources: {
    memory: {
      request: Size.mebibytes(256),
      limit: Size.mebibytes(512),
    },
    cpu: {
      request: Cpu.millis(200),
    },
  },
  ports: [port],
  extraEnv: {
    APP_KEY: EnvValue.fromSecretValue({ secret: appKey, key: "APP_KEY" }),
    DB_CONNECTION: EnvValue.fromValue("pgsql"),
    DB_HOST: EnvValue.fromValue("postgres.cmdcentral.xyz"),
    DB_DATABASE: EnvValue.fromValue("linkace"),
    DB_USERNAME: EnvValue.fromValue("linkace"),
    DB_PORT: EnvValue.fromValue("5432"),
    DB_PASSWORD: EnvValue.fromSecretValue({
      secret: dbCreds,
      key: "DB_PASSWORD",
    }),
    SETUP_COMPLETED: EnvValue.fromValue("true"), // required for postgres

    SESSION_LIFETIME: EnvValue.fromValue(`${60 * 24 * 365}`), // in minutes, 1 year
  },
  livenessProbe: Probe.fromHttpGet("/", {
    port: port,
    initialDelaySeconds: Duration.seconds(5),
  }),
  readinessProbe: Probe.fromHttpGet("/", {
    port: port,
    initialDelaySeconds: Duration.seconds(5),
  }),
});

const cronChart = new Chart(app, `${name}-cron`);
const cronSecret = Secret.fromSecretName(app, `${name}-cron-secret`, "cron");

new CronJob(cronChart, `${name}-cronjob`, {
  metadata: {
    name: "cronjob",
  },
  schedule: Cron.schedule({ minute: "*/15" }),
  securityContext: {
    user: 568,
    group: 568,
  },
  containers: [
    {
      image: "quay.io/curl/curl",
      imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
      args: ["curl", "http://bookmarks:80/cron/$(CRON_TOKEN)"],
      envVariables: {
        CRON_TOKEN: EnvValue.fromSecretValue({
          secret: cronSecret,
          key: "CRON_TOKEN",
        }),
      },
      securityContext: {
        privileged: false,
        ensureNonRoot: true,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
      },
      resources: {
        memory: {
          request: Size.mebibytes(32),
          limit: Size.mebibytes(32),
        },
      },
    },
  ],
  restartPolicy: RestartPolicy.NEVER,
  concurrencyPolicy: ConcurrencyPolicy.FORBID,
  failedJobsRetained: 1,
  successfulJobsRetained: 1,
});

app.synth();

NewKustomize(app.outdir);
