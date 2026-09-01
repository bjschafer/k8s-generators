import { App, Chart, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, Secret } from "cdk8s-plus-34";
import { Construct } from "constructs";
import { Certificate } from "../../imports/cert-manager.io";
import { ArgoAppSource, ArgoUpdaterImageProps, NewArgoApp } from "../../lib/argo";
import {
  CLUSTER_ISSUER,
  DEFAULT_APP_PROPS,
  DEFAULT_SECURITY_CONTEXT,
  MEDIA_GID,
  MEDIA_UID,
  NONROOT_SECURITY_CONTEXT_UID,
} from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { MediaApp, MediaAppProps } from "../../lib/media-app";
import { NFSVolumeContainer } from "../../lib/nfs";
import { BitwardenSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";
import { KOMETA_IMAGE, Kometa } from "./kometa";
import { NAVIDROME_IMAGE, Navidrome } from "./navidrome";

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
nfsVols.Add("nfs-media-audiobooks", {
  exportPath: "/warp/Media/Audiobooks",
  metadata: {
    labels: {
      ...mediaLabel,
    },
  },
});
nfsVols.Add("nfs-media-comics", {
  exportPath: "/warp/Media/Comics",
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

// Declared up here rather than alongside the exportarr API-key secrets below,
// because shelfarr takes it as a typed EnvValue inside the `mediaApps` literal
// rather than by name the way `existingApiSecretName` does.
const shelfarrOidc = new BitwardenSecret(app, "shelfarr-oidc", {
  name: "shelfarr-oidc",
  namespace: namespace,
  data: {
    SHELFARR_SETTING_OIDC_CLIENT_SECRET: "6fd11c24-cf0d-4df9-b08d-b4a50031ca65",
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
    // Readarr's successor -- Readarr was archived in June 2025 when its
    // metadata backend went offline. Bindery is a single Go binary with
    // SQLite and multiple metadata sources.
    name: "bindery",
    port: 8787,
    image: "ghcr.io/vavallee/bindery:latest",
    // Unlike the linuxserver.io images, this one is distroless and its USER is
    // the *name* `nonroot`, which the kubelet can't resolve -- so the uid has
    // to be numeric. It's pinned to MEDIA_UID/MEDIA_GID rather than the
    // image's own nonroot uid so it writes NFS files with the same ownership
    // as the rest of the stack; the export is root_squashed, so a mismatched
    // uid means silent write failures on import. fsGroup covers the Ceph RBD
    // config volume, which is otherwise root-owned on first attach.
    securityContext: {
      ...NONROOT_SECURITY_CONTEXT_UID(Number(MEDIA_UID), Number(MEDIA_GID)),
      fsGroup: Number(MEDIA_GID),
    },
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
    // The service is named `bindery`, so kubelet injects BINDERY_PORT=
    // tcp://<clusterIP>:8787 as a Docker-link var -- which is exactly the name
    // bindery reads its listen port from, and it crashes on the URL ("too many
    // colons in address"). Nothing here wants the link vars, so turn them off
    // rather than play whack-a-mole with the BINDERY_* namespace.
    enableServiceLinks: false,
    extraEnv: {
      // Belt-and-suspenders against the collision above: an explicit container
      // env var outranks an injected link var even if these are re-enabled.
      BINDERY_PORT: EnvValue.fromValue("8787"),
      // Keep the SQLite DB on the RWO Ceph volume -- SQLite in WAL mode over
      // NFS is a corruption risk.
      BINDERY_DATA_DIR: EnvValue.fromValue("/config"),
      BINDERY_DB_PATH: EnvValue.fromValue("/config/bindery.db"),
      BINDERY_LIBRARY_DIR: EnvValue.fromValue("/books"),
      BINDERY_DOWNLOAD_DIR: EnvValue.fromValue("/downloads"),
      // Sanity assertions -- bindery checks these against the uid it actually
      // runs as and fails loudly on a mismatch.
      BINDERY_PUID: EnvValue.fromValue(MEDIA_UID),
      BINDERY_PGID: EnvValue.fromValue(MEDIA_GID),
      BINDERY_TELEMETRY_DISABLED: EnvValue.fromValue("true"),
    },
    monitoringConfig: {
      // exportarr has no bindery provider.
      enableExportarr: false,
      enableServiceMonitor: false,
    },
  },
  {
    // Jellyseerr-for-books: request UI on top of the indexers bindery already
    // uses, *plus* direct downloads from Anna's Archive, Z-Library and
    // LibriVox. It complements bindery rather than replacing it -- bindery
    // monitors authors for future releases, which shelfarr does not do;
    // shelfarr reaches the shadow-library sources, which bindery deliberately
    // won't (vavallee/bindery#1017: "stable, documented APIs only, no
    // scraping").
    name: "shelfarr",
    port: 5056,
    image: "ghcr.io/pedro-revez-silva/shelfarr:latest",
    // Rails/Puma, and it runs migrations and regenerates its bootsnap cache on
    // boot -- the default probes start at t=0 and give up after ~30s, which
    // crash-loops it before it ever listens. Upstream's compose allows 40s.
    probeOptions: {
      initialDelay: Duration.seconds(180),
    },
    // The image bakes a ~88MB bootsnap cache into /rails/tmp/cache, owned by
    // uid 1000. Running as MEDIA_UID means the entrypoint has to chown -R it,
    // and on overlayfs changing ownership copies every one of those ~9.4k files
    // up out of the image layer -- which takes long enough that the kubelet
    // kills the container mid-chown, forever. Masking the path leaves the chown
    // walking the four files that remain; Rails just rebuilds the cache, which
    // costs seconds per start rather than minutes.
    emptyDirMounts: [{ mountPoint: "/rails/tmp/cache", sizeLimit: Size.gibibytes(1) }],
    // Its own env vars live under the SHELFARR_ prefix, which is exactly the
    // namespace kubelet fills with Docker-link vars for a service named
    // `shelfarr` (SHELFARR_PORT=tcp://... and friends). Nothing here wants
    // them -- same reasoning as bindery above.
    enableServiceLinks: false,
    // LSIO-style entrypoint: starts as root, then steps down to PUID/PGID.
    // fsGroup covers the Ceph RBD volume, which is root-owned on first attach
    // and would otherwise be unwritable after the step-down.
    securityContext: {
      ...DEFAULT_SECURITY_CONTEXT,
      fsGroup: Number(MEDIA_GID),
    },
    // The SQLite DB, Solid Queue state and the auto-generated RAILS_MASTER_KEY
    // all live here. Losing this volume means losing the key, and with it every
    // stored indexer/download-client credential.
    configVolume: {
      size: Size.gibibytes(5),
      mountPath: "/rails/storage",
    },
    nfsMounts: [
      {
        mountPoint: "/downloads",
        nfsConcreteVolume: nfsVols.Get("nfs-media-downloads"),
      },
      {
        mountPoint: "/ebooks",
        nfsConcreteVolume: nfsVols.Get("nfs-media-ebooks"),
      },
      // Shelfarr treats audiobooks and Comics & Manga as content kinds beside
      // ebooks, each with its own output path, path template and metadata
      // provider. None of that is in the README -- it lives in
      // app/services/settings_service.rb and app/models/content_kinds.rb --
      // but it is real: ContentKinds has BOOK and GRAPHIC, and the settings
      // registry carries comicbook_output_path, comicbook_path_template and a
      // Comic Vine provider.
      //
      // These mount points are deliberately the shipped defaults for
      // audiobook_output_path and comicbook_output_path, so delivery works
      // with no Admin -> Settings edit at all. Worth knowing if either mount
      // is ever renamed: the settings are stored in the SQLite DB and there is
      // no SHELFARR_SETTING_* override for them (unsupported ones are ignored
      // with a boot-time warning), so a rename becomes a manual UI change.
      {
        mountPoint: "/audiobooks",
        nfsConcreteVolume: nfsVols.Get("nfs-media-audiobooks"),
      },
      {
        mountPoint: "/comics",
        nfsConcreteVolume: nfsVols.Get("nfs-media-comics"),
      },
    ],
    extraEnv: {
      // Defaults to 80, which Puma can't bind after dropping to PUID.
      HTTP_PORT: EnvValue.fromValue("5056"),
      // Without this the image's default command starts Puma and nothing else:
      // config/puma.rb gates `plugin :solid_queue` on this variable, so every
      // background job is written into the Solid Queue SQLite DB and never
      // claimed. It is silent -- the UI works, connection tests pass, the
      // queue just grows. That covers the BookOrbit library sync, search,
      // download monitoring, import post-processing and health checks, i.e.
      // essentially everything the app does after you click a button.
      // Upstream's docker-compose sets it and the image does not.
      //
      // In-Puma rather than a second deployment running `bin/jobs`: the queue
      // lives in /rails/storage alongside the main DB, and that volume is Ceph
      // RBD (RWO), so a worker pod could not attach it anyway.
      SOLID_QUEUE_IN_PUMA: EnvValue.fromValue("1"),
      // Deliberately leaving CHOWN_ON_START at its `auto` default. `never`
      // looks like the right call for a root_squashed export, but the
      // entrypoint only ever applies it to /rails/storage and /rails/tmp --
      // never to the NFS mounts -- and it doesn't merely skip the chown, it
      // skips it and still hard-fails the writability check that follows. That
      // crashloops on /rails/tmp, which is image-internal and root-owned.
      // `auto` is safe here on both counts: it probes writability as the rails
      // user first and returns early (so the NFS trees, already MEDIA_UID
      // -owned, are never chowned), and a chown that does fail is only fatal
      // under `always`. TRUST_NFS_UID_SQUASH stays off -- it's for all_squash.

      // Authenticate against Authentik, like navidrome and bookorbit -- the
      // *arrs next door stay on local auth because only I touch them, whereas
      // this one is the request front door other people log into. The provider
      // lives in the tf-authentik repo, not here.
      //
      // These are read-only in Admin -> Settings while set, and nothing is
      // written back to the DB. Trailing slash on the issuer is load-bearing:
      // omniauth runs discovery and then checks the document's `issuer` against
      // the configured one, and Authentik reports it with the slash.
      SHELFARR_SETTING_OIDC_ENABLED: EnvValue.fromValue("true"),
      SHELFARR_SETTING_OIDC_PROVIDER_NAME: EnvValue.fromValue("Authentik"),
      SHELFARR_SETTING_OIDC_ISSUER: EnvValue.fromValue(
        "https://login.cmdcentral.xyz/application/o/shelfarr/",
      ),
      SHELFARR_SETTING_OIDC_CLIENT_ID: EnvValue.fromValue(
        "08ae198e701da5e7b18226e2fd091655939dc5c7",
      ),
      SHELFARR_SETTING_OIDC_SCOPES: EnvValue.fromValue("openid profile email"),
      // Sends the login page straight to Authentik. Note this does not disable
      // password auth -- sessions_controller gates the redirect on
      // `params[:local].blank?`, so `?local=1` still reaches the form. It's
      // moot in practice: an OIDC-created user never gets a password_digest,
      // and has_secure_password can't authenticate against a nil digest.
      SHELFARR_SETTING_OIDC_AUTO_REDIRECT: EnvValue.fromValue("true"),
      SHELFARR_SETTING_OIDC_AUTO_CREATE_USERS: EnvValue.fromValue("true"),
      // Everyone provisioned from here on is a requester. The very first
      // account is exempt -- User's before_create makes it admin regardless.
      SHELFARR_SETTING_OIDC_DEFAULT_ROLE: EnvValue.fromValue("user"),
      ...shelfarrOidc.toEnvValues(),
    },
    monitoringConfig: {
      // Not an *arr -- no exportarr provider, and it exposes no /metrics.
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

// resilio-sync is special due to subpath mounts
// The only image here on a fixed tag rather than `:latest`, so the digest
// strategy below follows 2.8.1's digest and can never reach 2.8.2 or 2.9 --
// this is a full freeze, and Renovate is the only thing that will say so.
// renovate: datasource=docker depName=ghcr.io/linuxserver/resilio-sync
const resilioVersion = "3.1.2";
const resilioImage = `ghcr.io/linuxserver/resilio-sync:${resilioVersion}`;
new MediaApp(app, {
  name: "resilio-sync",
  namespace: namespace,
  port: 8888,
  image: resilioImage,
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
    // Derived from every image this app actually deploys, rather than from
    // `mediaApps` plus a hand-maintained tail. navidrome, resilio-sync and
    // kometa are each constructed outside that array, and only navidrome was
    // ever restated here -- so resilio-sync and kometa sat unwatched, kometa
    // for as long as it has existed.
    images: [
      NAVIDROME_IMAGE,
      resilioImage,
      KOMETA_IMAGE,
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
