import { Chart, Size } from "cdk8s";
import {
  ContainerResources,
  EnvValue,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  Secret,
  Service,
  StatefulSet,
  Volume,
} from "cdk8s-plus-34";
import { Construct } from "constructs";
import { StorageClass } from "./volume";

export interface MysqlInstanceProps {
  namespace: string;
  instance?: string;
  imageOverride?: string;
  resources: ContainerResources;
  pvcSize: Size;
}

// Split out from the image reference below so Renovate's customManager regex
// can see a bare version to bump -- it matches `const <name> = "<version>"`,
// and a whole `repo:tag` string parses as a version of nothing.
// renovate: datasource=docker depName=ghcr.io/mariadb/mariadb
const mariadbVersion = "11.8.8-noble";
const DEFAULT_IMAGE = `ghcr.io/mariadb/mariadb:${mariadbVersion}`;

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

    const secret = Secret.fromSecretName(this, `${name}-creds`, `${name}-creds`);

    sts.addVolumeClaimTemplate({
      name: name,
      storage: props.pvcSize,
      accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      storageClassName: StorageClass.CEPH_RBD,
    });

    const pvc = PersistentVolumeClaim.fromClaimName(this, `${name}-pvc`, name);
    const volume = Volume.fromPersistentVolumeClaim(this, `${name}-volume`, pvc, {
      name: name,
    });

    sts.addVolume(volume);

    sts.containers[0].mount("/var/lib/mysql", volume);

    // Required so the official MariaDB container runs `mariadb-upgrade` when
    // the image tag moves across major versions (e.g. 11.x -> 12.x). Without
    // this the server starts with stale system tables from the old major.
    sts.containers[0].env.addVariable("MARIADB_AUTO_UPGRADE", EnvValue.fromValue("1"));

    sts.containers[0].env.addVariable(
      "MARIADB_ROOT_PASSWORD",
      EnvValue.fromSecretValue({
        secret: secret,
        key: "MARIADB_ROOT_PASSWORD",
      }),
    );
  }
}
