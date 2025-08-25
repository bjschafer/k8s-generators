import { Chart, Size } from "cdk8s";
import {
  IPersistentVolume,
  k8s,
  PersistentVolume,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeMode,
  PersistentVolumeProps,
  PersistentVolumeReclaimPolicy,
} from "cdk8s-plus-33";
import { Construct } from "constructs";
import { BACKUP_ANNOTATION_EXCLUDE } from "./consts";

export const NFS_SERVER = "10.0.151.5";
const DEFAULT_CAPACITY = Size.tebibytes(50);

export interface NFSConcreteVolume {
  volume: NFSVolume;
  pvc: PersistentVolumeClaim;
}

export class NFSVolumeContainer extends Chart {
  public nfsVols: Map<string, NFSConcreteVolume>;

  constructor(scope: Construct, name: string) {
    super(scope, name);
    this.nfsVols = new Map<
      string,
      { volume: NFSVolume; pvc: PersistentVolumeClaim }
    >();
  }

  public Add(name: string, props: NFSVolumeProps) {
    props = {
      ...props,
      metadata: {
        ...props.metadata,
        name: name,
      },
    };
    const vol = new NFSVolume(this, name, props);
    const pvc = new PersistentVolumeClaim(this, `${name}-pvc`, {
      ...props,
      accessModes: [PersistentVolumeAccessMode.READ_WRITE_MANY],
      storage: vol.storage,
      storageClassName: "",
    });
    pvc.bind(vol);

    this.nfsVols.set(name, { volume: vol, pvc: pvc });
  }

  public Get(name: string): NFSConcreteVolume {
    return this.nfsVols.get(name)!;
  }
}

export interface NFSVolumeProps extends PersistentVolumeProps {
  readonly nfsHost?: string;
  readonly exportPath: string;
  readonly storage?: Size;
}

export class NFSVolume extends PersistentVolume implements IPersistentVolume {
  public readonly nfsHost: string;
  public readonly exportPath: string;
  public readonly storage: Size;

  constructor(scope: Construct, name: string, props: NFSVolumeProps) {
    super(scope, name, props);

    this.nfsHost = props.nfsHost ?? NFS_SERVER;
    this.exportPath = props.exportPath;
    this.storage = props.storage ?? DEFAULT_CAPACITY;
    this.metadata.addLabel(BACKUP_ANNOTATION_EXCLUDE, "true");
  }

  public _toKube(): k8s.PersistentVolumeSpec {
    const spec = super._toKube();
    return {
      ...spec,
      accessModes: [PersistentVolumeAccessMode.READ_WRITE_MANY],
      persistentVolumeReclaimPolicy: PersistentVolumeReclaimPolicy.RETAIN,
      volumeMode: PersistentVolumeMode.FILE_SYSTEM,
      nfs: {
        path: this.exportPath,
        server: this.nfsHost,
      },
    };
  }
}
