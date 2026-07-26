import { basename } from "../../lib/util";
import { App, Chart, Duration, Size } from "cdk8s";
import { DEFAULT_APP_PROPS, DNS_NAMESERVERS, DNS_SEARCH, TZ } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import { StorageClass } from "../../lib/volume";
import {
  ConfigMap,
  Cpu,
  DeploymentStrategy,
  DnsPolicy,
  Env,
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
const configuratorImage = "causticlab/hass-configurator-docker";
const configuratorPort = 3218;

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
      {
        image: configuratorImage,
        strategy: "digest",
      },
    ],
  },
});

// Home Assistant's config directory, shared read-write with the configurator so
// it can edit configuration.yaml in place. Being RWO, that only works while both
// pods are on one node -- see the colocate() below.
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
  // one is shared so it comes in via extraVolumeMounts. Both reasons to
  // recreate apply here: the RWO volume, and hostNetwork -- a surge pod would
  // fail to bind 8123 on a node the old one is still holding.
  deploymentStrategy: DeploymentStrategy.recreate(),
});

// TODO: HC_API_PASSWORD is a non-expiring Home Assistant long-lived access
// token and HC_PASSWORD a login hash, both sitting in a ConfigMap in git. They
// belong in Bitwarden -- carried over as-is here only to keep the migration to
// one change at a time.
const configuratorConfig = new ConfigMap(shared, "configurator-cm", {
  metadata: {
    name: "configurator",
    namespace: namespace,
  },
  data: {
    HC_API_PASSWORD:
      "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiIwZTM0MjhjYmY2NmI0NmU4YTUxZWM2OTliMjNiMjVmZiIsImlhdCI6MTY1NzQ3NTM4NSwiZXhwIjoxOTcyODM1Mzg1fQ.-qiqwSkbM20TpzEkY621jQlo8azafujO8YHsHs2WJTE",
    HC_HASS_API: "http://home-assistant:8123/api",
    HC_PASSWORD: "{sha256}8ce1228d8b2140c4d1779944e5e122235eae15de96b1424c74aa825cb23e79cb",
    HC_USERNAME: "bschafer",
  },
});

const configurator = new AppPlus(app, "hass-configurator-app", {
  name: "hass-configurator",
  namespace: namespace,
  image: configuratorImage,
  resources: {
    cpu: {
      limit: Cpu.millis(50),
    },
    memory: {
      limit: Size.mebibytes(32),
    },
  },
  ports: [configuratorPort],
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
  },
  envFrom: [Env.fromConfigMap(configuratorConfig)],
  extraVolumeMounts: [
    {
      volume: Volume.fromPersistentVolumeClaim(app, "configurator-config-vol", configPvc),
      mountPath: "/hass-config",
    },
  ],
  ingressHosts: [{ host: hostname, path: "/configurator" }],
  tlsSecretName: tlsSecretName,
  // shares the RWO config volume with home-assistant
  deploymentStrategy: DeploymentStrategy.recreate(),
});

// The two share one RWO volume, so they have to land on the same node -- a
// hard requirement, not a preference: the second pod simply won't start
// otherwise.
configurator.Deployment.scheduling.colocate(hass.Deployment);

app.synth();

NewKustomize(app.outdir);
