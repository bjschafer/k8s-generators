import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { join } from "path";
import { basename } from "../../lib/util";
import { ENABLE_SERVERSIDE_APPLY, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { AddCRDs } from "../../lib/util";
import {
  VmPodScrape,
  VmPodScrapeSpecPodMetricsEndpointsTargetPort,
} from "../../imports/operator.victoriametrics.com";

const name = basename(__dirname);
const namespace = "cnpg-system";
const app = new App(DEFAULT_APP_PROPS(name));

// ServerSideApply is not optional here: the vendored Cluster and Pooler CRDs
// are ~460KB and ~650KB, far past the 256KB ceiling on the
// last-applied-configuration annotation that a client-side apply would try to
// write.
NewArgoApp(name, {
  namespace: namespace,
  ...ENABLE_SERVERSIDE_APPLY,
});

/**
 * The CloudNativePG operator and its barman-cloud backup plugin.
 *
 * Deliberately a separate Argo app from `postgres`: this owns cluster-scoped
 * CRDs and lives in cnpg-system, while the databases it manages are namespaced
 * in `postgres` and have their own lifecycle. It is also the more dangerous of
 * the two -- the Cluster CRD vendored here is what every running database is an
 * instance of, so losing it loses them.
 */
class Cnpg extends Chart {
  constructor(scope: Construct, id: string) {
    // No chart-level namespace, deliberately unlike the other vendored-bundle
    // apps. cdk8s stamps it onto every object including cluster-scoped ones,
    // which for CNPG would mean Argo rewriting all ten CRDs -- including
    // `clusters.postgresql.cnpg.io`, the one every live database is an
    // instance of -- purely to add a field the API server ignores. Upstream's
    // bundle already qualifies every namespaced object, so omitting it makes
    // the cutover a true no-op.
    super(scope, id);

    // Three upstream bundles, vendored by `mise run update-crds`:
    //   cnpg                  - operator CRDs, RBAC, webhooks, Deployment
    //   cnpg-barman-cloud     - the backup plugin behind the ObjectStores
    //   cnpg-image-catalogs   - ClusterImageCatalogs (refresh-on-request only,
    //                           see the note in tools/sources.ts)
    // All three land in crds/ and are deployed verbatim; see tools/sources.ts.
    AddCRDs(this, join(__dirname, "crds"));

    // Hand-written -- upstream ships no scrape config. The operator serves
    // metrics on the controller pods directly rather than behind a Service.
    new VmPodScrape(this, "podscrape", {
      metadata: {
        name: name,
        namespace: namespace,
        labels: {
          "app.kubernetes.io/instance": name,
        },
      },
      spec: {
        namespaceSelector: {
          matchNames: [namespace],
        },
        podMetricsEndpoints: [
          {
            targetPort: VmPodScrapeSpecPodMetricsEndpointsTargetPort.fromString("metrics"),
          },
        ],
        selector: {
          matchLabels: { "app.kubernetes.io/name": "cloudnative-pg" },
        },
      },
    });
  }
}

new Cnpg(app, name);

app.synth();

NewKustomize(app.outdir);
