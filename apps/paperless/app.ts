import { App, Chart, Duration, Size } from "cdk8s";
import {
  ConfigMap,
  Cpu,
  EnvFrom,
  EnvValue,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeMode,
  Probe,
  Secret,
  ServiceType,
  Volume,
} from "cdk8s-plus-34";
import {
  ExternalSecret,
  ExternalSecretSpecDataFromSourceRefGeneratorRefKind,
} from "../../imports/external-secrets.io";
import { Password } from "../../imports/generators.external-secrets.io";
import { Quantity } from "../../imports/k8s";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, NONROOT_SECURITY_CONTEXT, RELOADER_ENABLED } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { BitwardenSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";
import { Valkey, VALKEY_VERSION } from "../../lib/valkey";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

// The kustomize base had sat at 7.8.3 while the updater's override ran 8.36.0,
// so the manifest in git named a version that has not been deployed in a long
// time. Derives the updater's constraint too, which is what keeps the two
// honest; Renovate watches it for the 9 the updater cannot take.
// renovate: datasource=docker depName=gotenberg/gotenberg
const gotenbergVersion = "8.36.0";

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
        versionConstraint: `${gotenbergVersion.split(".")[0]}.x.x`,
      },
      {
        image: "ghcr.io/valkey-io/valkey",
        strategy: "semver",
        versionConstraint: VALKEY_VERSION,
        allowTags: "^[v]?[0-9]+\\.[0-9]+\\.[0-9]+$",
      },
    ],
  },
});

// Valkey broker for Paperless task queue
const valkey = new Valkey(app, "valkey", {
  name: "broker",
  namespace: namespace,
  version: VALKEY_VERSION,
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

// Cloudflare AI Gateway key for the built-in AI features. Named for the retired
// paperless-ai companion that used to own it; kept under that name so the ESO
// secret does not churn. Its other two keys (the companion's paperless API token
// and its own web UI key) went away with the companion.
const paperlessAiSecrets = new BitwardenSecret(app, "paperless-ai-secrets", {
  name: "paperless-ai-secrets",
  namespace: namespace,
  data: {
    CUSTOM_API_KEY: "7f062e0d-213c-4f54-aa03-b3fa003da758",
  },
});

const paperlessDbCreds = new BitwardenSecret(app, "paperless-db-creds", {
  name: "paperless-db-creds",
  namespace: namespace,
  data: {
    PAPERLESS_DBPASS: "7a3a5a6d-84a8-49a1-a9ea-b47e018220c6",
  },
});

const paperlessOidc = new BitwardenSecret(app, "paperless-oidc", {
  name: "paperless-oidc",
  namespace: namespace,
  data: {
    PAPERLESS_SOCIALACCOUNT_PROVIDERS: "3234f44e-ccbd-4d8c-8afd-b47e01822174",
  },
});

// Django SECRET_KEY. Upstream hard-fails at startup if this is unset or "change-me".
// Nothing at rest derives from it (mail creds and share links are stored plainly), so it
// only signs sessions/CSRF -- a regenerated value just forces re-login via SSO. Generated
// once and never rotated (refreshInterval "0"), so it stays stable across pod restarts.
const secretKeyName = "paperless-secret-key";
const secretKeyGeneratorName = "paperless-secret-key-generator";
const secretKeyChart = new Chart(app, "secret-key");
new Password(secretKeyChart, "gen", {
  metadata: { name: secretKeyGeneratorName, namespace: namespace },
  spec: {
    length: 64,
    digits: 10,
    symbols: 0,
    noUpper: false,
    allowRepeat: true,
    secretKeys: ["PAPERLESS_SECRET_KEY"],
  },
});
new ExternalSecret(secretKeyChart, "secret", {
  metadata: { name: secretKeyName, namespace: namespace },
  spec: {
    refreshInterval: "0",
    dataFrom: [
      {
        sourceRef: {
          generatorRef: {
            apiVersion: "generators.external-secrets.io/v1alpha1",
            kind: ExternalSecretSpecDataFromSourceRefGeneratorRefKind.PASSWORD,
            name: secretKeyGeneratorName,
          },
        },
      },
    ],
    target: { name: secretKeyName },
  },
});
const paperlessSecretKey = Secret.fromSecretName(app, "secret-key-ref", secretKeyName);

// FTP login for the scanner that drops documents into the consume directory. Was a
// hardcoded literal here, which meant it sat in plaintext in a public repo -- and the
// same value was in use as a Postgres password elsewhere.
//
// No symbols, and short enough to be typed on a scanner's front panel: this one is
// entered by hand on the device, not read by anything that can handle punctuation
// reliably. Generated once and never rotated (refreshInterval "0") -- a regenerated
// value would silently break document ingest until the scanner is reconfigured.
const ftpSecretName = "paperless-ftp-credentials";
const ftpGeneratorName = "paperless-ftp-password-generator";
const ftpChart = new Chart(app, "ftp-credentials");
new Password(ftpChart, "gen", {
  metadata: { name: ftpGeneratorName, namespace: namespace },
  spec: {
    length: 24,
    digits: 4,
    symbols: 0,
    noUpper: false,
    allowRepeat: true,
    secretKeys: ["FTP_USER_PASS"],
  },
});
new ExternalSecret(ftpChart, "secret", {
  metadata: { name: ftpSecretName, namespace: namespace },
  spec: {
    refreshInterval: "0",
    dataFrom: [
      {
        sourceRef: {
          generatorRef: {
            apiVersion: "generators.external-secrets.io/v1alpha1",
            kind: ExternalSecretSpecDataFromSourceRefGeneratorRefKind.PASSWORD,
            name: ftpGeneratorName,
          },
        },
      },
    ],
    target: { name: ftpSecretName },
  },
});
const ftpCredentials = Secret.fromSecretName(app, "ftp-credentials-ref", ftpSecretName);

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
        PAPERLESS_CONSUMER_RECURSIVE: "true",
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
        // Built-in AI features, backed by Cloudflare AI Gateway. Since ngx 3.1.0 the
        // "Apply AI Suggestions" workflow action applies these automatically in bulk,
        // which is what the retired paperless-ai companion used to do.
        PAPERLESS_AI_ENABLED: "true",
        PAPERLESS_AI_LLM_BACKEND: "openai-like",
        // glm-4.7-flash is a reasoning model: it buries ~90% of its completion in
        // reasoning tokens and took 141s/149s on real documents here, blowing the
        // 120s llm_request_timeout and wedging the (concurrency-1) celery worker.
        // llama-3.3-70b does the same job in ~6s and, unlike mistral-small, never
        // invents new tags -- which matters because the workflow action below runs
        // with create_missing enabled. gpt-oss-120b emits no tool calls through the
        // gateway's compat layer, so it cannot drive the structured-output path.
        PAPERLESS_AI_LLM_MODEL: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        PAPERLESS_AI_LLM_ENDPOINT:
          "https://gateway.ai.cloudflare.com/v1/5b51f634ca1cf16a0c47a4fcd00a5cf3/cmdcentral/compat",
        // Embedding endpoint/key fall back to the LLM_ENDPOINT/LLM_API_KEY above,
        // so RAG (document chat + similar-document suggestions) reuses the same
        // Cloudflare AI Gateway credentials rather than needing its own.
        PAPERLESS_AI_LLM_EMBEDDING_BACKEND: "openai-like",
        PAPERLESS_AI_LLM_EMBEDDING_MODEL: "workers-ai/@cf/google/embeddinggemma-300m",
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

    const dbCredsSecret = paperlessDbCreds.secret;
    const oidcSecret = paperlessOidc.secret;

    // Main Paperless deployment
    const paperless = new AppPlus(app, "paperless-web", {
      name: "paperless",
      namespace: namespace,
      image: "ghcr.io/paperless-ngx/paperless-ngx:latest",
      labels: {
        app: "paperless",
        component: "web",
      },
      // The AI settings live in the ConfigMap above and are read from the
      // environment at startup, so a config change needs a pod restart to land.
      annotations: RELOADER_ENABLED,
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
        new EnvFrom(undefined, undefined, paperlessSecretKey),
      ],
      extraEnv: {
        PAPERLESS_AI_LLM_API_KEY: EnvValue.fromSecretValue({
          secret: paperlessAiSecrets.secret,
          key: "CUSTOM_API_KEY",
        }),
      },
      enableServiceLinks: false,
      volumes: [
        {
          name: "data",
          mountPath: "/data",
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
    paperless.Deployment.containers[0].mount("/usr/src/paperless/consume", ftpVol);

    // Gotenberg deployment
    new AppPlus(app, "gotenberg", {
      name: "gotenberg",
      namespace: namespace,
      image: `gotenberg/gotenberg:${gotenbergVersion}`,
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
      // audited safe: image ships USER=35002
      securityContext: NONROOT_SECURITY_CONTEXT,
      containerSecurityContext: NONROOT_SECURITY_CONTEXT,
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
        FTP_USER_PASS: EnvValue.fromSecretValue({
          secret: ftpCredentials,
          key: "FTP_USER_PASS",
        }),
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
    const ftpVolForFtpServer = Volume.fromPersistentVolumeClaim(app, "ftp-vol-ftpserver", ftpPvc);
    ftpserver.Deployment.addVolume(ftpVolForFtpServer);
    ftpserver.Deployment.containers[0].mount("/home/scanner", ftpVolForFtpServer);
  }
}

new Paperless(app, "paperless");

app.synth();
NewKustomize(app.outdir);
