import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { NewArgoApp, ArgoAppSource, ENABLE_SERVERSIDE_APPLY } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { NewKustomize } from "../../lib/kustomize";
import { KubeStorageClass } from "../../imports/k8s";
import {
  VolumeSnapshotClass,
  VolumeSnapshotClassDeletionPolicy,
} from "../../imports/snapshot.storage.k8s.io";

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
        crushLocationLabels: ["kubernetes.io/hostname"],
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

// 3. StorageClasses and VolumeSnapshotClasses
const clusterID = "e708730c-9bbe-4567-a37d-6386f6800180";
const secret = "csi-rbd-secret";

class CephConfig extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new KubeStorageClass(this, "rbd-sc", {
      metadata: {
        name: "ceph-rbd",
        annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
      },
      provisioner: "rbd.csi.ceph.com",
      parameters: {
        clusterID,
        pool: "k8s",
        imageFeatures: "layering",
        "csi.storage.k8s.io/provisioner-secret-name": secret,
        "csi.storage.k8s.io/provisioner-secret-namespace": namespace,
        "csi.storage.k8s.io/controller-expand-secret-name": secret,
        "csi.storage.k8s.io/controller-expand-secret-namespace": namespace,
        "csi.storage.k8s.io/node-stage-secret-name": secret,
        "csi.storage.k8s.io/node-stage-secret-namespace": namespace,
        "csi.storage.k8s.io/fstype": "ext4",
      },
      reclaimPolicy: "Delete",
      allowVolumeExpansion: true,
      mountOptions: ["discard"],
    });

    new KubeStorageClass(this, "cephfs-sc", {
      metadata: { name: "cephfs" },
      provisioner: "cephfs.csi.ceph.com",
      parameters: {
        clusterID,
        fsName: "k8s",
        "csi.storage.k8s.io/provisioner-secret-name": secret,
        "csi.storage.k8s.io/provisioner-secret-namespace": namespace,
        "csi.storage.k8s.io/controller-expand-secret-name": secret,
        "csi.storage.k8s.io/controller-expand-secret-namespace": namespace,
        "csi.storage.k8s.io/node-stage-secret-name": secret,
        "csi.storage.k8s.io/node-stage-secret-namespace": namespace,
      },
      reclaimPolicy: "Delete",
      allowVolumeExpansion: true,
    });

    new VolumeSnapshotClass(this, "rbd-snapshot-class", {
      metadata: {
        name: "ceph-rbd-snapshot",
        labels: { "velero.io/csi-volumesnapshot-class": "true" },
      },
      driver: "rbd.csi.ceph.com",
      parameters: {
        clusterID,
        "csi.storage.k8s.io/snapshotter-secret-name": secret,
        "csi.storage.k8s.io/snapshotter-secret-namespace": namespace,
      },
      deletionPolicy: VolumeSnapshotClassDeletionPolicy.DELETE,
    });

    new VolumeSnapshotClass(this, "cephfs-snapshot-class", {
      metadata: {
        name: "cephfs-snapshot",
        labels: { "velero.io/csi-volumesnapshot-class": "true" },
      },
      driver: "cephfs.csi.ceph.com",
      parameters: {
        clusterID,
        "csi.storage.k8s.io/snapshotter-secret-name": secret,
        "csi.storage.k8s.io/snapshotter-secret-namespace": namespace,
      },
      deletionPolicy: VolumeSnapshotClassDeletionPolicy.DELETE,
    });
  }
}

new CephConfig(app, "config");

app.synth();
NewKustomize(app.outdir);
