import { App } from "cdk8s";
import { NFSVolume } from "../../lib/nfs";
import { ArgoApp } from "../../lib/argo";
import { Quantity } from "../../imports/k8s";
import { MediaApp } from "../../lib/media-app";

const app = new App({ outdir: "dist/media" });

const namespace = "media";

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

new NFSVolume(app, "nfs-media-downloads", {
  namespace: namespace,
  exportPath: "/warp/Media/Downloads",
});

new NFSVolume(app, "nfs-media-music", {
  namespace: namespace,
  exportPath: "/warp/Media/Music",
});

new NFSVolume(app, "nfs-media-videos-movies", {
  namespace: namespace,
  exportPath: "/warp/Media/Videos/Movies",
});

new NFSVolume(app, "nfs-media-videos-tvshows", {
  namespace: namespace,
  exportPath: "/warp/Media/Videos/TVShows",
});

new MediaApp(app, {
  name: "sonarr",
  namespace: namespace,
  port: {
    name: "http",
    containerPort: 8989,
    protocol: "TCP",
  },
  useExternalDNS: false,
  enableProbes: true,
  image: "ghcr.io/linuxserver/sonarr:develop",
  resources: {
    requests: {
      cpu: Quantity.fromString("250m"),
      memory: Quantity.fromString("256Mi"),
    },
  },
  nfsMounts: [
    {
      mountPath: "/downloads",
      vol: "downloads",
    },
    {
      mountPath: "/tv",
      vol: "videos-tvshows",
    },
  ],
  configVolumeSize: Quantity.fromString("5Gi"),
  configEnableBackups: true,
});

app.synth();
