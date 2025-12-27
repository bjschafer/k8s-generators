import { App, Size } from "cdk8s";
import { EnvValue, PersistentVolumeAccessMode } from "cdk8s-plus-33";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/wizarrrr/wizarr";
const port = 5690;

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

new AppPlus(app, name, {
  name,
  namespace,
  image,
  resources: {
    memory: {
      request: Size.mebibytes(256),
      limit: Size.mebibytes(512),
    },
  },
  ports: [port],

  extraEnv: {
    DISABLE_BUILTIN_AUTH: EnvValue.fromValue("true"),
    TZ: EnvValue.fromValue("America/Chicago"),
  },
  extraIngressHosts: ["invites.cmdcentral.xyz"],

    volumes: [{
        name: "data",
        mountPath: "/data",
        enableBackups: true,
        props: {
            storage: Size.gibibytes(5),
            accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        }
  }]
});

app.synth();
NewKustomize(app.outdir);
