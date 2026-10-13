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
import { OpenBaoSecret } from "../../lib/secrets";
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
new OpenBaoSecret(app, "sonarr-api", {
  name: "sonarr-api",
  namespace: namespace,
  keys: ["APIKEY"],
});
new OpenBaoSecret(app, "radarr-api", {
  name: "radarr-api",
  namespace: namespace,
  keys: ["APIKEY"],
});
new OpenBaoSecret(app, "lidarr-api", {
  name: "lidarr-api",
  namespace: namespace,
  keys: ["APIKEY"],
});
new OpenBaoSecret(app, "sabnzbd-api", {
  name: "sabnzbd-api",
  namespace: namespace,
  keys: ["APIKEY"],
});

// referenced by name in navidrome.ts
new OpenBaoSecret(app, "navidrome-lastfm", {
  name: "navidrome-lastfm",
  namespace: namespace,
  keys: ["ND_LASTFM_APIKEY", "ND_LASTFM__SECRET"],
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
    {
      alert: "ArrIndexersUnavailable",
      // Only the "nothing can search" states. IndexerStatusCheck at warning level
      // (some indexers backing off) is routine: 100+ episodes per app over 90 days,
      // most past 15 minutes. Its error level means every indexer is down.
      expr: `max by (job) (
        {__name__=~"(sonarr|radarr|lidarr)_system_health_issues", source=~"IndexerRssCheck|IndexerSearchCheck"}
        or {__name__=~"(sonarr|radarr|lidarr)_system_health_issues", source="IndexerStatusCheck", type="error"}
      ) == 1`,
      for: "30m",
      labels: {
        priority: PRIORITY.NORMAL,
        ...SEND_TO_PUSHOVER,
      },
      annotations: {
        summary: "{{ $labels.job }} has had no usable indexers for 30 minutes",
      },
    },
    {
      alert: "ArrNotificationsFailing",
      // A Discord/Helmarr/Plex connection is in failure backoff, so the *arr's own
      // notifications are silently going nowhere. Episodes under an hour are
      // usually the same WAN blips behind ArrDownloadClientUnavailable.
      expr: `max by (job) ({__name__=~"(sonarr|radarr|lidarr)_system_health_issues", source="NotificationStatusCheck"}) == 1`,
      for: "1h",
      labels: {
        priority: PRIORITY.LOW,
        ...SEND_TO_PUSHOVER,
      },
      annotations: {
        summary: "{{ $labels.job }} has had failing notification connections for an hour",
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
