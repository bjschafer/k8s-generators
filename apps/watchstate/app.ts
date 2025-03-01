import { App, Size } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/arabcoders/watchstate";
const port = 8080;

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

new AppPlus(app, "watchstate", {
  name,
  namespace,
  image,
  resources: {
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(256),
    },
  },
  ports: [port],

  volumes: [
    {
      name: "config",
      mountPath: "/config",
      enableBackups: true,
      props: {
        storage: Size.gibibytes(5),
      },
    },
  ],
});

app.synth();
NewKustomize(app.outdir);
