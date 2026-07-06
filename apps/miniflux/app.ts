import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvFrom, EnvValue, Probe } from "cdk8s-plus-34";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, NONROOT_SECURITY_CONTEXT, TZ } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { WellKnownLabels } from "../../lib/labels";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { BitwardenSecret } from "../../lib/secrets";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 8080;

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: "ghcr.io/miniflux/miniflux",
        versionConstraint: "latest-distroless",
        strategy: "digest",
      },
    ],
  },
});

const dbCreds = new BitwardenSecret(app, "db-creds", {
  name: "db-creds",
  namespace: namespace,
  data: {
    DATABASE_URL: "ef58402f-7ec0-4252-91f9-b47e01821cc5",
  },
});

const oauth = new BitwardenSecret(app, "oauth", {
  name: "oauth",
  namespace: namespace,
  data: {
    OAUTH2_CLIENT_ID: "be32d910-21cc-40de-96eb-b47e01821d5d",
    OAUTH2_CLIENT_SECRET: "08f43e00-7539-4d60-9984-b47e01821d92",
    OAUTH2_OIDC_DISCOVERY_ENDPOINT: "5b4da39e-8cf3-4295-9250-b47e01821f65",
    OAUTH2_PROVIDER: "f74c58ff-7007-4e3c-abee-b47e01821fca",
    OAUTH2_REDIRECT_URL: "db2078ec-d502-4cd9-b01e-b47e01821ffc",
    OAUTH2_USER_CREATION: "7d4f6b91-5a36-418d-a2e2-b47e0182202b",
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: "ghcr.io/miniflux/miniflux:latest-distroless",
  labels: {
    [WellKnownLabels.Name]: name,
  },
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(512),
    },
  },
  ports: [port],
  // audited safe: distroless image runs as USER=65532
  securityContext: NONROOT_SECURITY_CONTEXT,
  containerSecurityContext: NONROOT_SECURITY_CONTEXT,
  livenessProbe: Probe.fromCommand(["/usr/bin/miniflux", "-healthcheck", "auto"], {
    initialDelaySeconds: Duration.seconds(20),
    periodSeconds: Duration.seconds(10),
    timeoutSeconds: Duration.seconds(1),
  }),
  readinessProbe: Probe.fromHttpGet("/healthcheck", {
    initialDelaySeconds: Duration.seconds(20),
    periodSeconds: Duration.seconds(10),
    timeoutSeconds: Duration.seconds(1),
    port: port,
  }),
  extraIngressHosts: ["rss.cmdcentral.xyz"],
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
    BASE_URL: EnvValue.fromValue("https://rss.cmdcentral.xyz"),
    METRICS_COLLECTOR: EnvValue.fromValue("1"),
    METRICS_ALLOWED_NETWORKS: EnvValue.fromValue("127.0.0.1/8,10.42.0.0/16,10.43.0.0/16"),
    AUTH_PROXY_HEADER: EnvValue.fromValue("HTTP_CF_ACCESS_AUTHENTICATED_USER_EMAIL"),
    TRUSTED_REVERSE_PROXY_NETWORKS: EnvValue.fromValue("127.0.0.1/8,10.42.0.0/16,10.43.0.0/16"),
    AUTH_PROXY_USER_CREATION: EnvValue.fromValue("true"),
    DISABLE_LOCAL_AUTH: EnvValue.fromValue("true"),
    OAUTH2_OIDC_PROVIDER_NAME: EnvValue.fromValue("Cmdcentral Login"),
    RUN_MIGRATIONS: EnvValue.fromValue("1"),
    INTEGRATION_ALLOW_PRIVATE_NETWORKS: EnvValue.fromValue("1"),
  },
  envFrom: [
    new EnvFrom(undefined, undefined, dbCreds.secret),
    new EnvFrom(undefined, undefined, oauth.secret),
  ],
});

new CmdcentralServiceMonitor(app, "sm", {
  name: name,
  namespace: namespace,
  matchLabels: {
    [WellKnownLabels.Name]: name,
  },
  portName: "http",
});

app.synth();
NewKustomize(app.outdir);
