import { basename } from "../../lib/util";
import { DEFAULT_APP_PROPS, NONROOT_SECURITY_CONTEXT_UID } from "../../lib/consts";
import { App, Size } from "cdk8s";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { StorageClass } from "../../lib/volume";
import { PersistentVolume, PersistentVolumeAccessMode, Probe } from "cdk8s-plus-34";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "powerdnsadmin/pda-legacy";

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
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
    memory: {
      request: Size.mebibytes(192),
      limit: Size.mebibytes(512),
    },
  },
  ports: [80],
  // audited safe: image ships USER=pda, which is uid 100 / gid 101. Spelled out
  // because the kubelet can't verify a non-numeric USER against runAsNonRoot.
  securityContext: NONROOT_SECURITY_CONTEXT_UID(100, 101),
  containerSecurityContext: NONROOT_SECURITY_CONTEXT_UID(100, 101),
  volumes: [
    {
      props: {
        storageClassName: StorageClass.CEPH_RBD,
        storage: Size.gibibytes(5),
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        // Pinned to the volume this app has used since it was hand-applied from
        // the prod repo. Without this the claim is satisfied by dynamic
        // provisioning and pdns-admin comes back with an empty database.
        // A longhorn migration was written here once (37eef77a) but never
        // deployed -- doing it for real needs a data copy, not a manifest edit.
        volume: PersistentVolume.fromPersistentVolumeName(
          app,
          "pdns-admin-config-pv",
          "pvc-21ad7eba-9add-477e-a3c4-e1147528c57d",
        ),
      },
      mountPath: "/data",
      name: "app-config",
    },
  ],
  livenessProbe: Probe.fromHttpGet("", { port: 80 }),
  readinessProbe: Probe.fromHttpGet("", { port: 80 }),
  extraIngressHosts: ["dnsadmin.cmdcentral.xyz"],
  limitToAMD64: true,
});

app.synth();

NewKustomize(app.outdir);
