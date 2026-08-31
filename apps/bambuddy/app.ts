import { App, Duration, Size } from "cdk8s";
import { Capability, ContainerPort, Cpu, EnvValue, Probe, ServiceType } from "cdk8s-plus-34";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import {
  DEFAULT_APP_PROPS,
  DEFAULT_SECURITY_CONTEXT,
  METALLB_IP_ANNOTATION_KEY,
  TZ,
} from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
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

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: "ghcr.io/maziggy/bambuddy:latest",
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(256),
      limit: Size.gibibytes(1),
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
    // Without these the virtual printer hands the slicer its own pod IP as the
    // upload target. Nothing off the cluster network routes there, so sends
    // die partway through rather than failing cleanly.
    VIRTUAL_PRINTER_ADVERTISE_ADDRESS: EnvValue.fromValue(lbAddress),
    VIRTUAL_PRINTER_PASV_ADDRESS: EnvValue.fromValue(lbAddress),
  },
  containerSecurityContext: {
    ...DEFAULT_SECURITY_CONTEXT,
    // The virtual printer binds 322 and 990 directly -- both privileged, and
    // upstream stopped redirecting them from high ports because the iptables
    // REDIRECT rewrote the destination and misrouted FTP between printers.
    // Upstream's compose grants the same capability for the same reason.
    capabilities: { add: [Capability.NET_BIND_SERVICE] },
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

app.synth();

NewKustomize(app.outdir);
