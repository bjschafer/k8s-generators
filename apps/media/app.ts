import { App, Chart, Size } from "cdk8s";
import { NFSVolumeContainer } from "../../lib/nfs";
import {
  ArgoAppSource,
  ArgoUpdaterImageProps,
  NewArgoApp,
} from "../../lib/argo";
import { MediaApp, MediaAppProps } from "../../lib/media-app";
import { CLUSTER_ISSUER, DEFAULT_APP_PROPS } from "../../lib/consts";
import { basename } from "../../lib/util";
import { Cpu, Secret } from "cdk8s-plus-31";
import { NewKustomize } from "../../lib/kustomize";
import { Construct } from "constructs";
import { Certificate } from "../../imports/cert-manager.io";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

const mediaLabel = { "app.kubernetes.io/instance": "media" };

const nfsVols = new NFSVolumeContainer(app, "nfs-volume-container");
nfsVols.Add("nfs-media-downloads", {
  exportPath: "/warp/Media/Downloads",
  metadata: {
    labels: {
      ...mediaLabel,
    },
  },
});
nfsVols.Add("nfs-media-ebooks", {
  exportPath: "/warp/Media/Ebooks",
  metadata: {
    labels: {
      ...mediaLabel,
    },
  },
});
nfsVols.Add("nfs-media-music", {
  exportPath: "/warp/Media/Music",
  metadata: {
    labels: {
      ...mediaLabel,
    },
  },
});
nfsVols.Add("nfs-media-videos-movies", {
  exportPath: "/warp/Media/Videos/Movies",
  metadata: {
    labels: {
      ...mediaLabel,
    },
  },
});
nfsVols.Add("nfs-media-videos-tvshows", {
  exportPath: "/warp/Media/Videos/TVShows",
  metadata: {
    labels: {
      ...mediaLabel,
    },
  },
});

const mediaApps: Omit<
  MediaAppProps,
  "namespace" | "ingressSecret" | "resources"
>[] = [
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
    monitoringConfig: {
      enableExportarr: true,
      enableServiceMonitor: true,
      existingApiSecretName: "sonarr-api",
    },
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
    monitoringConfig: {
      enableExportarr: true,
      enableServiceMonitor: true,
      existingApiSecretName: "radarr-api",
    },
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
    monitoringConfig: {
      enableExportarr: true,
      enableServiceMonitor: true,
      existingApiSecretName: "lidarr-api",
    },
  },
  {
    name: "readarr",
    port: 8787,
    image: "lscr.io/linuxserver/readarr:develop",
    nfsMounts: [
      {
        mountPoint: "/downloads",
        nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      },
      {
        mountPoint: "/books",
        nfsConcreteVolume: nfsVols.Get("nfs-media-ebooks"),
      },
    ],
    monitoringConfig: {
      enableExportarr: true,
      enableServiceMonitor: true,
      existingApiSecretName: "readarr-api",
    },
  },
  {
    name: "sabnzbd",
    port: 8080,
    image: "ghcr.io/linuxserver/sabnzbd:latest",
    nfsMounts: [
      {
        mountPoint: "/downloads",
        nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      },
    ],
    monitoringConfig: {
      enableExportarr: true,
      enableServiceMonitor: true,
    },
  },
  {
    name: "prowlarr",
    port: 9696,
    image: "ghcr.io/linuxserver/prowlarr:latest",
    monitoringConfig: {
      enableExportarr: false,
      enableServiceMonitor: false,
    },
  },
];

const ingressSecret = Secret.fromSecretName(app, "media-tls", "media-tls");

for (const mediaApp of mediaApps) {
  new MediaApp(app, {
    name: mediaApp.name,
    namespace: namespace,
    port: mediaApp.port,
    image: mediaApp.image,
    resources: {
      cpu: {
        request: Cpu.millis(250),
      },
      memory: {
        request: Size.mebibytes(256),
      },
    },
    extraHostnames: mediaApp.extraHostnames,
    nfsMounts: mediaApp.nfsMounts ?? [],
    configVolume: mediaApp.configVolume ?? {
      size: Size.gibibytes(5),
      enableBackups: true,
    },
    monitoringConfig: mediaApp.monitoringConfig,
    ingressSecret: ingressSecret,
    extraEnv: mediaApp.extraEnv,
  });
}

// resilio-sync is special due to subpath mounts
new MediaApp(app, {
  name: "resilio-sync",
  namespace: namespace,
  port: 8888,
  image: "ghcr.io/linuxserver/resilio-sync:2.8.1",
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
  configVolume: {
    size: Size.gibibytes(1),
    enableBackups: true,
    mountPath: "/config",
  },
  monitoringConfig: {
    enableExportarr: false,
    enableServiceMonitor: false,
  },
  ingressSecret: ingressSecret,
});

// create the ingress cert manually, for all the cnames
class MediaCert extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Certificate(this, "cert", {
      metadata: {
        name: "media-tls",
        namespace: namespace,
        labels: {
          ...mediaLabel,
        },
      },
      spec: {
        secretName: ingressSecret.name,
        issuerRef: CLUSTER_ISSUER,
        dnsNames: mediaApps.sort().map((props): string => {
          return `${props.name}.cmdcentral.xyz`;
        }),
      },
    });
  }
}
new MediaCert(app, "certs");

NewArgoApp("media", {
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
      ...mediaApps.map(function (app): ArgoUpdaterImageProps {
        return {
          image: app.image.split(":")[0],
          versionConstraint: app.image.split(":").at(1),
          strategy: "digest",
        };
      }),
    ],
  },
});

app.synth();

// after synth, all files are written out to disk
NewKustomize(app.outdir);
