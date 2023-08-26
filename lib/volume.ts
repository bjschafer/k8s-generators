import {
  KubePersistentVolume,
  KubePersistentVolumeClaim,
  Quantity,
  Volume,
  VolumeMount,
} from "../imports/k8s";
import { PersistentVolumeAccessMode } from "cdk8s-plus-27";
import { Construct } from "constructs";

export enum StorageClass {
  CEPHFS = "cephfs",
  CEPH_RBD = "ceph-rbd",
}

export interface UnifiedVolume {
  volume: Volume;
  volumeMount: VolumeMount;
}

export interface UnifiedVolumeMount extends UnifiedVolume {
  mountPath: string;
}

export interface PVCProps {
  readonly name: string;
  readonly storageClass: StorageClass;
  readonly size: Quantity;
  readonly accessMode?: PersistentVolumeAccessMode;
  readonly mountPath: string;
}

export interface CustomVolumeProps {
  readonly name: string;
  readonly namespace?: string;
  readonly storageClass: StorageClass;
  readonly size: Quantity;
  readonly accessMode?: PersistentVolumeAccessMode;
  readonly mountPath: string;
  readonly backup: boolean;
}

export class CustomVolume {
  public props: CustomVolumeProps;
  private volumeCount = 0;
  private volumeMountCount = 0;

  constructor(props: CustomVolumeProps) {
    this.props = props;
  }

  public MakePV(scope: Construct): KubePersistentVolume {
    return new KubePersistentVolume(scope, `${this.props.name}-pv`, {
      metadata: {
        name: this.props.name,
      },
      spec: {
        accessModes: [
          this.props.accessMode ?? PersistentVolumeAccessMode.READ_WRITE_ONCE,
        ],
        capacity: {
          storage: this.props.size,
        },
        storageClassName: this.props.storageClass,
      },
    });
  }

  public MakePVC(scope: Construct): KubePersistentVolumeClaim {
    return new KubePersistentVolumeClaim(scope, `${this.props.name}-pvc`, {
      metadata: {
        name: this.props.name,
        namespace: this.props.namespace,
      },
      spec: {
        accessModes: [
          this.props.accessMode ?? PersistentVolumeAccessMode.READ_WRITE_ONCE,
        ],
        resources: {
          requests: {
            storage: this.props.size,
          },
        },
        storageClassName: this.props.storageClass,
      },
    });
  }

  public GetVolume(): Volume {
    this.volumeCount++;

    return {
      name: this.props.name,
      persistentVolumeClaim: {
        claimName: this.props.name,
      },
    };
  }

  public GetVolumeMount(): VolumeMount {
    this.volumeMountCount++;

    return {
      name: this.props.name,
      mountPath: this.props.mountPath,
    };
  }

  public GetUsage(): { [name: string]: number } {
    return {
      volumes: this.volumeCount,
      mounts: this.volumeMountCount,
    };
  }
}
