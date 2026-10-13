import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { join } from "path";
import { basename } from "../../lib/util";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { AddCRDs } from "../../lib/util";

const name = basename(__dirname);
// upstream's manifests hardcode kube-system throughout, and the controller
// resolves its own namespace from the pod, so this isn't relocatable.
const namespace = "kube-system";
const app = new App(DEFAULT_APP_PROPS(name));

NewArgoApp(name, {
  namespace: namespace,
});

/**
 * The sealed-secrets controller.
 *
 * Secrets here have otherwise moved to OpenBao + External Secrets. This stays
 * for the SealedSecrets still owned by the legacy k8s-prod repo (argocd-secret
 * among them); removing the controller would leave those undecryptable.
 *
 * The keys it decrypts with live in Secrets the controller creates and rotates
 * itself, labelled sealedsecrets.bitnami.com/sealed-secrets-key. They are not
 * part of the vendored bundle and nothing here manages them; back them up
 * out-of-band.
 */
class SealedSecrets extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: namespace });

    // vendored by `mise run update-crds sealed-secrets`; deployed unmodified.
    AddCRDs(this, join(__dirname, "crds"));
  }
}

new SealedSecrets(app, name);

app.synth();

NewKustomize(app.outdir);
