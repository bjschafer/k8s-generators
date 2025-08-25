import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { basename } from "../../lib/util";
import { App, Size } from "cdk8s";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { Cpu } from "cdk8s-plus-33";
import { Rclone } from "../../lib/rclone";
import { NewKustomize } from "../../lib/kustomize";
import { BitwardenSecret } from "../../lib/secrets";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

const image = "rclone/rclone";
const port = 8042;

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.GENERATORS,
  recurse: true,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "semver",
        versionConstraint: "1.x",
      },
    ],
  },
});

const config = new BitwardenSecret(app, "config", {
  name: "rclone-config",
  namespace: namespace,
  data: {
    "rclone.conf": "1ef8bd38-2d01-4f85-9f52-b2ce0111ed5e",
  },
});

new Rclone(app, "rclone", {
  name: name,
  namespace: namespace,
  resources: {
    cpu: {
      request: Cpu.millis(100),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.gibibytes(2), // it needs a lot of room to cache stuff
    },
  },
  configSecretName: config.secretName,
  defaultBlockIngress: true,
  backends: [
    {
      name: "crypt-wasabi-cmdcentral-k8s-backups",
      port: port,
      ingressHost:
        "rclone-gateway-crypt-wasabi-cmdcentral-k8s-backups.cmdcentral.xyz",
      allowIngressFromInternal: true,
      allowIngressFromNS: ["velero"],
    },
  ],
});

app.synth();

NewKustomize(app.outdir);
