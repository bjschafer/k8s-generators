import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, Probe } from "cdk8s-plus-33";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { CmdcentralPodMonitor } from "../../lib/monitoring/victoriametrics";
import { BitwardenSecret } from "../../lib/secrets";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

// Metrics/health port; must listen on 0.0.0.0 for kubelet probes to reach it
const metricsPort = 2000;

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: "cloudflare/cloudflared",
        strategy: "semver",
      },
    ],
  },
});

const secrets = new BitwardenSecret(app, "cloudflared-secrets", {
  name: "cloudflared",
  namespace: namespace,
  data: {
    TUNNEL_TOKEN: "b37a5dab-4c1d-415a-a6bd-b3f80133a09e",
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: "cloudflare/cloudflared:latest",
  // --metrics 0.0.0.0:2000 makes the metrics/health endpoints reachable by the kubelet
  args: ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"],
  resources: {
    cpu: {
      request: Cpu.millis(10),
      limit: Cpu.millis(500),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(256),
    },
  },
  replicas: 2,
  ports: [{ number: metricsPort, name: "metrics" }],
  disableIngress: true,
  // No inbound traffic — Service would be unused; VmPodScrape handles metrics collection directly
  disableService: true,
  extraEnv: {
    TUNNEL_TOKEN: EnvValue.fromSecretValue({
      secret: secrets.secret,
      key: "TUNNEL_TOKEN",
    }),
  },
  livenessProbe: Probe.fromHttpGet("/ready", {
    port: metricsPort,
    initialDelaySeconds: Duration.seconds(10),
    periodSeconds: Duration.seconds(30),
    failureThreshold: 3,
  }),
  readinessProbe: Probe.fromHttpGet("/ready", {
    port: metricsPort,
    initialDelaySeconds: Duration.seconds(10),
    periodSeconds: Duration.seconds(10),
    failureThreshold: 3,
  }),
});

new CmdcentralPodMonitor(app, "pm", {
  name: name,
  namespace: namespace,
  matchLabels: { "app.kubernetes.io/name": name },
  portName: "metrics",
});

app.synth();
NewKustomize(app.outdir);
