import { App, Size } from "cdk8s";
import { NFSVolumeContainer } from "../../lib/nfs";
import { ArgoApp } from "../../lib/argo";
import { MediaApp } from "../../lib/media-app";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { basename } from "../../lib/util";
import { Cpu, Secret } from "cdk8s-plus-26";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

new ArgoApp(app, "media", {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  recurse: true,
});

const nfsVols = new NFSVolumeContainer(app, "nfs-volume-container");
nfsVols.Add("nfs-media-downloads", {
  exportPath: "/warp/Media/Downloads",
});
nfsVols.Add("nfs-media-music", {
  exportPath: "/warp/Media/Music",
});
nfsVols.Add("nfs-media-videos-movies", {
  exportPath: "/warp/Media/Videos/Movies",
});
nfsVols.Add("nfs-media-videos-tvshows", {
  exportPath: "/warp/Media/Videos/TVShows",
});

const mediaApps = [
  {
    name: "sonarr",
    port: 8989,
    image: "ghcr.io/linuxserver/sonarr:develop",
    nfsMounts: [
      {
        mountPoint: "/downloads",
        nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      },
      {
        mountPoint: "/tv",
        nfsConcreteVolume: nfsVols.Get("nfs-media-videos-tvshows"),
      },
    ],
    enableExportarr: true,
  },
  {
    name: "radarr",
    port: 7878,
    image: "ghcr.io/linuxserver/radarr:nightly",
    nfsMounts: [
      {
        mountPoint: "/downloads",
        nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      },
      {
        mountPoint: "/movies",
        nfsConcreteVolume: nfsVols.Get("nfs-media-videos-movies"),
      },
    ],
    enableExportarr: true,
  },
  {
    name: "lidarr",
    port: 8686,
    image: "ghcr.io/linuxserver/lidarr:develop",
    nfsMounts: [
      {
        mountPoint: "/downloads",
        nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      },
      {
        mountPoint: "/music",
        nfsConcreteVolume: nfsVols.Get("nfs-media-music"),
      },
    ],
    enableExportarr: true,
  },
  {
    name: "nzbget",
    port: 6789,
    image: "ghcr.io/linuxserver/nzbget:latest",
    nfsMounts: [
      {
        mountPoint: "/downloads",
        nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      },
    ],
    enableExportarr: false,
  },
  {
    name: "prowlarr",
    port: 9696,
    image: "ghcr.io/linuxserver/prowlarr:latest",
    enableExportarr: false,
  },
];

const ingressSecret = Secret.fromSecretName(app, "media-tls", "media-tls");

for (const mediaApp of mediaApps) {
  new MediaApp(app, {
    name: mediaApp.name,
    namespace: namespace,
    port: mediaApp.port,
    useExternalDNS: false,
    enableProbes: true,
    image: mediaApp.image,
    resources: {
      cpu: {
        request: Cpu.millis(250),
      },
      memory: {
        request: Size.mebibytes(256),
      },
    },
    nfsMounts: mediaApp.nfsMounts ?? [],
    configVolumeSize: Size.gibibytes(5),
    configEnableBackups: true,
    enableExportarr: mediaApp.enableExportarr,
    ingressSecret: ingressSecret,
  });
}

// resilio-sync is special due to subpath mounts
new MediaApp(app, {
  name: "resilio-sync",
  namespace: namespace,
  port: 8888,
  useExternalDNS: false,
  enableProbes: true,
  image: "ghcr.io/linuxserver/resilio-sync:latest",
  resources: {
    cpu: {
      request: Cpu.millis(250),
    },
    memory: {
      request: Size.mebibytes(256),
    },
  },
  nfsMounts: [
    {
      mountPoint: "/downloads",
      nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      mountOptions: {
        subPath: "seedbox/downloads",
      },
    },
    {
      mountPoint: "/sync",
      nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      mountOptions: {
        subPath: "seedbox/sync",
      },
    },
  ],
  configVolumeSize: Size.gibibytes(5),
  configEnableBackups: true,
  enableExportarr: false,
  ingressSecret: ingressSecret,
});

app.synth();
