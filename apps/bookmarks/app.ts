import { App, Duration, Size } from "cdk8s";
import {
  Cpu,
  EnvValue,
  PersistentVolumeAccessMode,
  Probe,
  Secret,
} from "cdk8s-plus-33";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { basename } from "../../lib/util";
import { StorageClass } from "../../lib/volume";
import { BitwardenSecret } from "../../lib/secrets";

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

const secrets = Secret.fromSecretName(app, `${name}-creds`, "secrets");

const aiSecrets = new BitwardenSecret(app, "ai-secrets", {
  name: "ai",
  namespace: namespace,
  data: {
    CUSTOM_OPENAI_BASE_URL: "1c3acb68-a107-4d73-8e64-b2e001190c0e",
    OPENAI_API_KEY: "62c67d3b-b097-4dec-8488-b2e00119148f",
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: image,
  resources: {
    memory: {
      request: Size.mebibytes(512),
      limit: Size.gibibytes(4),
    },
    cpu: {
      request: Cpu.millis(200),
    },
  },
  ports: [port],
  extraEnv: {
    NEXTAUTH_URL: EnvValue.fromValue(
      "https://bookmarks.cmdcentral.xyz/api/v1/auth",
    ),
    NEXTAUTH_SECRET: EnvValue.fromSecretValue({
      secret: secrets,
      key: "NEXTAUTH_SECRET",
    }),
    DATABASE_URL: EnvValue.fromSecretValue({
      secret: secrets,
      key: "DATABASE_URL",
    }),
    NEXT_PUBLIC_DISABLE_REGISTRATION: EnvValue.fromValue("true"),
    NEXT_PUBLIC_CREDENTIALS_ENABLED: EnvValue.fromValue("false"), // disable non-SSO signin

    // Try LLM categorization on CF workers
    OPENAI_MODEL: EnvValue.fromValue("@cf/openai/gpt-oss-20b"),
    ...aiSecrets.toEnvValues(),

    // Authentik SSO
    NEXT_PUBLIC_AUTHENTIK_ENABLED: EnvValue.fromValue("true"),
    AUTHENTIK_CUSTOM_NAME: EnvValue.fromValue("Cmdcentral Login"),
    AUTHENTIK_ISSUER: EnvValue.fromValue(
      "https://login.cmdcentral.xyz/application/o/bookmarks",
    ),
    AUTHENTIK_CLIENT_ID: EnvValue.fromSecretValue({
      secret: secrets,
      key: "AUTHENTIK_CLIENT_ID",
    }),
    AUTHENTIK_CLIENT_SECRET: EnvValue.fromSecretValue({
      secret: secrets,
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

NewKustomize(app.outdir);
