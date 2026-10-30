import { App, Duration, Size } from "cdk8s";
import {
  Capability,
  ContainerPort,
  Cpu,
  EnvValue,
  Probe,
  ServiceType,
  Volume,
} from "cdk8s-plus-34";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import {
  DEFAULT_APP_PROPS,
  METALLB_IP_ANNOTATION_KEY,
  NONROOT_SECURITY_CONTEXT_UID,
  TZ,
} from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { WellKnownLabels } from "../../lib/labels";
import { basename } from "../../lib/util";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

// Bambuddy's "virtual printer" impersonates a Bambu Lab printer so a slicer can
// send to it, which means it has to answer on the printer's own ports at an
// address the slicer can reach. That rules out a ClusterIP: it needs a stable
// LoadBalancer address of its own. MetalLB's pool is 10.0.10.80-99
// (apps/metallb/app.ts); .85 is the first free address in it.
const lbAddress = "10.0.10.85";

// Ten passive ports per virtual printer, allocated in order -- VP1 gets
// 50000-50009. A second virtual printer would need 50010-50019 added here.
const ftpPassivePorts: ContainerPort[] = Array.from({ length: 10 }, (_, i) => ({
  number: 50000 + i,
  name: `ftp-pasv-${i}`,
}));

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
        image: "ghcr.io/maziggy/bambuddy",
        strategy: "digest",
      },
    ],
  },
});

const dbCreds = createAppDatabaseSecret(app, name);

const bambuddy = new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: "ghcr.io/maziggy/bambuddy:latest",
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(512),
      limit: Size.gibibytes(2),
    },
  },
  labels: {
    [WellKnownLabels.Name]: name,
    [WellKnownLabels.ManagedBy]: "generators",
  },
  // 8000 must stay first: AppPlus points the ingress and the default probes at
  // ports[0], and the web UI is the only one of these that speaks plain HTTP.
  ports: [
    { number: 8000, name: "http" },
    // Bind/detect handshake -- the slicer authenticates against these when you
    // add the virtual printer by IP + access code.
    { number: 3000, name: "bind" },
    { number: 3002, name: "detect" },
    { number: 8883, name: "mqtt" },
    { number: 990, name: "ftps" },
    { number: 6000, name: "tunnel" },
    // RTSP camera stream. On the H2D this is the feed gated behind the
    // printer's "LAN Only Liveview" setting.
    { number: 322, name: "rtsp" },
    ...ftpPassivePorts,
  ],
  // Deliberately omitted:
  //   2021/UDP (SSDP) -- discovery is multicast, and it would have to cross
  //     from the cluster (10.0.10.0/24) to the slicer (10.0.30.0/24) and the
  //     printer (10.50.0.0/24) to be of any use. Both get added by IP instead.
  //   2024-2026 -- A1/P1S-specific slicer protocols, unused by the H2D.
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
    // Declaration order matters: Kubernetes expands a $(VAR) reference only
    // against env vars declared *earlier* in the same container, so the
    // password has to precede the URL that interpolates it. Same pattern as
    // apps/hass.
    BAMBUDDY_DB_PASSWORD: EnvValue.fromSecretValue({ secret: dbCreds.secret, key: "password" }),
    // The driver half of the scheme is not optional here. Bambuddy builds a
    // SQLAlchemy *async* engine, and a bare `postgresql://` URL resolves to the
    // default sync driver -- psycopg2, which the image does not ship. That
    // fails at import time, so it crashloops rather than degrading.
    DATABASE_URL: EnvValue.fromValue(
      `postgresql+asyncpg://${name}:$(BAMBUDDY_DB_PASSWORD)@prod.postgres.svc.cluster.local:5432/${name}`,
    ),
    // Upstream's PostgreSQL default is pool_size 20 + max_overflow 60, sized
    // for printer farms. Print starts burst into the overflow and pin the
    // pooler's per-user cap (20 x 3 instances = 60), pushing prod-pg17 past
    // its 90% connection alert. One printer needs nowhere near that.
    DB_POOL_SIZE: EnvValue.fromValue("5"),
    DB_MAX_OVERFLOW: EnvValue.fromValue("10"),
    // Without these the virtual printer hands the slicer its own pod IP as the
    // upload target. Nothing off the cluster network routes there, so sends
    // die partway through rather than failing cleanly.
    VIRTUAL_PRINTER_ADVERTISE_ADDRESS: EnvValue.fromValue(lbAddress),
    VIRTUAL_PRINTER_PASV_ADDRESS: EnvValue.fromValue(lbAddress),
  },
  // The entrypoint chowns /app/data and /app/logs and gosus to 1000 when
  // started as root, and execs the app directly otherwise. The virtual printer
  // binds 322 and 990, which works without the capability: the cluster's
  // ip_unprivileged_port_start is 0. NET_BIND_SERVICE stays in the bounding set
  // only because the image's python carries it as a file capability, and the
  // kernel refuses to exec such a binary (EPERM) when the bounding set can't
  // satisfy it. Non-root under no_new_privs, the process never actually holds it.
  securityContext: NONROOT_SECURITY_CONTEXT_UID(1000, 1000),
  containerSecurityContext: {
    ...NONROOT_SECURITY_CONTEXT_UID(1000, 1000),
    capabilities: { drop: [Capability.ALL], add: [Capability.NET_BIND_SERVICE] },
  },
  volumes: [
    {
      name: `${name}-data`,
      // Print archive: every 3MF sent through the virtual printer is kept here,
      // so this grows with use rather than sitting flat. ceph-rbd allows
      // expansion, so start modest.
      mountPath: "/app/data",
      props: {
        storage: Size.gibibytes(20),
      },
    },
  ],
  // Runs database migrations on boot, so gate liveness/readiness until it is
  // actually listening rather than letting the first probe kill it.
  startupProbe: Probe.fromTcpSocket({
    port: 8000,
    failureThreshold: 30,
    periodSeconds: Duration.seconds(10),
  }),
  service: {
    type: ServiceType.LOAD_BALANCER,
    annotations: {
      [METALLB_IP_ANNOTATION_KEY]: lbAddress,
      "cmdcentral.xyz/hostname": `${name}-vp.cmdcentral.xyz`,
    },
  },
});

// /app/logs is root-owned in the image and only writable because the root
// entrypoint chowns it; the app writes bambuddy.log there.
const logsVol = Volume.fromEmptyDir(bambuddy, "logs-vol", "logs");
bambuddy.Deployment.addVolume(logsVol);
bambuddy.Deployment.containers[0].mount("/app/logs", logsVol);

new CmdcentralServiceMonitor(app, "sm", {
  name: name,
  namespace: namespace,
  matchLabels: {
    [WellKnownLabels.Name]: name,
  },
  extraConfig: {
    // Bambuddy serves metrics off the main web port at a non-default path
    // rather than a dedicated one, so this replaces the construct's endpoint
    // wholesale instead of just naming a port. Gated behind Settings ->
    // Prometheus Metrics, which is database state rather than anything this
    // manifest sets -- if the scrape goes empty, check the toggle first.
    endpoints: [{ port: "http", path: "/api/v1/metrics" }],
  },
});

app.synth();

NewKustomize(app.outdir);
