import { basename } from "../../lib/util";
import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { NewBot } from "../../lib/bot";
import { NewKustomize } from "../../lib/kustomize";
import { Cpu } from "cdk8s-plus-34";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

const image = "ghcr.io/bjschafer/catbot";

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "digest",
        versionConstraint: "main",
        imagePullSecret: {
          name: "github-registry-cred",
          namespace: namespace,
        },
      },
    ],
  },
});

NewBot(app, {
  name: name,
  namespace: namespace,
  image: `${image}:main`,
  resources: {
    cpu: {
      request: Cpu.millis(50),
      limit: Cpu.millis(200),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(192),
    },
  },
  botTokenSecretId: "90a18b3e-cf95-4d62-b8dc-b47e018279de",
  registryCredSecretId: "74be0e87-5bee-4719-9687-b47f00135f98",
  allowClusterView: true,
});

app.synth();

NewKustomize(app.outdir);
