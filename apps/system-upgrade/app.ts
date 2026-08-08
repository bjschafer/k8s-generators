import { App, Chart, JsonPatch } from "cdk8s";
import { Construct } from "constructs";
import { join } from "path";
import { basename } from "../../lib/util";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, K3S_VERSION } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { AddCRDs } from "../../lib/util";
import { Plan } from "../../imports/upgrade.cattle.io";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

// Moved to lib/consts.ts so the in-cluster kubectl images derive from the same
// line rather than each carrying their own pin (see K3S_VERSION there).
const k3sVersion = K3S_VERSION;
const upgradeImage = "rancher/k3s-upgrade";
const serviceAccountName = "system-upgrade";

// Applied to every plan: without it the upgrade job can't be scheduled onto
// nodes carrying our own critical-workload taint, and those nodes would
// silently never upgrade.
const criticalToleration = {
  key: "cmdcentral.xyz/critical",
  effect: "NoSchedule",
  operator: "Exists",
};

NewArgoApp(namespace, {
  namespace: namespace,
});

class SystemUpgrade extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: namespace });

    // Upstream's controller bundle + the Plan CRD, vendored by
    // `mise run update-crds system-upgrade-controller`.
    const included = AddCRDs(this, join(__dirname, "crds"));

    // Upstream pins the controller to a control-plane node but only tolerates
    // the standard control-plane taints. Ours are tainted k3s-controlplane
    // instead, so out of the box the pod is unschedulable everywhere: the
    // control plane rejects it on the taint and the workers fail the affinity.
    // Patched here rather than in the vendored file, which update-crds rewrites.
    const controller = included
      .flatMap((include) => include.apiObjects)
      .find((obj) => obj.kind === "Deployment" && obj.name === "system-upgrade-controller");
    if (!controller) {
      throw new Error("system-upgrade-controller Deployment not found in vendored manifests");
    }
    controller.addJsonPatch(
      JsonPatch.add("/spec/template/spec/tolerations/-", {
        key: "k3s-controlplane",
        effect: "NoExecute",
        operator: "Exists",
      }),
    );

    // Control plane first. Agents refuse to move ahead of it -- see the
    // prepare step on the agent plan below.
    new Plan(this, "server-plan", {
      metadata: {
        name: "server-plan",
        namespace: namespace,
      },
      spec: {
        concurrency: 1,
        cordon: true,
        nodeSelector: {
          matchExpressions: [
            {
              key: "node-role.kubernetes.io/master",
              operator: "In",
              values: ["true"],
            },
          ],
        },
        serviceAccountName: serviceAccountName,
        tolerations: [
          criticalToleration,
          {
            key: "node-role.kubernetes.io/master",
            effect: "NoSchedule",
            operator: "Exists",
          },
          {
            key: "k3s-controlplane",
            effect: "NoExecute",
            operator: "Exists",
          },
        ],
        upgrade: {
          image: upgradeImage,
        },
        version: k3sVersion,
      },
    });

    new Plan(this, "agent-plan", {
      metadata: {
        name: "agent-plan",
        namespace: namespace,
      },
      spec: {
        concurrency: 1,
        cordon: true,
        nodeSelector: {
          matchExpressions: [
            {
              key: "node-role.kubernetes.io/master",
              operator: "DoesNotExist",
            },
          ],
        },
        // blocks until server-plan has finished, so agents never run a newer
        // k3s than the control plane they talk to.
        prepare: {
          image: upgradeImage,
          args: ["prepare", "server-plan"],
        },
        serviceAccountName: serviceAccountName,
        tolerations: [criticalToleration],
        upgrade: {
          image: upgradeImage,
        },
        version: k3sVersion,
      },
    });
  }
}

new SystemUpgrade(app, namespace);

app.synth();

NewKustomize(app.outdir);
