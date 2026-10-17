import { App, Size } from "cdk8s";
import { Cpu, PersistentVolumeAccessMode } from "cdk8s-plus-34";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, LSIO_ENVVALUE, NONROOT_SECURITY_CONTEXT_UID } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/tautulli/tautulli";
const port = 8181;

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

new AppPlus(app, "tautulli", {
  name: name,
  namespace: namespace,
  image: image,
  resources: {
    memory: {
      request: Size.mebibytes(256),
      limit: Size.mebibytes(512),
    },
    cpu: {
      request: Cpu.millis(100),
      limit: Cpu.millis(800),
    },
  },
  ports: [port],
  // The image's start.sh, run as root, usermods/chowns and then gosus to
  // tautulli (1000); it can't do any of that non-root, so skip it and run what
  // it would have exec'd. /config is already 1000-owned.
  command: ["python", "Tautulli.py", "--datadir", "/config"],
  securityContext: NONROOT_SECURITY_CONTEXT_UID(1000, 1000),
  containerSecurityContext: NONROOT_SECURITY_CONTEXT_UID(1000, 1000),
  extraIngressHosts: ["plex-dash.cmdcentral.xyz"],
  extraEnv: {
    LSIO_ENVVALUE,
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
