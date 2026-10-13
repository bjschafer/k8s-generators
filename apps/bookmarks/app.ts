import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, PersistentVolumeAccessMode, Probe } from "cdk8s-plus-34";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { basename } from "../../lib/util";
import { StorageClass } from "../../lib/volume";
import { OpenBaoSecret } from "../../lib/secrets";

const namespace = basename(__dirname);
const name = namespace;
const image = "ghcr.io/linkwarden/linkwarden";
const port = 3000;
const app = new App(DEFAULT_APP_PROPS(namespace));

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
        strategy: "digest",
      },
    ],
  },
});

const secrets = new OpenBaoSecret(app, "secrets", {
  name: "secrets",
  namespace: namespace,
  keys: ["DATABASE_URL", "NEXTAUTH_SECRET"],
  refs: {
    AUTHENTIK_CLIENT_ID: { path: `${namespace}/authentik`, property: "client_id" },
    AUTHENTIK_CLIENT_SECRET: { path: `${namespace}/authentik`, property: "client_secret" },
  },
});

const aiSecrets = new OpenBaoSecret(app, "ai-secrets", {
  name: "ai",
  namespace: namespace,
  keys: ["CUSTOM_OPENAI_BASE_URL", "OPENAI_API_KEY"],
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: image,
  resources: {
    memory: {
      request: Size.mebibytes(512),
      limit: Size.gibibytes(6),
    },
    cpu: {
      request: Cpu.millis(200),
    },
  },
  ports: [port],
  extraEnv: {
    NEXTAUTH_URL: EnvValue.fromValue("https://bookmarks.cmdcentral.xyz/api/v1/auth"),
    NEXTAUTH_SECRET: EnvValue.fromSecretValue({
      secret: secrets.secret,
      key: "NEXTAUTH_SECRET",
    }),
    DATABASE_URL: EnvValue.fromSecretValue({
      secret: secrets.secret,
      key: "DATABASE_URL",
    }),
    NEXT_PUBLIC_DISABLE_REGISTRATION: EnvValue.fromValue("true"),
    NEXT_PUBLIC_CREDENTIALS_ENABLED: EnvValue.fromValue("false"), // disable non-SSO signin

    // Try LLM categorization on CF workers
    OPENAI_MODEL: EnvValue.fromValue("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    ...aiSecrets.toEnvValues(),

    // Authentik SSO
    NEXT_PUBLIC_AUTHENTIK_ENABLED: EnvValue.fromValue("true"),
    AUTHENTIK_CUSTOM_NAME: EnvValue.fromValue("Cmdcentral Login"),
    AUTHENTIK_ISSUER: EnvValue.fromValue("https://login.cmdcentral.xyz/application/o/bookmarks"),
    AUTHENTIK_CLIENT_ID: EnvValue.fromSecretValue({
      secret: secrets.secret,
      key: "AUTHENTIK_CLIENT_ID",
    }),
    AUTHENTIK_CLIENT_SECRET: EnvValue.fromSecretValue({
      secret: secrets.secret,
      key: "AUTHENTIK_CLIENT_SECRET",
    }),
  },
  livenessProbe: Probe.fromHttpGet("/", {
    port: port,
    initialDelaySeconds: Duration.seconds(5),
  }),
  readinessProbe: Probe.fromHttpGet("/", {
    port: port,
    initialDelaySeconds: Duration.seconds(5),
  }),

  volumes: [
    {
      name: "data",
      mountPath: "/data/data",
      props: {
        storage: Size.gibibytes(5),
        storageClassName: StorageClass.CEPH_RBD,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      },
    },
  ],
});

app.synth();

NewKustomize(app.outdir);
