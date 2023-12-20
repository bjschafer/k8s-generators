import { basename } from "../../lib/util";
import { App } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { ArgoApp, ArgoAppSource } from "../../lib/argo";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

new ArgoApp(app, namespace, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.PROD,
  recurse: true,
});

app.synth();
