import { basename } from "../../lib/util";
import { App, Chart, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { ArgoApp } from "../../lib/argo";
import { MysqlInstance } from "../../lib/mysql";
import {
  Cpu,
  Deployment,
  EnvValue,
  Ingress,
  IngressBackend,
  Secret,
} from "cdk8s-plus-25";

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
  pvcSize: Size.gibibytes(5),
});

const chart = new Chart(app, `parent-chart`);
const deployment = new Deployment(chart, "deployment", {
  metadata: {
    name: namespace,
    namespace: namespace,
  },
  replicas: 1,
  securityContext: {
    ensureNonRoot: false,
  },
  containers: [
    {
      securityContext: {
        ensureNonRoot: false,
        readOnlyRootFilesystem: false,
      },
      image: "axelander/openbudgeteer:latest",
      portNumber: 80,
      resources: {
        cpu: {
          request: Cpu.millis(50),
        },
        memory: {
          request: Size.mebibytes(128),
          limit: Size.mebibytes(512),
        },
      },
      envVariables: {
        CONNECTION_PROVIDER: EnvValue.fromValue("mysql"),
        CONNECTION_SERVER: EnvValue.fromValue("db"),
        CONNECTION_PORT: EnvValue.fromValue("3306"),
        CONNECTION_DATABASE: EnvValue.fromValue("budget"),
        CONNECTION_USER: EnvValue.fromValue("root"),
        APPSETTINGS_CULTURE: EnvValue.fromValue("en-US"),
      },
    },
  ],
});

const secret = Secret.fromSecretName(chart, `db-creds`, `db-creds`);

deployment.containers[0].env.addVariable(
  "CONNECTION_PASSWORD",
  EnvValue.fromSecretValue({ secret: secret, key: "MARIADB_ROOT_PASSWORD" })
);

const svc = deployment.exposeViaService({
  name: "budget",
});

const ingress = new Ingress(chart, "ingress", {
  metadata: {
    name: "budget",
    namespace: namespace,
  },
});
ingress.addHostRule(
  "budget.cmdcentral.xyz",
  "/",
  IngressBackend.fromService(svc)
);

const ingressSecret = Secret.fromSecretName(
  chart,
  `ingress-tls`,
  "ingress-tls"
);
ingress.addTls([
  {
    hosts: ["budget.cmdcentral.xyz"],
    secret: ingressSecret,
  },
]);
ingress.metadata.addAnnotation("cert-manager.io/cluster-issuer", "letsencrypt");

app.synth();
