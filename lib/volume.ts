export enum StorageClass {
  LONGHORN = "longhorn",
  CEPH_RBD = "ceph-rbd",
  // Delete-on-release twin of CEPH_RBD; see apps/ceph-csi-operator.
  CEPH_RBD_SCRATCH = "ceph-rbd-scratch",
  CEPHFS = "cephfs",
}
