import { App, Size } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS, NONROOT_SECURITY_CONTEXT } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import { EnvValue, PersistentVolumeAccessMode } from "cdk8s-plus-34";

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
      request: Size.mebibytes(512),
      limit: Size.gibibytes(1.5),
    },
  },
  ports: [port],
  // audited safe: image ships USER=user
  securityContext: NONROOT_SECURITY_CONTEXT,
  containerSecurityContext: NONROOT_SECURITY_CONTEXT,

  extraEnv: {
    WS_API_AUTO: EnvValue.fromValue("true"),
  },

  volumes: [
    {
      name: "config",
      mountPath: "/config",
      props: {
        storage: Size.gibibytes(5),
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      },
    },
  ],
});

app.synth();
NewKustomize(app.outdir);
