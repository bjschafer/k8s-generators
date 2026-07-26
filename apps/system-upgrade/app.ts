import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { join } from "path";
import { basename } from "../../lib/util";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { AddCRDs } from "../../lib/util";
import { Plan } from "../../imports/upgrade.cattle.io";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

// The k3s version every node is upgraded to. Bumping this is what actually
// triggers a rolling cluster upgrade: the controller compares it against each
// node's kubelet version, so it stays inert until the two disagree. Keep it in
// step with the kubectl pin in mise.toml.
const k3sVersion = "v1.36.2+k3s1";
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
    AddCRDs(this, join(__dirname, "crds"));

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
