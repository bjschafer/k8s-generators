import { basename } from "../../lib/util";
import { App, Duration, Size } from "cdk8s";
import {
  DEFAULT_APP_PROPS,
  DNS_POLICY_NONE,
  NONROOT_SECURITY_CONTEXT_UID,
  TZ,
} from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import { StorageClass } from "../../lib/volume";
import {
  Capability,
  Cpu,
  EnvValue,
  FsGroupChangePolicy,
  PersistentVolume,
  PersistentVolumeAccessMode,
  Probe,
  SeccompProfileType,
} from "cdk8s-plus-34";

const namespace = basename(__dirname);
// the app was renamed upstream (overseerr -> seerr); the namespace, ingress
// hostname and TLS secret still carry the old name.
const name = "seerr";
const app = new App(DEFAULT_APP_PROPS(namespace));

const image = "ghcr.io/seerr-team/seerr";
const port = 5055;

NewArgoApp(namespace, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "digest",
      },
    ],
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:latest`,
  resources: {
    cpu: {
      request: Cpu.millis(50),
      limit: Cpu.millis(850),
    },
    memory: {
      request: Size.mebibytes(256),
      limit: Size.mebibytes(512),
    },
  },
  ports: [port],
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
  },
  // audited safe: runs as 1000:1000, which is also what owns the config volume
  securityContext: {
    ...NONROOT_SECURITY_CONTEXT_UID(1000, 1000),
    fsGroup: 1000,
    // as in the hand-written manifests: the default (Always) rechowns the
    // whole 10Gi config volume on every pod start for no benefit, since
    // nothing else writes to it.
    fsGroupChangePolicy: FsGroupChangePolicy.ON_ROOT_MISMATCH,
  },
  containerSecurityContext: {
    ...NONROOT_SECURITY_CONTEXT_UID(1000, 1000),
    // carried over from the hand-written manifests. Not the repo-wide default
    // (lib/consts.ts) yet, so it has to be spelled out here or the migration
    // would quietly unharden the container.
    capabilities: { drop: [Capability.ALL] },
    seccompProfile: { type: SeccompProfileType.RUNTIME_DEFAULT },
  },
  volumes: [
    {
      name: "config",
      mountPath: "/app/config",
      props: {
        storage: Size.gibibytes(10),
        storageClassName: StorageClass.CEPH_RBD,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        // Pinned so a recreated claim can't come back as an empty dynamically
        // provisioned volume -- this holds the whole request history.
        volume: PersistentVolume.fromPersistentVolumeName(
          app,
          "seerr-config-pv",
          "pvc-430b7d0f-c675-4f6a-b363-9f8d04101b04",
        ),
      },
    },
  ],
  livenessProbe: Probe.fromTcpSocket({ port: port }),
  readinessProbe: Probe.fromTcpSocket({ port: port }),
  startupProbe: Probe.fromTcpSocket({
    port: port,
    failureThreshold: 30,
    periodSeconds: Duration.seconds(5),
  }),
  dns: DNS_POLICY_NONE,
  ingressHosts: [{ host: "plexrequests.cmdcentral.xyz" }],
  tlsSecretName: `${namespace}-tls`,
  ingressLabels: {
    "cmdcentral.xyz/external": "true",
  },
});

app.synth();

NewKustomize(app.outdir);
