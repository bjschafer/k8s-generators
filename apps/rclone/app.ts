import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { basename } from "../../lib/util";
import { App, Size } from "cdk8s";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { Cpu } from "cdk8s-plus-28";
import { Rclone } from "../../lib/rclone";

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
        versionConstraint: "1.xx",
      },
    ],
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
      limit: Size.mebibytes(256),
    },
  },
  configSecretName: "rclone-config",
  defaultBlockIngress: true,
  backends: [
    {
      name: "crypt-b2-cmdcentral-k8s-backups",
      port: port,
      allowIngressFromInternal: true,
      allowIngressFromNS: ["velero"],
    },
  ],
});

app.synth();
