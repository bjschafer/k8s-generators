import { basename } from "path";
import { DEFAULT_APP_PROPS, TZ } from "../../lib/consts";
import { App, Duration, Size } from "cdk8s";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { Cpu, EnvFrom, EnvValue, Probe, Secret } from "cdk8s-plus-33";
import { NewKustomize } from "../../lib/kustomize";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { WellKnownLabels } from "../../lib/labels";

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

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: "ghcr.io/miniflux/miniflux:latest-distroless",
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
  livenessProbe: Probe.fromCommand(
    ["/usr/bin/miniflux", "-healthcheck", "auto"],
    {
      initialDelaySeconds: Duration.seconds(20),
      periodSeconds: Duration.seconds(10),
      timeoutSeconds: Duration.seconds(1),
    },
  ),
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
    METRICS_ALLOWED_NETWORKS: EnvValue.fromValue(
      "127.0.0.1/8,10.42.0.0/16,10.43.0.0/16",
    ),
    AUTH_PROXY_HEADER: EnvValue.fromValue(
      "HTTP_CF_ACCESS_AUTHENTICATED_USER_EMAIL",
    ),
    AUTH_PROXY_USER_CREATION: EnvValue.fromValue("true"),
    DISABLE_LOCAL_AUTH: EnvValue.fromValue("true"),
    OAUTH2_OIDC_PROVIDER_NAME: EnvValue.fromValue("Cmdcentral Login"),
    RUN_MIGRATIONS: EnvValue.fromValue("1"),
  },
  envFrom: [
    new EnvFrom(
      undefined,
      undefined,
      Secret.fromSecretName(app, `${name}-db-creds`, "db-creds"),
    ),
    new EnvFrom(
      undefined,
      undefined,
      Secret.fromSecretName(app, `${name}-oauth`, "oauth"),
    ),
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
