import { App, Chart, Size } from "cdk8s";
import { Cpu, Secret } from "cdk8s-plus-34";
import { Construct } from "constructs";
import { Certificate } from "../../imports/cert-manager.io";
import { ArgoAppSource, ArgoUpdaterImageProps, NewArgoApp } from "../../lib/argo";
import {
  CLUSTER_ISSUER,
  DEFAULT_APP_PROPS,
  MEDIA_GID,
  MEDIA_UID,
  NONROOT_SECURITY_CONTEXT_UID,
} from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { Alert, PRIORITY, SEND_TO_PUSHOVER } from "../../lib/monitoring/alerts";
import { MediaApp, MediaAppProps } from "../../lib/media-app";
import { NFSVolumeContainer } from "../../lib/nfs";
import { BitwardenSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";
import { CHECKRR_IMAGE, Checkrr } from "./checkrr";
import { KOMETA_IMAGE, Kometa } from "./kometa";
import { NAVIDROME_IMAGE, Navidrome } from "./navidrome";
import { SEEDBOX_PULL_IMAGE, SeedboxPull } from "./seedbox-pull";

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
  {
    // Strikes and removes bad downloads from the *arr queues -- malware,
    // executables, stalled and failed imports -- then blocklists the release
    // and re-searches. Configured entirely in its web UI (which has its own
    // login); that state lives on the config PVC, not in git.
    name: "cleanuparr",
    port: 11011,
    image: "ghcr.io/cleanuparr/cleanuparr:latest",
    // Its entrypoint skips the PUID/PGID gosu dance when started non-root and
    // only needs /config writable.
    securityContext: {
      ...NONROOT_SECURITY_CONTEXT_UID(Number(MEDIA_UID), Number(MEDIA_GID)),
      fsGroup: Number(MEDIA_GID),
    },
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
    securityContext: mediaApp.securityContext,
    enableServiceLinks: mediaApp.enableServiceLinks,
    probeOptions: mediaApp.probeOptions,
    emptyDirMounts: mediaApp.emptyDirMounts,
  });
}

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
new Checkrr(app, "checkrr", {
  tv: nfsVols.Get("nfs-media-videos-tvshows"),
  movies: nfsVols.Get("nfs-media-videos-movies"),
  schedule: "0 4 * * *",
  reacquire: true,
});
new SeedboxPull(app, "seedbox-pull", {
  downloads: nfsVols.Get("nfs-media-downloads"),
  destDir: "sync",
  prune: true,
});

new Alert(app, "alerts", {
  name: "media",
  namespace: namespace,
  rules: [
    {
      alert: "ArrDownloadClientUnavailable",
      // Replaces the *arrs' own "On Health Issue" notifications, which fire on every
      // seedbox/WAN blip. Over 30 days every episode cleared within 6 minutes.
      // Aggregated away from `message`: it embeds the exception text, which changes
      // mid-outage and would restart the `for` clock.
      expr: `max by (job) ({__name__=~"(sonarr|radarr|lidarr)_system_health_issues", source="DownloadClientCheck"}) == 1`,
      for: "15m",
      labels: {
        priority: PRIORITY.NORMAL,
        ...SEND_TO_PUSHOVER,
      },
      annotations: {
        summary: "{{ $labels.job }} has been unable to reach a download client for 15 minutes",
      },
    },
  ],
});

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
    // Derived from every image this app actually deploys, rather than from
    // `mediaApps` plus a hand-maintained tail. navidrome, kometa,
    // seedbox-pull and checkrr are each constructed outside that array, and only navidrome
    // was ever restated here -- so kometa sat unwatched for as long as it has
    // existed.
    images: [
      NAVIDROME_IMAGE,
      KOMETA_IMAGE,
      SEEDBOX_PULL_IMAGE,
      CHECKRR_IMAGE,
      ...mediaApps.map((mediaApp) => mediaApp.image),
    ].map(function (image): ArgoUpdaterImageProps {
      return {
        image: image.split(":")[0],
        versionConstraint: image.split(":").at(1),
        strategy: "digest",
      };
    }),
  },
});

app.synth();

// after synth, all files are written out to disk
NewKustomize(app.outdir);
