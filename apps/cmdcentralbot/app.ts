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

const image = "ghcr.io/bjschafer/cmdcentralbot";

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
      limit: Size.mebibytes(128),
    },
  },
  botTokenSecretId: "206f1cf4-94b9-4b68-96a0-b47e01827a95",
  registryCredSecretId: "9ec077fd-1b61-4944-80ae-b47f00138826",
  allowClusterView: true,
});

app.synth();

NewKustomize(app.outdir);
