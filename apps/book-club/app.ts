import { App, Chart, Size } from "cdk8s";
import { Cpu, EnvValue, Secret } from "cdk8s-plus-33";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import {
  ExternalSecret,
  ExternalSecretSpecDataFromSourceRefGeneratorRefKind,
  ExternalSecretSpecSecretStoreRefKind,
} from "../../imports/external-secrets.io";
import { Password } from "../../imports/generators.external-secrets.io";
import { NewKustomize } from "../../lib/kustomize";
import { BitwardenSecret } from "../../lib/secrets";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 3000;

const image = "registry.cmdcentral.xyz/cmdcentral/book-club";

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        versionConstraint: "main",
        strategy: "digest",
      },
    ],
  },
});

// Provision the database credentials in this namespace (auto-generated password via CNPG)
createAppDatabaseSecret(app, name);

// Construct DATABASE_URL from the CNPG-managed credentials copied to this namespace
const dbUrlSecretName = `${name}-database-url`;
const dbUrlChart = new Chart(app, "database-url");
new ExternalSecret(dbUrlChart, "database-url-secret", {
  metadata: {
    name: dbUrlSecretName,
    namespace: namespace,
  },
  spec: {
    refreshInterval: "1h",
    secretStoreRef: {
      kind: ExternalSecretSpecSecretStoreRefKind.CLUSTER_SECRET_STORE,
      name: "kubernetes",
    },
    data: [
      {
        secretKey: "password",
        remoteRef: {
          key: `${name}-db-credentials`,
          property: "password",
        },
      },
    ],
    target: {
      name: dbUrlSecretName,
      template: {
        data: {
          DATABASE_URL: `postgresql://${name}:{{ .password }}@prod-pg17-pooler-rw.postgres.svc.cluster.local:5432/${name}`,
        },
      },
    },
  },
});
const dbUrlSecret = Secret.fromSecretName(app, "db-url-ref", dbUrlSecretName);

// Auto-generate AUTH_SECRET — generated once, never rotated
const authSecretGeneratorName = `${name}-auth-secret-generator`;
const authSecretChart = new Chart(app, "auth-secret");
new Password(authSecretChart, "auth-secret-gen", {
  metadata: {
    name: authSecretGeneratorName,
    namespace: namespace,
  },
  spec: {
    length: 48,
    digits: 8,
    symbols: 0,
    noUpper: false,
    allowRepeat: true,
  },
});
new ExternalSecret(authSecretChart, "auth-secret-es", {
  metadata: {
    name: "auth-secret",
    namespace: namespace,
  },
  spec: {
    refreshInterval: "0",
    dataFrom: [
      {
        sourceRef: {
          generatorRef: {
            apiVersion: "generators.external-secrets.io/v1alpha1",
            kind: ExternalSecretSpecDataFromSourceRefGeneratorRefKind.PASSWORD,
            name: authSecretGeneratorName,
          },
        },
      },
    ],
    target: {
      name: "auth-secret",
      template: {
        data: {
          AUTH_SECRET: "{{ .password }}",
        },
      },
    },
  },
});
const authSecret = Secret.fromSecretName(app, "auth-secret-ref", "auth-secret");

// OIDC client credentials from Bitwarden
// TODO: Replace placeholder UUIDs with real Bitwarden item IDs
const oidcSecrets = new BitwardenSecret(app, "oidc-secrets", {
  name: "oidc-secrets",
  namespace: namespace,
  data: {
    AUTH_CLIENT_ID: "6d3b9f7a-d3cf-4e61-bb47-b40801852143",
    AUTH_CLIENT_SECRET: "70c880bd-e8f3-4083-982f-b40801854ec0",
  },
});

new AppPlus(app, name, {
  name: name,
  namespace: namespace,
  image: `${image}:main`,
  ports: [port],
  resources: {
    cpu: {
      request: Cpu.millis(100),
      limit: Cpu.millis(500),
    },
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(512),
    },
  },
  extraIngressHosts: ["book-club.whizkid.dev"],
  extraEnv: {
    ...oidcSecrets.toEnvValues(),
    AUTH_URL: EnvValue.fromValue("https://book-club.whizkid.dev"),
    AUTH_TRUST_HOST: EnvValue.fromValue("true"),
    AUTH_SECRET: EnvValue.fromSecretValue({
      secret: authSecret,
      key: "AUTH_SECRET",
    }),
    DATABASE_URL: EnvValue.fromSecretValue({
      secret: dbUrlSecret,
      key: "DATABASE_URL",
    }),
    TZ: EnvValue.fromValue("America/Chicago"),
    PORT: EnvValue.fromValue(port.toString()),
    AUTH_ISSUER: EnvValue.fromValue(
      "https://login.cmdcentral.xyz/application/o/book-club/",
    ),
    ADMIN_EMAILS: EnvValue.fromValue("braxton@cmdcentral.xyz"),
  },
});

app.synth();
NewKustomize(app.outdir);
