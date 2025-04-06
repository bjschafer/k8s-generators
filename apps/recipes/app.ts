import { App, Chart, Size } from "cdk8s";
import { basename } from "path";
import { NewArgoApp } from "../../lib/argo";
import {
  BACKUP_ANNOTATION_NAME,
  CLUSTER_ISSUER,
  DEFAULT_APP_PROPS,
  DEFAULT_SECURITY_CONTEXT,
  RELOADER_ENABLED,
} from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { Construct } from "constructs";
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
} from "cdk8s-plus-32";
import heredoc from "tsheredoc";
import { StorageClass } from "../../lib/volume";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";

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
      {
        image: "public.ecr.aws/nginx/nginx",
        versionConstraint: "latest",
        strategy: "digest",
      },
    ],
  },
});

class Tandoor extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const nginx_cm = new ConfigMap(this, "nginx-config", {
      metadata: {
        name: "nginx-config",
        namespace: namespace,
      },
      data: {
        config: heredoc`
          events {
            worker_connections 1024;
          }
          http {
            include mime.types;
            server {
              listen 80;
              server_name _;

              client_max_body_size 16M;

              # serve static files
              location /static/ {
                alias /static/;
              }
              # serve media files
              location /media/ {
                alias /media/;
              }
            }
          }
          `,
      },
    });

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
      initContainers: [
        {
          name: "init-chown-data",
          image: image,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          command: [
            "sh",
            "-c",
            heredoc`
              set -e
              source venv/bin/activate
              echo "Updating database"
              python manage.py migrate
              python manage.py collectstatic_js_reverse
              python manage.py collectstatic --noinput
              echo "Setting media file attributes"
              chown -R 65534:65534 /opt/recipes/mediafiles
              find /opt/recipes/mediafiles -type d | xargs -r chmod 755
              find /opt/recipes/mediafiles -type f | xargs -r chmod 644
              echo "Done"
              `,
          ],
          envFrom: [new EnvFrom(cm), new EnvFrom(undefined, undefined, secret)],
          resources: {
            cpu: {
              request: Cpu.millis(250),
              limit: Cpu.millis(1000),
            },
            memory: {
              request: Size.mebibytes(64),
              limit: Size.mebibytes(256),
            },
          },
        },
      ],
      containers: [
        {
          name: "tandoor",
          securityContext: DEFAULT_SECURITY_CONTEXT,
          image: image,
          ports: [
            {
              number: port,
              name: "gunicorn",
            },
          ],
          command: [
            "/opt/recipes/venv/bin/gunicorn",
            "-b",
            ":8080",
            "--access-logfile",
            "-",
            "--error-logfile",
            "-",
            "--log-level",
            "INFO",
            "recipes.wsgi",
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
        {
          name: "nginx",
          securityContext: DEFAULT_SECURITY_CONTEXT,
          image: "public.ecr.aws/nginx/nginx",
          ports: [
            {
              number: 80,
              name: "http",
            },
          ],
          resources: {
            cpu: {
              request: Cpu.millis(250),
              limit: Cpu.millis(1000),
            },
            memory: {
              request: Size.mebibytes(64),
              limit: Size.mebibytes(256),
            },
          },
        },
      ],
    });

    const nginx_cm_vol = Volume.fromConfigMap(this, "nginx-cm-vol", nginx_cm);
    const pvc_vol = Volume.fromPersistentVolumeClaim(this, "data-vol", pvc);
    deploy.containers[1].mount("/etc/nginx/nginx.conf", nginx_cm_vol, {
      subPath: "config",
    });

    for (const container of deploy.containers.concat(deploy.initContainers)) {
      const mediaPath =
        container.name === "nginx" ? "/media" : "/opt/recipes/mediafiles";
      const staticPath =
        container.name === "nginx" ? "/static" : "/opt/recipes/staticfiles";
      container.mount(mediaPath, pvc_vol, {
        subPath: "media",
      });
      container.mount(staticPath, pvc_vol, {
        subPath: "static",
      });
    }

    const svc = deploy.exposeViaService({
      name: "tandoor",
    });

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
        IngressBackend.fromService(svc, { port: 8080 }),
      );
      ingress.addHostRule(
        host,
        "/media",
        IngressBackend.fromService(svc, { port: 80 }),
      );
      ingress.addHostRule(
        host,
        "/static",
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
      matchLabels: {
        "app.kubernetes.io/instance": "recipes",
      },
    });
  }
}

new Tandoor(app, "tandoor");

app.synth();

NewKustomize(app.outdir);
