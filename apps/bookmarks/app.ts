import { App, Duration, Size } from "cdk8s";
import {
  Cpu,
  EnvValue,
  PersistentVolumeAccessMode,
  Probe,
  Secret,
} from "cdk8s-plus-32";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { basename } from "../../lib/util";
import { StorageClass } from "../../lib/volume";

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

    // Try local LLM categorization
    // NEXT_PUBLIC_OLLAMA_ENDPOINT_URL=http://localhost:11434
    // OLLAMA_MODEL=phi3:mini-4k
    NEXT_PUBLIC_OLLAMA_ENDPOINT_URL: EnvValue.fromValue(
      "http://swordfish.cmdcentral.xyz.:11434",
    ),
    OLLAMA_MODEL: EnvValue.fromValue("phi3:mini-4k"),

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
