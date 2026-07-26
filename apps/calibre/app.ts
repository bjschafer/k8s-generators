import { basename } from "../../lib/util";
import { App, Duration, Size } from "cdk8s";
import { DEFAULT_APP_PROPS, LSIO_ENVVALUE } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import { NFSVolumeContainer } from "../../lib/nfs";
import { StorageClass } from "../../lib/volume";
import {
  Cpu,
  EnvValue,
  PersistentVolume,
  PersistentVolumeAccessMode,
  Probe,
  Volume,
} from "cdk8s-plus-34";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

const image = "lscr.io/linuxserver/calibre";
// the calibre desktop app, served at calibre-admin
const adminPort = 8080;
// the content server it publishes, served at calibre
const webserverPort = 8081;

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "semver",
        versionConstraint: "9.x",
      },
    ],
  },
});

const nfsVols = new NFSVolumeContainer(app, "nfs-volume-container");
nfsVols.Add("calibre-nfs-books", {
  exportPath: "/warp/Media/Ebooks",
  // The NAS as reached from the server VLAN. lib/nfs.ts defaults to its
  // storage-VLAN address, which is how the media namespace mounts this very
  // same export; calibre has been on 10.0.10.5 since the PV was created and a
  // migration is the wrong time to also move which interface it mounts over.
  nfsHost: "10.0.10.5",
  storage: Size.tebibytes(1),
  claimName: "nfs-books",
});
const books = nfsVols.Get("calibre-nfs-books");

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: image,
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.gibibytes(1),
      limit: Size.gibibytes(2),
    },
  },
  ports: [
    { number: adminPort, name: "http" },
    { number: webserverPort, name: "webserver" },
  ],
  extraEnv: {
    ...LSIO_ENVVALUE,
    UMASK_SET: EnvValue.fromValue("022"),
  },
  volumes: [
    {
      name: "config",
      mountPath: "/config",
      props: {
        storage: Size.gibibytes(2),
        storageClassName: StorageClass.CEPH_RBD,
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        // Pinned: this holds the calibre library metadata database. The books
        // are on NFS, but losing this loses the catalogue that indexes them.
        volume: PersistentVolume.fromPersistentVolumeName(
          app,
          "calibre-config-pv",
          "pvc-0173fc7b-de0e-44c9-86c7-b2dc7837f040",
        ),
      },
    },
  ],
  extraVolumeMounts: [
    {
      volume: Volume.fromPersistentVolumeClaim(app, "books-vol", books.pvc),
      mountPath: "/books",
    },
  ],
  livenessProbe: Probe.fromTcpSocket({ port: adminPort }),
  readinessProbe: Probe.fromTcpSocket({
    port: adminPort,
    initialDelaySeconds: Duration.seconds(10),
  }),
  startupProbe: Probe.fromTcpSocket({
    port: adminPort,
    initialDelaySeconds: Duration.seconds(10),
    periodSeconds: Duration.seconds(5),
    failureThreshold: 30,
  }),
  ingressHosts: [
    { host: "calibre-admin.cmdcentral.xyz", port: adminPort },
    { host: "calibre.cmdcentral.xyz", port: webserverPort },
  ],
});

app.synth();

NewKustomize(app.outdir);
