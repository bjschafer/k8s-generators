import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { basename } from "../../lib/util";
import { ArgoApp, ArgoAppSource } from "../../lib/argo";
import { MysqlInstance } from "../../lib/mysql";
import { Cpu } from "cdk8s-plus-29";
import { AppPlus } from "../../lib/app-plus";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

new ArgoApp(app, namespace, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.PROD,
  recurse: true,
});
new MysqlInstance(app, "db", {
  namespace: namespace,
  instance: namespace,
  enableBackups: true,
  resources: {
    memory: {
      limit: Size.mebibytes(512),
      request: Size.mebibytes(128),
    },
    cpu: {
      request: Cpu.millis(50),
    },
  },
  pvcSize: Size.gibibytes(25),
});

new AppPlus(app, "monica-app", {
  name: "monica",
  namespace: namespace,
  image: "monica:4.0.0-apache",
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(512),
    },
  },
  ports: [80],
  volumes: [
    {
      props: {
        storage: Size.gibibytes(2),
      },
      mountPath: "/var/www/html/storage",
      enableBackups: true,
      name: "data",
    },
  ],
});

app.synth();
