import { basename } from "../../lib/util";
import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import { OpenBaoSecret } from "../../lib/secrets";
import { Cpu, DeploymentStrategy, EnvFrom, EnvValue, PercentOrAbsolute } from "cdk8s-plus-34";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

const image = "ghcr.io/bjschafer/pfapi";
const port = 8080;

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "digest",
        versionConstraint: "main",
      },
    ],
  },
});

const dbCreds = new OpenBaoSecret(app, "db-creds", {
  name: "db-creds",
  namespace: namespace,
  keys: [
    "Database_Database",
    "Database_Host",
    "Database_Password",
    "Database_Port",
    "Database_Type",
    "Database_Username",
  ],
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:main`,
  resources: {
    cpu: {
      request: Cpu.millis(250),
      limit: Cpu.millis(500),
    },
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(256),
    },
  },
  ports: [
    { number: port, name: "http" },
    // carried over from the hand-written manifests; the app has never been
    // observed serving on it, but the Service exposes it so leave it be.
    { number: 443, name: "https" },
  ],
  extraEnv: {
    // Config never changes at runtime in-container; disabling the default
    // appsettings.json reload-on-change watchers avoids allocating inotify
    // instances (which exhaust the node's fs.inotify.max_user_instances limit
    // and crash startup).
    DOTNET_hostBuilder__reloadConfigOnChange: EnvValue.fromValue("false"),
  },
  envFrom: [new EnvFrom(undefined, undefined, dbCreds.secret)],
  deploymentStrategy: DeploymentStrategy.rollingUpdate({
    maxSurge: PercentOrAbsolute.absolute(1),
    maxUnavailable: PercentOrAbsolute.absolute(1),
  }),
  extraIngressHosts: ["pfapi.whizkid.dev"],
  ingressLabels: {
    "cmdcentral.xyz/external": "true",
  },
  limitToAMD64: true,
});

app.synth();

NewKustomize(app.outdir);
