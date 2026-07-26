import { basename } from "../../lib/util";
import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import { BitwardenSecret } from "../../lib/secrets";
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

const dbCreds = new BitwardenSecret(app, "db-creds", {
  name: "db-creds",
  namespace: namespace,
  data: {
    Database_Database: "302c4529-0e67-488a-acce-b47e01827ec2",
    Database_Host: "98b5df13-e42f-4a38-8b12-b47e01827f0b",
    Database_Password: "cd9acc1c-c087-44b0-9875-b47e01827f38",
    Database_Port: "2e96ce16-64f9-46ef-9848-b47e01827f64",
    Database_Type: "0f88cf46-0ab3-4096-a9ac-b47e01827fb0",
    Database_Username: "b4ce08bd-6169-4a12-ae62-b47e0182b531",
  },
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
