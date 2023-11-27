import { basename } from "path";
import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { EnvValue, Probe } from "cdk8s-plus-27";
import { NewKustomize } from "../../lib/kustomize";
import { HomeConfig } from "./config";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "jordanroher/starbase-80";
const port = 4173;

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
    syncOptions: ["CreateNamespace=true"],
  },
  namespace: namespace,
  recurse: true,
  autoUpdate: {
    writebackMethod: {
      method: "git",
      gitBranch: "main",
    },
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
  image: image,
  annotations: {
    "reloader.stakater.com/auto": "true",
  },
  resources: {
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(256),
    },
  },
  replicas: 2,
  ports: [port],
  livenessProbe: Probe.fromHttpGet("", { port: port }),
  readinessProbe: Probe.fromHttpGet("", { port: port }),
  extraIngressHosts: ["cmdcentral.xyz"],
  extraEnv: {
    TITLE: EnvValue.fromValue("Cmdcentral Home"), // defaults to "My Website", set to TITLE= to hide the title
    LOGO: EnvValue.fromValue(""), // defaults to /logo.png, set to LOGO= to hide the logo
    HEADER: EnvValue.fromValue("false"), // defaults to true, set to false to hide the title and logo
    // HEADERLINE=true # defaults to true, set to false to turn off the header border line
    // HEADERTOP=true # defaults to false, set to true to force the header to always stay on top
    // CATEGORIES=small # defaults to normal, set to small for smaller, uppercase category labels
    // BGCOLOR=#fff # defaults to theme(colors.slate.50), set to any hex color or Tailwind color using the theme syntax
    // BGCOLORDARK=#000 # defaults to theme(colors.gray.950), set to any hex color or Tailwind color using the theme syntax
    // NEWWINDOW=true # defaults to true, set to false to not have links open in a new window
  },
  configmapMounts: [
    {
      name: `${name}-config`,
      mountPath: "/app/src/config.json",
      subPath: "config.json",
    },
  ],
});

new HomeConfig(app, `${name}-config`, {
  links: [
    {
      services: [
        {
          name: "Gitea",
          uri: "https://git.cmdcentral.xyz",
          icon: "gitea",
          description: "Local code repository",
          iconBubble: false,
        },
        {
          name: "Grafana",
          uri: "https://grafana.cmdcentral.xyz",
          icon: "grafana",
          description: "Dashboards",
          iconBubble: false,
        },
        {
          name: "Home Assistant",
          uri: "https://hass.cmdcentral.xyz",
          icon: "home-assistant",
          description: "Control the house",
          iconBubble: false,
        },
        {
          name: "Miniflux",
          uri: "https://rss.cmdcentral.xyz",
          icon: "miniflux-light",
          description: "Read RSS feeds",
        },
        {
          name: "Nextcloud",
          uri: "https://nextcloud.cmdcentral.xyz",
          icon: "nextcloud",
          description: "Web storage access",
          iconBubble: false,
        },
        {
          name: "NVR",
          uri: "https://nvr.cmdcentral.xyz",
          icon: "amcrest",
          description: "View cameras",
        },
        {
          name: "Paperless",
          uri: "https://paperless.cmdcentral.xyz",
          icon: "paperless-ngx",
          description: "Document management",
        },
        {
          name: "Recipes",
          uri: "https://recipes.cmdcentral.xyz",
          icon: "mealie",
        },
        {
          name: "Wallabag",
          uri: "https://wallabag.cmdcentral.xyz",
          icon: "wallabag",
          description: "Webpage saver/reading list",
          iconBubble: false,
        },
      ],
    },
    {
      category: "Bookmarks",
      services: [
        {
          name: "Email",
          uri: "https://app.fastmail.com",
          icon: "fastmail",
          iconBubble: false,
        },
        {
          name: "Library",
          uri: "https://library.cmdcentral.xyz",
          icon: "mdi-library",
          description: "Books n shiet",
        },
        {
          name: "Plex",
          uri: "https://plex.tv/web",
          icon: "plex",
        },
      ],
    },
    {
      category: "Media",
      services: [
        {
          name: "PlexRequests",
          uri: "https://plexrequests.cmdcentral.xyz",
          icon: "overseerr",
          description: "Download *yes*",
          iconBubble: false,
        },
        {
          name: "Lidarr",
          uri: "https://lidarr.cmdcentral.xyz",
          icon: "lidarr",
          description: "Download music",
        },
        {
          name: "Radarr",
          uri: "https://radarr.cmdcentral.xyz",
          icon: "radarr",
          description: "Download movies",
        },
        {
          name: "Readarr",
          uri: "https://readarr.cmdcentral.xyz",
          icon: "readarr",
          description: "Download ebooks",
        },
        {
          name: "Sonarr",
          uri: "https://sonarr.cmdcentral.xyz",
          icon: "sonarr",
          description: "Download TV shows",
        },
        {
          name: "Prowlarr",
          uri: "https://prowlarr.cmdcentral.xyz",
          icon: "prowlarr",
          description: "Indexer manager",
        },
        {
          name: "Sabnzbd",
          uri: "https://sabnzbd.cmdcentral.xyz",
          icon: "sabnzbd",
          description: "Usenet downloads",
        },
        {
          name: "Seedbox",
          uri: "https://psb52743.seedbox.io",
          icon: "rutorrent",
          description: "Torrent downloads",
          iconBubble: false,
        },
        {
          name: "Calibre",
          uri: "https://calibre.cmdcentral.xyz",
          icon: "calibre",
          description: "Ebook collection",
        },
      ],
    },
    {
      category: "Printers",
      services: [
        {
          name: "Spoolman",
          uri: "https://spoolman.cmdcentral.xyz",
          icon: "mdi-library-shelves",
          description: "Filament manager",
        },
        {
          name: "Trident",
          uri: "https://trident.cmdcentral.xyz",
          icon: "mdi-triforce",
          description: "VT350",
        },
        {
          name: "Prusa Mini",
          uri: "https://prusamini.cmdcentral.xyz",
          icon: "fluidd",
        },
        {
          name: "Ender Tres",
          uri: "https://endertres.cmdcentral.xyz",
          icon: "mdi-blender",
          description: "Ender 3",
        },
        {
          name: "Veronica",
          uri: "http://veronica.cmdcentral.xyz",
          icon: "voron",
          description: "V0.2",
          iconBubble: false,
        },
        {
          name: "Voron V2",
          uri: "http://voronv2.cmdcentral.xyz",
          icon: "voron",
          description: "V2.4",
          iconBubble: false,
        },
        {
          name: "Replicator",
          uri: "http://replicator.cmdcentral.xyz:8000",
          icon: "mdi-bolt",
          description: "CNC machine",
        },
      ],
    },
    {
      category: "Homelab",
      services: [
        {
          name: "Alertmanager",
          uri: "https://alertmanager.cmdcentral.xyz",
          icon: "alertmanager",
          iconBubble: false,
        },
        {
          name: "ArgoCD",
          uri: "https://argo.cmdcentral.xyz",
          icon: "argocd",
          description: "Manage K8S apps",
        },
        {
          name: "Authentik",
          uri: "https://login.cmdcentral.xyz",
          icon: "authentik",
          description: "Cmdcentral Login",
        },
        {
          name: "Ceph",
          uri: "https://ceph.cmdcentral.xyz",
          icon: "ceph",
          description: "Ceph storage dashboard",
        },
        {
          name: "DNS Admin",
          uri: "https://dnsadmin.cmdcentral.xyz",
          icon: "powerdns",
        },
        {
          name: "Gateway",
          uri: "https://gateway.cmdcentral.xyz",
          icon: "opnsense",
        },
        {
          name: "Minio",
          uri: "https://minio.cmdcentral.xyz",
          icon: "minio-light",
        },
        {
          name: "Netbox",
          uri: "https://netbox.cmdcentral.xyz",
          icon: "netbox",
        },
        {
          name: "Prometheus",
          uri: "https://prometheus.cmdcentral.xyz",
          icon: "prometheus",
          iconBubble: false,
        },
        {
          name: "Promlens",
          uri: "https://promlens.cmdcentral.xyz",
          icon: "mdi-hololens",
          description: "Prometheus helper",
        },
        {
          name: "Proxmox",
          uri: "https://vmhost.cmdcentral.xyz",
          icon: "proxmox",
          description: "VM hosts",
        },
        {
          name: "Unifi",
          uri: "https://unifi.cmdcentral.xyz",
          icon: "unifi",
          iconBubble: false,
        },
      ],
    },
  ],
  name: `${name}-config`,
  namespace: namespace,
});

app.synth();

NewKustomize(app.outdir);
