import { App } from "cdk8s";
import { basename } from "path";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { AlliantCollector } from "./collector";

export const namespace = basename(__dirname);
export const name = namespace;

const app = new App(DEFAULT_APP_PROPS(namespace));

// No autoUpdate: both images are stock upstream tooling pinned to a major
// version, and argocd-image-updater rewriting them buys nothing for a CronJob
// that only needs a working python and a working psql.
NewArgoApp(name, {
  namespace: namespace,
});

new AlliantCollector(app, "alliant-collector");

app.synth();
NewKustomize(app.outdir);
