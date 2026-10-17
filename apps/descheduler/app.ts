import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { KubePriorityClass } from "../../imports/k8s";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, HOMELAB_CRITICAL_PRIORITY_CLASS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { NewKustomize } from "../../lib/kustomize";
import { basename } from "../../lib/util";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
// renovate: datasource=helm depName=descheduler registryUrl=https://kubernetes-sigs.github.io/descheduler/
const version = "0.37.0";

NewArgoApp(name, {
  namespace: namespace,
});

class PriorityClasses extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // cdk8s-plus has no PriorityClass construct.
    new KubePriorityClass(this, "homelab-critical", {
      metadata: { name: HOMELAB_CRITICAL_PRIORITY_CLASS },
      // Well above the default of 0, well below the system-* classes (2e9).
      value: 1_000_000,
      description: "Shared infrastructure whose outage takes other apps down with it.",
    });
  }
}

new PriorityClasses(app, "priority-classes");

// Nothing moves pods back after a node drains -- kured reboots or a node
// failure leave the survivors packed and the returning node idle. This runs
// once a night and only rebalances; it does not chase restarts or affinity
// violations.
new HelmApp(app, "helm", {
  chart: "descheduler",
  repo: "https://kubernetes-sigs.github.io/descheduler/",
  version: version,
  releaseName: name,
  namespace: namespace,
  values: {
    fullnameOverride: name,
    kind: "CronJob",
    schedule: "0 3 * * *",
    timeZone: "America/Chicago",
    resources: {
      requests: { cpu: "50m", memory: "128Mi" },
      limits: { memory: "256Mi" },
    },
    deschedulerPolicy: {
      // The control plane is tainted NoExecute, so it can never receive an
      // evicted app pod; counting it would read as permanently underutilized.
      nodeSelector: "!node-role.kubernetes.io/control-plane",
      // A freshly rebooted node can absorb a lot; move a handful a night
      // rather than reshuffling the cluster in one go.
      maxNoOfPodsToEvictPerNode: 5,
      maxNoOfPodsToEvictTotal: 15,
      profiles: [
        {
          name: "rebalance",
          pluginConfig: [
            {
              name: "DefaultEvictor",
              args: {
                // Only evict a pod if it fits somewhere else.
                nodeFit: true,
                priorityThreshold: { name: HOMELAB_CRITICAL_PRIORITY_CLASS },
                podProtections: {
                  defaultDisabled: ["PodsWithLocalStorage"],
                  // Most PVC-backed apps are single-replica Recreate on RWO
                  // volumes, where an eviction is a full outage plus a
                  // volume reattach. Leave them where they are.
                  extraEnabled: ["PodsWithPVC"],
                },
              },
            },
            { name: "RemoveDuplicates" },
            {
              name: "LowNodeUtilization",
              // Percent of allocatable, by *requests*. Workers sit at ~60-70%
              // CPU requested in steady state, so only a nearly empty node --
              // one just back from a reboot -- reads as underutilized.
              args: {
                thresholds: { cpu: 20, memory: 15, pods: 15 },
                targetThresholds: { cpu: 60, memory: 40, pods: 40 },
              },
            },
          ],
          plugins: {
            balance: { enabled: ["RemoveDuplicates", "LowNodeUtilization"] },
          },
        },
      ],
    },
  },
});

app.synth();

NewKustomize(app.outdir);
