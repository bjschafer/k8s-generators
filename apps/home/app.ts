import { basename } from "path";
import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { EnvValue, Probe } from "cdk8s-plus-27";
import { NewKustomize } from "../../lib/kustomize";
import { HomeConfig } from "./config";
import { hashString } from "../../lib/util";

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

const conf = new HomeConfig(app, `${name}-config`, {
  links: [
    {
      category: "Bookmarks",
      services: [
        {
          name: "LibraryCat",
          uri: "https://library.cmdcentral.xyz",
          icon: "mdi-library",
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
          name: "Plex Requests/Overseerr",
          uri: "https://plexrequests.cmdcentral.xyz",
          icon: "overseerr",
          description: "Download yes",
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
        },
      ],
    },
    {
      category: "Printers",
      services: [
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
        },
      ],
    },
  ],
  name: `${name}-config`,
  namespace: namespace,
});

const configHash = hashString(conf.toJson().join());

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: image,
  annotations: {
    "config-hash": configHash,
  },
  resources: {
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(256),
    },
  },
  ports: [port],
  livenessProbe: Probe.fromHttpGet("", { port: port }),
  readinessProbe: Probe.fromHttpGet("", { port: port }),
  extraIngressHosts: ["cmdcentral.xyz"],
  extraEnv: {
    TITLE: EnvValue.fromValue("Cmdcentral Home"), // defaults to "My Website", set to TITLE= to hide the title
    // LOGO=/starbase80.jpg # defaults to /logo.png, set to LOGO= to hide the logo
    // HEADER=true # defaults to true, set to false to hide the title and logo
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

app.synth();

NewKustomize(app.outdir);
