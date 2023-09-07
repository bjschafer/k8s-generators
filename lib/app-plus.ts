import { ApiObject, Chart, JsonPatch, Size } from "cdk8s";
import { Construct } from "constructs";
import {
  ContainerPort,
  ContainerResources,
  Deployment,
  DeploymentStrategy,
  EnvValue,
  Ingress,
  IngressBackend,
  PersistentVolumeClaim,
  PersistentVolumeClaimProps,
  PersistentVolumeMode,
  Probe,
  Secret,
  ServiceAccount,
  ServicePort,
  Volume,
} from "cdk8s-plus-27";
import { StorageClass } from "./volume";
import {
  BACKUP_ANNOTATION_NAME,
  CLUSTER_ISSUER,
  DEFAULT_SECURITY_CONTEXT,
} from "./consts";

export interface AppPlusVolume {
  readonly props: PersistentVolumeClaimProps;
  readonly name: string;
  readonly mountPath: string;
  readonly enableBackups: boolean;
}

export interface AppPlusProps {
  readonly name: string;
  readonly namespace: string;
  readonly image: string;
  readonly resources: ContainerResources;
  readonly ports?: number[];
  readonly volumes?: AppPlusVolume[];
  readonly extraEnv?: { [key: string]: EnvValue };
  readonly livenessProbe?: Probe;
  readonly readinessProbe?: Probe;
  readonly serviceAccountName?: string;
  readonly automountServiceAccount?: boolean;
  readonly extraIngressHosts?: string[];
  readonly limitToAMD64?: boolean;
}

export class AppPlus extends Chart {
  constructor(scope: Construct, id: string, props: AppPlusProps) {
    super(scope, id);

    // set up PVCs first so we can get its name for backup config
    const volumes: Volume[] = [];
    let volumeBackupAnnotation: { [key: string]: string } = {};
    if (props.volumes) {
      for (const vol of props.volumes) {
        const pvc = new PersistentVolumeClaim(this, `${id}-${vol.mountPath}`, {
          metadata: {
            name: `${id}-${vol.name}`,
            namespace: props.namespace,
          },
          accessModes: vol.props.accessModes,
          storage: vol.props.storage ?? Size.gibibytes(5),
          storageClassName: vol.props.storageClassName ?? StorageClass.CEPH_RBD,
          volumeMode: vol.props.volumeMode ?? PersistentVolumeMode.FILE_SYSTEM,
        });
        volumes.push(
          Volume.fromPersistentVolumeClaim(
            this,
            `${id}-${vol.mountPath}-vol`,
            pvc,
          ),
        );
      }
      // backup annotation is comma-separated volume name
      volumeBackupAnnotation = {
        [BACKUP_ANNOTATION_NAME]: volumes
          .map(function (vol: Volume): string {
            return vol.name;
          })
          .join(","),
      };
    }
    let serviceAccount;
    if (props.serviceAccountName) {
      serviceAccount = ServiceAccount.fromServiceAccountName(
        this,
        `${props.name}-sa`,
        props.serviceAccountName,
      );
    }

    const deploy = new Deployment(this, `${id}-deployment`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      replicas: 1,
      // ceph rbd vols are RWO, so we have to set the deployment to recreate to avoid multiattach issues
      strategy: props.volumes?.some(
        (vol) => vol.props.storageClassName == StorageClass.CEPH_RBD,
      )
        ? DeploymentStrategy.recreate()
        : undefined,
      podMetadata: {
        annotations: volumeBackupAnnotation,
      },
      securityContext: DEFAULT_SECURITY_CONTEXT,
      serviceAccount: serviceAccount,
      automountServiceAccountToken: props.automountServiceAccount,
      containers: [
        {
          name: props.name,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          image: props.image,
          ports: props.ports?.map(function (port: number): ContainerPort {
            return {
              number: port,
            };
          }),
          resources: props.resources,
          envVariables: props.extraEnv,
          readiness:
            props.readinessProbe ??
            Probe.fromTcpSocket({ port: props.ports?.at(0) }),
          liveness:
            props.livenessProbe ??
            Probe.fromTcpSocket({ port: props.ports?.at(0) }),
        },
      ],
    });

    if (props.limitToAMD64) {
      const deployObj = ApiObject.of(deploy);
      deployObj.addJsonPatch(
        JsonPatch.add("/spec/template/spec/nodeSelector", {
          "kubernetes.io/arch": "amd64",
        }),
      );
    }

    for (let i = 0; i < volumes.length; i++) {
      deploy.addVolume(volumes[i]);
      deploy.containers[0].mount(props.volumes![i].mountPath, volumes[i]);
    }

    const svc = deploy.exposeViaService({
      name: props.name,
      ports: props.ports?.map(function (port: number): ServicePort {
        return {
          targetPort: port,
          port: port,
        };
      }),
    });

    const ingress = new Ingress(this, `${props.name}-ingress`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        annotations: {
          "cert-manager.io/cluster-issuer": CLUSTER_ISSUER.name,
        },
      },
    });

    const ingressHosts = [`${props.name}.cmdcentral.xyz`];
    if (props.extraIngressHosts) {
      ingressHosts.push(...props.extraIngressHosts);
    }

    for (const host of ingressHosts) {
      ingress.addHostRule(
        host,
        "/",
        IngressBackend.fromService(svc, { port: props.ports?.at(0) }),
      );
    }
    ingress.addTls([
      {
        hosts: ingressHosts,
        secret: Secret.fromSecretName(
          this,
          `${props.name}-tls`,
          `${props.name}-tls`,
        ),
      },
    ]);
  }
}
