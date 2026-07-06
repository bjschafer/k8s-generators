import { App, Size } from "cdk8s";
import { Cpu, EnvValue } from "cdk8s-plus-34";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { basename } from "../../lib/util";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { WellKnownLabels } from "../../lib/labels";
import { BitwardenSecret } from "../../lib/secrets";

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

const dbCreds = new BitwardenSecret(app, "db-creds", {
  name: "db-creds",
  namespace: namespace,
  data: {
    ATUIN_DB_URI: "69ef5aa3-46f3-4ad6-af17-b47e0182011f",
  },
});

new AppPlus(app, "atuin", {
  name,
  namespace,
  image: image,
  labels: {
    [WellKnownLabels.Instance]: name,
  },
  args: ["start"],
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
    ...dbCreds.toEnvValues(),
    ATUIN_METRICS__ENABLE: EnvValue.fromValue("true"), // at 9001
    ATUIN_METRICS__HOST: EnvValue.fromValue("0.0.0.0"),
  },
});

new CmdcentralServiceMonitor(app, "metrics", {
  name: name,
  namespace: namespace,
  matchLabels: { [WellKnownLabels.Instance]: name },
});

app.synth();

NewKustomize(app.outdir);
