import { basename } from "path";
import { App, Size } from "cdk8s";
import { DEFAULT_APP_PROPS, TZ } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { StorageClass } from "../../lib/volume";
import { PersistentVolumeAccessMode, Probe } from "cdk8s-plus-27";
import { NewKustomize } from "../../lib/kustomize";
import { HomeRbac } from "./rbac";
import { HomeConfig, MakeService } from "./config";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

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
        image: "ghcr.io/benphelps/homepage",
        strategy: "digest",
      },
    ],
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: "ghcr.io/benphelps/homepage:latest",
  resources: {
    memory: {
      request: Size.mebibytes(128),
      limit: Size.mebibytes(256),
    },
  },
  ports: [3000],
  volumes: [
    {
      props: {
        storageClassName: StorageClass.CEPHFS,
        storage: Size.gibibytes(1),
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_MANY],
      },
      mountPath: "/app/config",
      enableBackups: true,
      name: "config",
    },
  ],
  livenessProbe: Probe.fromHttpGet("", { port: 3000 }),
  readinessProbe: Probe.fromHttpGet("", { port: 3000 }),
  serviceAccountName: name,
  automountServiceAccount: true,
  extraIngressHosts: ["cmdcentral.xyz"],
});

new HomeRbac(app, `${name}-rbac`, name, namespace);

new HomeConfig(app, `${name}-config`, {
  Bookmarks: [
    {
      Other: [
        {
          LibraryCat: [
            {
              href: "https://library.cmdcentral.xyz",
              abbr: "LI",
            },
          ],
        },
      ],
    },
  ],
  Kubernetes: { mode: "cluster" },
  Services: [
    {
      Media: [
        MakeService(
          "Lidarr",
          "https://lidarr.cmdcentral.xyz",
          "lidarr",
          "Music",
          { type: "lidarr", key: "HOMEPAGE_VAR_LIDARR" },
        ),
        MakeService(
          "Radarr",
          "https://radarr.cmdcentral.xyz",
          "radarr",
          "Movies",
          {
            type: "radarr",
            key: "HOMEPAGE_VAR_RADARR",
          },
        ),
        MakeService(
          "Sonarr",
          "https://sonarr.cmdcentral.xyz",
          "sonarr",
          "TV Shows",
          {
            type: "sonarr",
            key: "HOMEPAGE_VAR_SONARR",
          },
        ),
      ],
      Printers: [
        MakeService(
          "Ender Tres",
          "https://endertres.cmdcentral.xyz",
          "fluidd",
          "Ender 3",
          { type: "moonraker" },
        ),
        MakeService(
          "Replicator",
          "https://replicator.cmdcentral.xyz",
          "fluidd-#F31679",
          "Prusa Mini+",
          {
            type: "moonraker",
          },
        ),
      ],
    },
  ],
  Settings: {},
  Widgets: [
    {
      kubernetes: {
        cluster: {
          show: true,
          cpu: true,
          memory: true,
          showLabel: true,
          label: "cluster",
        },
        nodes: {
          show: true,
          cpu: true,
          memory: true,
          showLabel: true,
        },
      },
    },
    {
      openmeteo: {
        label: "Madison",
        latitude: "43.073929",
        longitude: "-89.385239",
        timezone: TZ,
        units: "imperial",
        cache: 15, // Time in minutes to cache API responses, to stay within limits
      },
    },
  ],
  name: name,
  namespace: namespace,
});

app.synth();

NewKustomize(app.outdir);
