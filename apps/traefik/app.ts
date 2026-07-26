import { App, Chart, Include } from "cdk8s";
import { Construct } from "constructs";
import { join } from "path";
import { basename } from "../../lib/util";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";

const name = basename(__dirname);
// k3s ships traefik as a bundled addon and its helm-controller only looks for
// a HelmChartConfig named after the chart, in the namespace the chart is
// deployed to. Neither the name nor the namespace is ours to choose.
const namespace = "kube-system";
const app = new App(DEFAULT_APP_PROPS(name));

NewArgoApp(name, {
  namespace: namespace,
});

/**
 * Configuration overrides for the traefik that k3s installs itself.
 *
 * This app deploys no traefik. k3s renders the chart from its own packaged
 * HelmChart resource; a HelmChartConfig is the only supported way to feed
 * values into it, and helm-controller re-runs the release whenever the values
 * change. So the single object here is the entire ingress configuration for
 * the cluster, and editing it redeploys traefik.
 *
 * It lived in the prod repo but no Argo app ever pointed at that directory, so
 * for the last three years it was only whatever someone last ran `kubectl
 * apply` on -- the live object still carried a last-applied-configuration
 * annotation to prove it. Bringing it under GitOps is the point of this app.
 */
class Traefik extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Included verbatim rather than rebuilt from a values object on purpose.
    // helm-controller keys off `valuesContent`, which is one opaque YAML
    // string; re-serializing it from TypeScript would almost certainly emit a
    // different-but-equivalent string, and that alone is enough to trigger a
    // helm upgrade of the ingress every pod in the cluster sits behind.
    // Verified byte-identical to the live object before it was vendored.
    new Include(this, "helmchartconfig", {
      url: join(__dirname, "manifests", "HelmChartConfig.traefik.yaml"),
    });
  }
}

new Traefik(app, name);

app.synth();

NewKustomize(app.outdir);
