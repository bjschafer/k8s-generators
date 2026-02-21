import { App } from "cdk8s";
import { NewArgoApp, ArgoAppSource, ENABLE_SERVERSIDE_APPLY } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { NewKustomize } from "../../lib/kustomize";

const name = "ceph-csi-operator";
const namespace = "ceph";
const app = new App(DEFAULT_APP_PROPS(name));

NewArgoApp(name, {
  namespace,
  directoryName: name,
  source: ArgoAppSource.GENERATORS,
  ...ENABLE_SERVERSIDE_APPLY,
});

// 1. The operator manager (controller deployment)
new HelmApp(app, "operator", {
  chart: "ceph-csi-operator",
  repo: "https://ceph.github.io/ceph-csi-operator/",
  version: "0.5.0",
  releaseName: "ceph-csi-operator",
  namespace,
  values: {
    controllerManager: {
      manager: {
        image: {
          repository: "quay.io/cephcsi/ceph-csi-operator",
          tag: "v0.5.0",
        },
      },
    },
  },
});

// 2. Driver CRs: OperatorConfig, CephConnection, ClientProfile, Driver (rbd + cephfs)
new HelmApp(app, "drivers", {
  chart: "ceph-csi-drivers",
  repo: "https://ceph.github.io/ceph-csi-operator/",
  version: "0.5.0",
  releaseName: "ceph-csi-drivers",
  namespace,
  values: {
    cephConnections: [
      {
        name: "ceph",
        monitors: ["10.0.151.2:6789", "10.0.151.5:6789", "10.0.151.4:6789"],
        crushLocationLabels: [],
      },
    ],
    clientProfiles: [
      {
        // Name MUST match the clusterID in StorageClasses and SnapshotClasses
        name: "e708730c-9bbe-4567-a37d-6386f6800180",
        cephConnection: { name: "ceph" },
      },
    ],
    drivers: {
      rbd: { enabled: true, snapshotPolicy: "volumeSnapshot" },
      cephfs: { enabled: true, snapshotPolicy: "volumeSnapshot" },
      nfs: { enabled: false },
    },
  },
});

app.synth();
NewKustomize(app.outdir);
