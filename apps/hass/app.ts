import { basename } from "../../lib/util";
import { App, Chart, Duration, Size } from "cdk8s";
import {
  DEFAULT_APP_PROPS,
  DEFAULT_SECURITY_CONTEXT,
  DNS_NAMESERVERS,
  DNS_SEARCH,
  NONROOT_SECURITY_CONTEXT,
  TZ,
} from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import { StorageClass } from "../../lib/volume";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";
import {
  Cpu,
  DeploymentStrategy,
  DnsPolicy,
  EnvValue,
  ImagePullPolicy,
  PersistentVolume,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  Probe,
  Volume,
} from "cdk8s-plus-34";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

const hassImage = "ghcr.io/home-assistant/home-assistant";
const hassPort = 8123;

// Home Assistant Container has no add-on to supply the Matter integration's
// controller, so it runs here as a sidecar.
const matterImage = "ghcr.io/matter-js/matterjs-server";
const matterPort = 5580;

const hostname = "hass.cmdcentral.xyz";
const tlsSecretName = `${namespace}-tls`;

NewArgoApp(namespace, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: hassImage,
        // Calendar versions with an unpadded month: `alphabetical` compares
        // byte by byte, so "2026.9.4" outranks "2026.10.0" and "2026.11.0" and
        // the updater silently stays on September. semver compares the fields
        // numerically. allowTags keeps upstream's dev/beta/rc tags out.
        strategy: "semver",
        allowTags: "^[0-9]{4}\\.[0-9]{1,2}\\.[0-9]+$",
      },
      {
        image: matterImage,
        strategy: "digest",
        versionConstraint: "stable",
      },
    ],
  },
});

// Home Assistant's config directory. Its own chart because the claim outlives
// any one workload mounting it -- hass-configurator used to share it too.
const shared = new Chart(app, "hass-shared", { namespace: namespace });

const configPvc = new PersistentVolumeClaim(shared, "hass-config-pvc", {
  metadata: {
    name: "config",
    namespace: namespace,
  },
  accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
  storage: Size.gibibytes(25),
  storageClassName: StorageClass.CEPH_RBD,
  // Pinned: this is the entire Home Assistant installation -- every
  // integration, automation and its recorder database.
  volume: PersistentVolume.fromPersistentVolumeName(
    shared,
    "hass-config-pv",
    "pvc-66b43722-67ef-4b95-9122-e87f9b2f2e78",
  ),
});

// The Matter server's fabric: its root CA and the operational credentials every
// commissioned device trusts. Losing it means re-pairing every Matter device.
const matterPvc = new PersistentVolumeClaim(shared, "matter-server-pvc", {
  metadata: {
    name: "matter-server",
    namespace: namespace,
  },
  accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
  storage: Size.gibibytes(1),
  storageClassName: StorageClass.CEPH_RBD,
});

// Recorder credentials for the `hass` role on prod-pg17, generated and rotated
// by CNPG via apps/postgres/databases.ts.
const dbCreds = createAppDatabaseSecret(app, "hass");

const hass = new AppPlus(app, "home-assistant-app", {
  name: "home-assistant",
  namespace: namespace,
  image: hassImage,
  resources: {
    cpu: {
      request: Cpu.millis(100),
    },
    memory: {
      request: Size.gibibytes(1),
      limit: Size.gibibytes(2),
    },
  },
  ports: [hassPort],
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
    // Consumed by `db_url: !env_var HASS_DB_URL` in /config/configuration.yaml,
    // which lives on the config PVC rather than in this repo.
    //
    // Declaration order matters: Kubernetes expands a $(VAR) reference only
    // against env vars declared *earlier* in the same container, so the
    // password has to precede the URL that interpolates it.
    //
    // Host stays on the external LoadBalancer name, not prod-pg17-pooler-rw:
    // this pod is hostNetwork with DNS_NAMESERVERS, so *.svc.cluster.local
    // does not resolve for it.
    HASS_DB_PASSWORD: EnvValue.fromSecretValue({ secret: dbCreds.secret, key: "password" }),
    HASS_DB_URL: EnvValue.fromValue(
      "postgresql://hass:$(HASS_DB_PASSWORD)@pg-prod.cmdcentral.xyz/hass",
    ),
  },
  extraVolumeMounts: [
    {
      volume: Volume.fromPersistentVolumeClaim(app, "hass-config-vol", configPvc),
      mountPath: "/config",
    },
  ],
  // needed for discovery of smart home devices on the LAN, which relies on
  // broadcast/multicast traffic a pod network doesn't carry.
  hostNetwork: true,
  dns: {
    policy: DnsPolicy.CLUSTER_FIRST,
    nameservers: DNS_NAMESERVERS,
    searches: DNS_SEARCH,
  },
  livenessProbe: Probe.fromTcpSocket({ port: hassPort }),
  readinessProbe: Probe.fromTcpSocket({ port: hassPort }),
  startupProbe: Probe.fromTcpSocket({
    port: hassPort,
    periodSeconds: Duration.seconds(5),
    failureThreshold: 30,
  }),
  ingressHosts: [{ host: hostname }],
  tlsSecretName: tlsSecretName,
  // AppPlus only infers this from volumes it creates the claim for, and this
  // claim is declared separately so it comes in via extraVolumeMounts. Both
  // reasons to recreate apply here: the RWO volume, and hostNetwork -- a surge
  // pod would fail to bind 8123 on a node the old one is still holding.
  deploymentStrategy: DeploymentStrategy.recreate(),
});

// Sidecar rather than its own Deployment: Matter needs hostNetwork (link-local
// multicast, plus the RIO-learned routes to Thread border routers), and sharing
// HA's network namespace lets the websocket API -- which has no auth -- bind
// loopback only. HA's Matter integration points at ws://127.0.0.1:5580/ws.
const matterVol = Volume.fromPersistentVolumeClaim(app, "matter-server-vol", matterPvc);
hass.Deployment.addVolume(matterVol);
// A fresh RBD volume is root-owned and the image runs as 1000:1000. A pod-level
// fsGroup would also recursively chown HA's whole config volume, so fix
// ownership of this one volume only.
hass.Deployment.addInitContainer({
  name: "matter-server-chown",
  image: `${matterImage}:stable`,
  imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
  command: ["chown", "-R", "1000:1000", "/data"],
  securityContext: { ...DEFAULT_SECURITY_CONTEXT, user: 0, group: 0 },
  volumeMounts: [{ path: "/data", volume: matterVol }],
  resources: {
    cpu: { request: Cpu.millis(10) },
    memory: { request: Size.mebibytes(16), limit: Size.mebibytes(64) },
  },
});
hass.Deployment.addContainer({
  name: "matter-server",
  image: `${matterImage}:stable`,
  imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
  // audited safe: image ships USER 1000:1000
  securityContext: NONROOT_SECURITY_CONTEXT,
  envVariables: {
    TZ: EnvValue.fromValue(TZ),
    PORT: EnvValue.fromValue(`${matterPort}`),
    // IPv4 first: the image's healthcheck probes the first entry.
    LISTEN_ADDRESS: EnvValue.fromValue("127.0.0.1,::1"),
    // PRIMARY_INTERFACE stays unset: it only scopes link-local addresses, and
    // the nodes HA can land on disagree on the LAN NIC's name (ens18 vs eth0).
  },
  volumeMounts: [{ path: "/data", volume: matterVol }],
  resources: {
    cpu: { request: Cpu.millis(50) },
    memory: { request: Size.mebibytes(256), limit: Size.gibibytes(1) },
  },
  // The websocket is loopback-only, so a kubelet TCP/HTTP probe against the
  // node IP would fail; the image's own healthcheck honours LISTEN_ADDRESS.
  liveness: Probe.fromCommand(["/usr/local/bin/healthcheck.sh"], {
    periodSeconds: Duration.seconds(60),
    timeoutSeconds: Duration.seconds(10),
    failureThreshold: 6,
  }),
  // First start loads the DCL seed; upstream allows 15 minutes.
  startup: Probe.fromCommand(["/usr/local/bin/healthcheck.sh"], {
    periodSeconds: Duration.seconds(5),
    timeoutSeconds: Duration.seconds(10),
    failureThreshold: 180,
  }),
});

app.synth();

NewKustomize(app.outdir);
