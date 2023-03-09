import {App} from "cdk8s";
import {NFSVolume} from "../../lib/nfs";
import {ArgoApp} from "../../lib/argo";
import {Quantity} from "../../imports/k8s";
import {MediaApp} from "../../lib/media-app";
import {DEFAULT_APP_PROPS} from "../../lib/consts";

const namespace = "media";
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

const nfsVols = new Map<string, NFSVolume>([
  [
    "nfs-media-downloads",
    new NFSVolume(app, "nfs-media-downloads", {
      namespace: namespace,
      exportPath: "/warp/Media/Downloads",
    }),
  ],
  [
    "nfs-media-music",
    new NFSVolume(app, "nfs-media-music", {
      namespace: namespace,
      exportPath: "/warp/Media/Music",
    }),
  ],
  [
    "nfs-media-videos-movies",
    new NFSVolume(app, "nfs-media-videos-movies", {
      namespace: namespace,
      exportPath: "/warp/Media/Videos/Movies",
    }),
  ],
  [
    "nfs-media-videos-tvshows",
    new NFSVolume(app, "nfs-media-videos-tvshows", {
      namespace: namespace,
      exportPath: "/warp/Media/Videos/TVShows",
    }),
  ],
]);

const mediaApps = [
  {
    name: "sonarr",
    port: 8989,
    image: "ghcr.io/linuxserver/sonarr:develop",
    nfsMounts: [
      nfsVols.get("nfs-media-downloads")!.AsUnifiedVolumeMount("/downloads"),
      nfsVols.get("nfs-media-videos-tvshows")!.AsUnifiedVolumeMount("/tv"),
    ],
  },
  {
    name: "radarr",
    port: 7878,
    image: "ghcr.io/linuxserver/radarr:nightly",
    nfsMounts: [
      nfsVols.get("nfs-media-downloads")!.AsUnifiedVolumeMount("/downloads"),
      nfsVols.get("nfs-media-videos-movies")!.AsUnifiedVolumeMount("/movies"),
    ],
  },
  {
    name: "lidarr",
    port: 8686,
    image: "ghcr.io/linuxserver/lidarr:develop",
    nfsMounts: [
      nfsVols.get("nfs-media-downloads")!.AsUnifiedVolumeMount("/downloads"),
      nfsVols.get("nfs-media-music")!.AsUnifiedVolumeMount("/music"),
    ],
  },
  {
    name: "nzbget",
    port: 6789,
    image: "ghcr.io/linuxserver/nzbget:latest",
    nfsMounts: [
      nfsVols.get("nfs-media-downloads")!.AsUnifiedVolumeMount("/downloads"),
    ],
  },
  {
    name: "prowlarr",
    port: 9696,
    image: "ghcr.io/linuxserver/prowlarr:latest",
  },
];

for (const mediaApp of mediaApps) {
  new MediaApp(app, {
    name: mediaApp.name,
    namespace: namespace,
    port: mediaApp.port,
    useExternalDNS: false,
    enableProbes: true,
    image: mediaApp.image,
    resources: {
      requests: {
        cpu: Quantity.fromString("250m"),
        memory: Quantity.fromString("256Mi"),
      },
    },
    nfsMounts: mediaApp.nfsMounts ?? [],
    configVolumeSize: Quantity.fromString("5Gi"),
    configEnableBackups: true,
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
    requests: {
      cpu: Quantity.fromString("250m"),
      memory: Quantity.fromString("256Mi"),
    },
  },
  nfsMounts: [
    {
      mountPath: "/downloads",
      volume: nfsVols.get("nfs-media-downloads")!.ToVolume(),
      volumeMount: {
        name: "nfs-media-downloads",
        mountPath: "/downloads",
        subPath: "seedbox/downloads",
      },
    },
    {
      mountPath: "/sync",
      volume: nfsVols.get("nfs-media-downloads")!.ToVolume(),
      volumeMount: {
        name: "nfs-media-downloads",
        mountPath: "/sync",
        subPath: "seedbox/sync",
      },
    },
  ],
  configVolumeSize: Quantity.fromString("5Gi"),
  configEnableBackups: true,
});

app.synth();
