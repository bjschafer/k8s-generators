import { App, Size } from "cdk8s";
import { Cpu, EnvValue, Secret } from "cdk8s-plus-30";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { basename } from "../../lib/util";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/atuinsh/atuin";
const port = 8888;

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
        strategy: "semver",
        versionConstraint: "18.x.x",
      },
    ],
  },
});

new AppPlus(app, "atuin", {
  name,
  namespace,
  image: image,
  args: ["server", "start"],
  resources: {
    cpu: {
      request: Cpu.millis(5),
    },
    memory: {
      request: Size.mebibytes(32),
      limit: Size.mebibytes(128),
    },
  },
  ports: [port],
  monitoringConfig: {
    port: 9001,
  },
  extraEnv: {
    ATUIN_HOST: EnvValue.fromValue("0.0.0.0"), // bind address
    ATUIN_PORT: EnvValue.fromValue("8888"),
    ATUIN_OPEN_REGISTRATION: EnvValue.fromValue("false"),
    ATUIN_DB_URI: EnvValue.fromSecretValue({
      secret: Secret.fromSecretName(app, "db-creds", "db-creds"),
      key: "ATUIN_DB_URI",
    }),
    ATUIN_METRICS__ENABLE: EnvValue.fromValue("true"), // at 9001
    ATUIN_METRICS__HOST: EnvValue.fromValue("0.0.0.0"),
  },
});

new CmdcentralServiceMonitor(app, "metrics", {
  name: name,
  namespace: namespace,
  matchLabels: { "app.kubernetes.io/name": name },
});

app.synth();

NewKustomize(app.outdir);
