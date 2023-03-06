import { Chart } from "cdk8s";
import { PersistentVolumeAccessMode } from "cdk8s-plus-25";
import { Construct } from "constructs";
import {
  KubePersistentVolume,
  KubePersistentVolumeClaim,
  Quantity,
} from "../imports/k8s";

export const NFS_SERVER = "10.0.151.3";
const DEFAULT_CAPACITY = Quantity.fromString("50Ti");

export interface NFSVolumeProps {
  readonly namespace: string;
  readonly accessMode?: PersistentVolumeAccessMode;
  readonly capacity?: Quantity;
  readonly nfsHost?: string;
  readonly exportPath: string;
}

export class NFSVolume extends Chart {
  constructor(scope: Construct, name: string, props: NFSVolumeProps) {
    super(scope, name);

    new KubePersistentVolume(this, `${name}-pv`, {
      metadata: {
        name: name,
        labels: {
          "app.kubernetes.io/instance": "media",
        },
      },
      spec: {
        accessModes: [
          props.accessMode ?? PersistentVolumeAccessMode.READ_WRITE_MANY,
        ],
        capacity: {
          storage: props.capacity ?? DEFAULT_CAPACITY,
        },
        nfs: {
          path: props.exportPath,
          server: props.nfsHost ?? NFS_SERVER,
        },
      },
    });

    new KubePersistentVolumeClaim(this, `${name}-pvc`, {
      metadata: {
        name: name,
        namespace: props.namespace,
        labels: {
          "app.kubernetes.io/instance": "media",
        },
      },
      spec: {
        accessModes: [
          props.accessMode ?? PersistentVolumeAccessMode.READ_WRITE_MANY,
        ],
        resources: {
          requests: {
            storage: props.capacity ?? DEFAULT_CAPACITY,
          },
        },
        storageClassName: "",
        volumeName: name,
      },
    });
  }
}
