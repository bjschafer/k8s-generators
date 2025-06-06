import { basename } from "path";
import {
  DEFAULT_APP_PROPS,
  EXTERNAL_DNS_ANNOTATION_KEY,
} from "../../lib/consts";
import { App, Size } from "cdk8s";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { Cpu, Probe, ServiceType } from "cdk8s-plus-32";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = "pbs-s3-proxy";
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/tizbac/pmoxs3backuproxy";
const port = 8007;

NewArgoApp(namespace, {
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
  name: name,
  namespace: namespace,
  image: image,
  ports: [port],
  resources: {
    cpu: {
      request: Cpu.millis(200),
    },
    memory: {
      request: Size.mebibytes(128),
    },
  },
  disableProbes: true,
  disableIngress: true,
  args: [
    "-bind",
    ":8007",
    "-endpoint",
    "s3.us-central-1.wasabisys.com:443",
    "-usessl",
    "-debug",
  ],
  service: {
    type: ServiceType.LOAD_BALANCER,
    annotations: {
      [EXTERNAL_DNS_ANNOTATION_KEY]: "pbs-s3-proxy.cmdcentral.xyz",
    },
  },
});

app.synth();

NewKustomize(app.outdir);
