import { App } from "cdk8s";
import { basename } from "path";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { KlipperExporter } from "./klipper";
import { ProxmoxExporter } from "./proxmox";
import { UnifiExporter } from "./unifi";

export const namespace = basename(__dirname);
export const name = namespace;

const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: "ghcr.io/scross01/prometheus-klipper-exporter",
        strategy: "digest",
      },
      {
        image: "prompve/prometheus-pve-exporter",
        strategy: "digest",
      },
      {
        image: "ghcr.io/unpoller/unpoller",
        strategy: "digest",
      },
    ],
  },
});

new KlipperExporter(app, "klipper");
new ProxmoxExporter(app, "proxmox");
new UnifiExporter(app, "unifi");

app.synth();
NewKustomize(app.outdir);
