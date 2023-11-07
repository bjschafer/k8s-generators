import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { App } from "cdk8s/lib/app";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { Size } from "cdk8s";
import { Probe } from "cdk8s-plus-27";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "quay.io/prometheus/promlens";

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
    syncOptions: ["CreateNamespace=true"],
  },
  namespace: namespace,
  autoUpdate: {
    writebackMethod: {
      method: "git",
      gitBranch: "main",
    },
    images: [
      {
        image: image,
        strategy: "digest",
      },
    ],
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:latest`,
  resources: {
    memory: {
      request: Size.mebibytes(192),
      limit: Size.mebibytes(512),
    },
  },
  ports: [8080],
  livenessProbe: Probe.fromHttpGet("", { port: 8334 }),
  readinessProbe: Probe.fromHttpGet("", { port: 8334 }),
});

app.synth();

NewKustomize(app.outdir);
