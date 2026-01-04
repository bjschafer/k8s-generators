import { App, Chart, Size } from "cdk8s";
import {
  ConfigMap,
  Cpu,
  Deployment,
  DeploymentStrategy,
  EnvFrom,
  Ingress,
  IngressBackend,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeMode,
  Probe,
  Secret,
  Volume,
} from "cdk8s-plus-33";
import { Construct } from "constructs";
import { basename } from "path";
import heredoc from "tsheredoc";
import { NewArgoApp } from "../../lib/argo";
import {
  BACKUP_ANNOTATION_NAME,
  CLUSTER_ISSUER,
  DEFAULT_APP_PROPS,
  DEFAULT_SECURITY_CONTEXT,
  RELOADER_ENABLED,
} from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { WellKnownLabels } from "../../lib/labels";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/tandoorrecipes/recipes";
const port = 8080;

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        versionConstraint: "latest",
        strategy: "digest",
      },
    ],
  },
});

class Tandoor extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const cm = new ConfigMap(this, "tandoor-config", {
      metadata: {
        name: "tandoor-config",
        namespace: namespace,
      },
      data: {
        DEBUG: "0",
        ALLOWED_HOSTS: "*",
        GUNICORN_MEDIA: "0",
        DB_ENGINE: "django.db.backends.postgresql",
        POSTGRES_HOST: "prod.postgres.svc.cluster.local",
        POSTGRES_PORT: "5432",
        POSTGRES_USER: "tandoor",
        POSTGRES_DB: "tandoor",
        ENABLE_METRICS: "1",
        ENABLE_SIGNUP: "0",
        SOCIAL_PROVIDERS: "allauth.socialaccount.providers.openid_connect",
        SOCIAL_DEFAULT_ACCESS: "1",
        SOCIAL_DEFAULT_GROUP: "user",
      },
    });

    const pvc = new PersistentVolumeClaim(this, "data", {
      metadata: {
        name: "data",
        namespace: namespace,
      },
      accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      storage: Size.gibibytes(5),
      storageClassName: StorageClass.CEPH_RBD,
      volumeMode: PersistentVolumeMode.FILE_SYSTEM,
    });

    const secret = Secret.fromSecretName(this, "secrets", "secrets");

    const deploy = new Deployment(this, "deploy", {
      metadata: {
        name: "tandoor",
        namespace: namespace,
        annotations: {
          ...RELOADER_ENABLED,
        },
      },
      replicas: 1,
      strategy: DeploymentStrategy.recreate(),
      podMetadata: {
        annotations: {
          [BACKUP_ANNOTATION_NAME]: "data",
        },
      },
      securityContext: DEFAULT_SECURITY_CONTEXT,
      containers: [
        {
          name: "tandoor",
          securityContext: DEFAULT_SECURITY_CONTEXT,
          image: image,
          ports: [
            {
              number: 80,
              name: "http",
            },
          ],
          envFrom: [new EnvFrom(cm), new EnvFrom(undefined, undefined, secret)],
          resources: {
            cpu: {
              request: Cpu.millis(250),
              limit: Cpu.millis(1000),
            },
            memory: {
              request: Size.mebibytes(256),
              limit: Size.gibibytes(1),
            },
          },
          readiness: Probe.fromHttpGet("/", {
            port: port,
          }),
          liveness: Probe.fromHttpGet("/", {
            port: port,
          }),
        },
      ],
    });

    const pvc_vol = Volume.fromPersistentVolumeClaim(this, "data-vol", pvc);

    deploy.containers[0].mount("/opt/recipes/mediafiles", pvc_vol, {
      subPath: "media",
    });
    deploy.containers[0].mount("/opt/recipes/staticfiles", pvc_vol, {
      subPath: "static",
    });

    const svc = deploy.exposeViaService({
      name: "tandoor",
      ports: [
        {
          name: "http",
          port: 80,
          targetPort: 80,
        },
      ],
    });
    svc.metadata.addLabel(WellKnownLabels.Name, name);

    const hostnames = ["tandoor.cmdcentral.xyz"];

    const ingress = new Ingress(this, "tandoor-ingress", {
      metadata: {
        name: "tandoor",
        namespace: namespace,
        annotations: {
          "cert-manager.io/cluster-issuer": CLUSTER_ISSUER.name,
        },
      },
    });

    for (const host of hostnames) {
      ingress.addHostRule(
        host,
        "/",
        IngressBackend.fromService(svc, { port: 80 }),
      );
    }

    ingress.addTls([
      {
        hosts: hostnames,
        secret: Secret.fromSecretName(this, "tandoor-tls", "tandoor-tls"),
      },
    ]);

    new CmdcentralServiceMonitor(app, "metrics", {
      name: "tandoor",
      namespace: namespace,
      portName: "metrics",
      matchLabels: {
        [WellKnownLabels.Name]: name,
      },
    });
  }
}

new Tandoor(app, "tandoor");

app.synth();

NewKustomize(app.outdir);
