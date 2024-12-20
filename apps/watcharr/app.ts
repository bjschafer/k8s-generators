import { App, Size } from "cdk8s";
import { PersistentVolumeAccessMode } from "cdk8s-plus-31";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { basename } from "../../lib/util";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 3080;
const image = "ghcr.io/sbondco/watcharr";

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
        strategy: "newest-build",
      },
    ],
  },
});

new AppPlus(app, "watcharr", {
  name,
  namespace,
  image: image,
  resources: {
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(512),
    },
  },
  ports: [port],
  volumes: [
    {
      name: "data",
      mountPath: "/data",
      enableBackups: true,
      props: {
        storage: Size.gibibytes(5),
        storageClassName: StorageClass.CEPH_RBD,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      },
    },
  ],
});

app.synth();
