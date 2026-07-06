import { App, Chart, Size } from "cdk8s";
import { Cpu, Secret } from "cdk8s-plus-34";
import { Construct } from "constructs";
import { Certificate } from "../../imports/cert-manager.io";
import { ArgoAppSource, ArgoUpdaterImageProps, NewArgoApp } from "../../lib/argo";
import { CLUSTER_ISSUER, DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { MediaApp, MediaAppProps } from "../../lib/media-app";
import { NFSVolumeContainer } from "../../lib/nfs";
import { BitwardenSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";
import { Kometa } from "./kometa";
import { Navidrome } from "./navidrome";

export const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

export const mediaLabel = { "app.kubernetes.io/instance": "media" };

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

const mediaApps: Omit<MediaAppProps, "namespace" | "ingressSecret" | "resources">[] = [
  {
    name: "sonarr",
    port: 8989,
    image: "ghcr.io/linuxserver/sonarr:latest",
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
    image: "ghcr.io/linuxserver/radarr:latest",
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
    image: "ghcr.io/linuxserver/lidarr:latest",
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
      existingApiSecretName: "sabnzbd-api",
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

// exportarr API-key secrets, referenced by name via existingApiSecretName above
new BitwardenSecret(app, "sonarr-api", {
  name: "sonarr-api",
  namespace: namespace,
  data: {
    APIKEY: "9a5c19fe-540f-4118-b27d-b47e01821945",
  },
});
new BitwardenSecret(app, "radarr-api", {
  name: "radarr-api",
  namespace: namespace,
  data: {
    APIKEY: "5c46e216-ac6c-4cd0-a268-b47e0182092b",
  },
});
new BitwardenSecret(app, "lidarr-api", {
  name: "lidarr-api",
  namespace: namespace,
  data: {
    APIKEY: "dd23efa0-4b21-4ecb-bc79-b47e0182089b",
  },
});
new BitwardenSecret(app, "sabnzbd-api", {
  name: "sabnzbd-api",
  namespace: namespace,
  data: {
    APIKEY: "37529817-2277-4d51-ad84-b47e018209b4",
  },
});

// referenced by name in navidrome.ts
new BitwardenSecret(app, "navidrome-lastfm", {
  name: "navidrome-lastfm",
  namespace: namespace,
  data: {
    ND_LASTFM_APIKEY: "9f043b19-e039-40f6-a09f-b47e018219e4",
    ND_LASTFM__SECRET: "b7e23cb7-432e-4557-b0bf-b47e01821a13",
  },
});

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
        dnsNames: [
          "music.cmdcentral.xyz",
          "navidrome.cmdcentral.xyz",
          ...mediaApps.toSorted().map((props): string => {
            return `${props.name}.cmdcentral.xyz`;
          }),
        ],
      },
    });
  }
}
new MediaCert(app, "certs");

new Kometa(app, "kometa");
new Navidrome(app, "navidrome");

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
      {
        image: "ghcr.io/navidrome/navidrome",
        versionConstraint: "latest",
        strategy: "digest",
      },
      ...mediaApps.map(function (mediaApp): ArgoUpdaterImageProps {
        return {
          image: mediaApp.image.split(":")[0],
          versionConstraint: mediaApp.image.split(":").at(1),
          strategy: "digest",
        };
      }),
    ],
  },
});

app.synth();

// after synth, all files are written out to disk
NewKustomize(app.outdir);
