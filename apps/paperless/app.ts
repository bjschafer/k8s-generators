import { App, Chart, Duration, Size } from "cdk8s";
import {
  ConfigMap,
  Cpu,
  DeploymentStrategy,
  EnvFrom,
  EnvValue,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeMode,
  Probe,
  Secret,
  ServiceType,
  Volume,
} from "cdk8s-plus-33";
import { Quantity } from "../../imports/k8s";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { basename } from "../../lib/util";
import { Valkey } from "../../lib/valkey";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(namespace, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: "ghcr.io/paperless-ngx/paperless-ngx",
        strategy: "digest",
      },
      {
        image: "stilliard/pure-ftpd",
        strategy: "digest",
      },
      {
        image: "docker.io/apache/tika",
        strategy: "digest",
      },
      {
        image: "gotenberg/gotenberg",
        strategy: "semver",
        versionConstraint: "8.x.x",
      },
      {
        image: "ghcr.io/valkey-io/valkey",
        strategy: "semver",
        versionConstraint: "7-alpine",
        allowTags: "^[v]?[0-9]+\\.[0-9]+\\.[0-9]+$",
      },
    ],
  },
});

// Valkey broker for Paperless task queue
const valkey = new Valkey(app, "valkey", {
  name: "broker",
  namespace: namespace,
  version: "7-alpine",
  password: "paperless",
  resources: {
    requests: {
      cpu: Quantity.fromString("100m"),
      memory: Quantity.fromString("64Mi"),
    },
    limits: {
      cpu: Quantity.fromString("100m"),
      memory: Quantity.fromString("64Mi"),
    },
  },
});

class Paperless extends Chart {
  constructor(scope: App, id: string) {
    super(scope, id);

    const cm = new ConfigMap(this, "config", {
      metadata: {
        name: "paperless-web-config",
        namespace: namespace,
      },
      data: {
        PAPERLESS_CONSUMER_POLLING: "60",
        PAPERLESS_DBHOST: "prod.postgres.svc.cluster.local",
        PAPERLESS_DBNAME: "paperless",
        PAPERLESS_DBUSER: "paperless",
        PAPERLESS_OCR_LANGUAGE: "eng",
        PAPERLESS_OCR_USER_ARGS: '{"continue_on_soft_render_error": true}',
        PAPERLESS_REDIS: `redis://:paperless@${valkey.Service.name}:6379`,
        PAPERLESS_TIKA_ENABLED: "1",
        PAPERLESS_TIKA_GOTENBERG_ENTPOINT: "http://gotenberg:3000",
        PAPERLESS_TIKA_ENDPOINT: "http://tika:9998",
        PAPERLESS_TIME_ZONE: "America/Chicago",
        PAPERLESS_URL: "https://paperless.cmdcentral.xyz",
        USERMAP_UID: "1000",
        USERMAP_GID: "1000",
        PAPERLESS_APPS: "allauth.socialaccount.providers.openid_connect",
        PAPERLESS_DISABLE_REGULAR_LOGIN: "true",
        PAPERLESS_REDIRECT_LOGIN_TO_SSO: "true",
        PAPERLESS_DATA_DIR: "/data/data",
        PAPERLESS_MEDIA_ROOT: "/data/media",
      },
    });

    const ftpPvc = new PersistentVolumeClaim(this, "ftp", {
      metadata: {
        name: "ftp",
        namespace: namespace,
      },
      accessModes: [PersistentVolumeAccessMode.READ_WRITE_MANY],
      storageClassName: StorageClass.CEPHFS,
      storage: Size.gibibytes(1),
      volumeMode: PersistentVolumeMode.FILE_SYSTEM,
    });

    const dbCredsSecret = Secret.fromSecretName(
      app,
      "db-creds",
      "paperless-db-creds",
    );
    const oidcSecret = Secret.fromSecretName(app, "oidc", "paperless-oidc");

    // Main Paperless deployment
    const paperless = new AppPlus(app, "paperless-web", {
      name: "paperless",
      namespace: namespace,
      image: "ghcr.io/paperless-ngx/paperless-ngx:latest",
      labels: {
        app: "paperless",
        component: "web",
      },
      resources: {
        cpu: {
          request: Cpu.millis(250),
        },
        memory: {
          request: Size.mebibytes(512),
          limit: Size.gibibytes(2.5),
        },
      },
      ports: [{ number: 8000, name: "http" }],
      livenessProbe: Probe.fromHttpGet("/", {
        port: 8000,
        initialDelaySeconds: Duration.seconds(20),
        periodSeconds: Duration.seconds(10),
      }),
      readinessProbe: Probe.fromHttpGet("/", {
        port: 8000,
        initialDelaySeconds: Duration.seconds(20),
        periodSeconds: Duration.seconds(10),
      }),
      envFrom: [
        new EnvFrom(cm, undefined, undefined),
        new EnvFrom(undefined, undefined, dbCredsSecret),
        new EnvFrom(undefined, undefined, oidcSecret),
      ],
      enableServiceLinks: false,
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
    const ftpVol = Volume.fromPersistentVolumeClaim(app, "ftp-vol", ftpPvc);

    paperless.Deployment.addVolume(ftpVol);
    paperless.Deployment.containers[0].mount(
      "/usr/src/paperless/consume",
      ftpVol,
    );

    // Gotenberg deployment
    new AppPlus(app, "gotenberg", {
      name: "gotenberg",
      namespace: namespace,
      image: "gotenberg/gotenberg:7.8.3",
      labels: {
        app: "paperless",
        component: "gotenberg",
      },
      args: ["gotenberg", "--chromium-disable-routes=true"],
      resources: {
        cpu: {
          request: Cpu.millis(50),
          limit: Cpu.millis(500),
        },
        memory: {
          request: Size.mebibytes(64),
          limit: Size.mebibytes(256),
        },
      },
      ports: [{ number: 3000, name: "web" }],
      extraEnv: {
        DISABLE_GOOGLE_CHROME: EnvValue.fromValue("1"),
      },
      disableIngress: true,
      disableProbes: true,
    });

    // Tika deployment
    new AppPlus(app, "tika", {
      name: "tika",
      namespace: namespace,
      image: "docker.io/apache/tika:latest",
      labels: {
        app: "paperless",
        component: "tika",
      },
      resources: {
        cpu: {
          request: Cpu.millis(50),
          limit: Cpu.millis(200),
        },
        memory: {
          request: Size.mebibytes(128),
          limit: Size.mebibytes(384),
        },
      },
      ports: [{ number: 9998, name: "web" }],
      disableIngress: true,
      disableProbes: true,
    });

    // FTP server deployment - needs special handling for LoadBalancer and many ports

    const ftpserver = new AppPlus(app, "ftpserver", {
      name: "ftpserver",
      namespace: namespace,
      image: "stilliard/pure-ftpd",
      labels: {
        app: "ftpserver",
      },
      resources: {
        cpu: {
          request: Cpu.millis(5),
          limit: Cpu.millis(200),
        },
        memory: {
          request: Size.mebibytes(8),
          limit: Size.mebibytes(128),
        },
      },
      ports: [
        { number: 21, name: "ftp" },
        { number: 30000 },
        { number: 30001 },
        { number: 30002 },
        { number: 30003 },
        { number: 30004 },
        { number: 30005 },
        { number: 30006 },
        { number: 30007 },
        { number: 30008 },
        { number: 30009 },
      ],
      extraEnv: {
        FTP_USER_NAME: EnvValue.fromValue("scanner"),
        FTP_USER_PASS: EnvValue.fromValue("qp1341"),
        FTP_USER_UID: EnvValue.fromValue("1000"),
        FTP_USER_GID: EnvValue.fromValue("1000"),
        FTP_USER_HOME: EnvValue.fromValue("/home/scanner"),
        PUBLICHOST: EnvValue.fromValue("10.0.10.84"),
      },
      limitToAMD64: true,
      disableIngress: true,
      disableProbes: true,
      service: {
        type: ServiceType.LOAD_BALANCER,
        annotations: {
          "cmdcentral.xyz/hostname": "paperless-ftp.cmdcentral.xyz",
        },
      },
    });

    // Mount ftp volume - reuse ftpPvcRef from earlier
    const ftpVolForFtpServer = Volume.fromPersistentVolumeClaim(
      app,
      "ftp-vol-ftpserver",
      ftpPvc,
    );
    ftpserver.Deployment.addVolume(ftpVolForFtpServer);
    ftpserver.Deployment.containers[0].mount(
      "/home/scanner",
      ftpVolForFtpServer,
    );
  }
}

new Paperless(app, "paperless");

app.synth();
NewKustomize(app.outdir);
