import { basename } from "../../lib/util";
import { App, Chart, Duration, Size } from "cdk8s";
import { DEFAULT_APP_PROPS, DNS_NAMESERVERS, DNS_SEARCH, TZ } from "../../lib/consts";
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

const hostname = "hass.cmdcentral.xyz";
const tlsSecretName = `${namespace}-tls`;

NewArgoApp(namespace, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: hassImage,
        strategy: "alphabetical",
        // upstream also publishes dev/beta/rc tags; only take YYYY.M.P releases
        allowTags: "^[0-9]{4}\\.[0-9]{1,2}\\.[0-9]*$",
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

// Recorder credentials for the `hass` role on prod-pg17, generated and rotated
// by CNPG via apps/postgres/databases.ts.
const dbCreds = createAppDatabaseSecret(app, "hass");

new AppPlus(app, "home-assistant-app", {
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

app.synth();

NewKustomize(app.outdir);
