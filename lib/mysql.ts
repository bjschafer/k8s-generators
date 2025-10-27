import { ApiObject, Chart, JsonPatch, Size } from "cdk8s";
import {
  ContainerResources,
  EnvValue,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  Secret,
  Service,
  StatefulSet,
  Volume,
} from "cdk8s-plus-33";
import { Construct } from "constructs";
import { StorageClass } from "./volume";

export interface MysqlInstanceProps {
  namespace: string;
  instance?: string;
  enableBackups: boolean;
  imageOverride?: string;
  resources: ContainerResources;
  pvcSize: Size;
}

const DEFAULT_IMAGE = "ghcr.io/mariadb/mariadb:11.7.2-noble";

export class MysqlInstance extends Chart {
  constructor(scope: Construct, name: string, props: MysqlInstanceProps) {
    super(scope, name);

    const sts = new StatefulSet(this, `${name}-sts`, {
      metadata: {
        name: name,
        namespace: props.namespace,
      },
      securityContext: {
        ensureNonRoot: false,
      },
      containers: [
        {
          securityContext: {
            ensureNonRoot: false,
            readOnlyRootFilesystem: false,
          },
          image: props.imageOverride ?? DEFAULT_IMAGE,
          ports: [
            {
              name: "mysql",
              number: 3306,
            },
          ],
          resources: props.resources,
        },
      ],
      // defining the service this way lets us give it a sane name
      // otherwise, sts undocumentedly creates a headless service for us
      service: new Service(this, `${name}-svc`, {
        metadata: {
          name: name,
          namespace: props.namespace,
        },
        ports: [
          {
            name: "mysql",
            targetPort: 3306,
            port: 3306,
          },
        ],
      }),
    });

    const secret = Secret.fromSecretName(
      this,
      `${name}-creds`,
      `${name}-creds`,
    );

    sts.addVolumeClaimTemplate({
      name: name,
      storage: props.pvcSize,
      accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      storageClassName: StorageClass.CEPH_RBD,
    });

    const pvc = PersistentVolumeClaim.fromClaimName(this, `${name}-pvc`, name);
    const volume = Volume.fromPersistentVolumeClaim(
      this,
      `${name}-volume`,
      pvc,
      {
        name: name,
      },
    );

    sts.addVolume(volume);

    sts.containers[0].mount("/var/lib/mysql", volume);

    sts.containers[0].env.addVariable(
      "MARIADB_ROOT_PASSWORD",
      EnvValue.fromSecretValue({
        secret: secret,
        key: "MARIADB_ROOT_PASSWORD",
      }),
    );

    const baseObj = ApiObject.of(sts);
    if (props.enableBackups) {
      baseObj.addJsonPatch(
        JsonPatch.add("/spec/template/metadata/annotations", {}),
        JsonPatch.add(
          "/spec/template/metadata/annotations/backup.velero.io~1backup-volumes",
          volume.name,
        ),
      );
    }
  }
}
