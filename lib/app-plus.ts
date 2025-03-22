import { ApiObject, Chart, JsonPatch, Size } from "cdk8s";
import {
  ConfigMap,
  ConfigMapVolumeOptions,
  ContainerPort,
  ContainerResources,
  Deployment,
  DeploymentStrategy,
  EnvValue,
  Ingress,
  IngressBackend,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeClaimProps,
  PersistentVolumeMode,
  Probe,
  Secret,
  ServiceAccount,
  ServicePort,
  Volume,
} from "cdk8s-plus-31";
import { Construct } from "constructs";
import {
  BACKUP_ANNOTATION_NAME,
  CLUSTER_ISSUER,
  DEFAULT_SECURITY_CONTEXT,
} from "./consts";
import { StorageClass } from "./volume";

export interface AppPlusVolume {
  readonly props: PersistentVolumeClaimProps;
  readonly name: string;
  readonly mountPath: string;
  readonly enableBackups: boolean;
}

export interface ConfigMapVolume {
  readonly name: string;
  readonly mountPath: string;
  readonly subPath?: string;
  readonly options?: ConfigMapVolumeOptions;
}

export interface AppPlusProps {
  readonly name: string;
  readonly namespace: string;
  readonly image: string;
  readonly resources: ContainerResources;
  readonly annotations?: { [p: string]: string };
  readonly replicas?: number;
  readonly ports?: number[];
  readonly volumes?: AppPlusVolume[];
  readonly configmapMounts?: ConfigMapVolume[];
  readonly extraEnv?: { [key: string]: EnvValue };
  readonly livenessProbe?: Probe;
  readonly readinessProbe?: Probe;
  readonly serviceAccountName?: string;
  readonly automountServiceAccount?: boolean;
  readonly extraIngressHosts?: string[];
  readonly limitToAMD64?: boolean;
  readonly args?: string[];
  readonly monitoringConfig?: {
    readonly port: number;
  };
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
            name: `${vol.name}`,
            namespace: props.namespace,
          },
          accessModes: vol.props.accessModes ?? [
            PersistentVolumeAccessMode.READ_WRITE_ONCE,
          ],
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

    const ports: ContainerPort[] = [];
    if (props.ports) {
      ports.push(
        ...props.ports.map(function (port: number): ContainerPort {
          return {
            number: port,
          };
        }),
      );
    }
    if (props.monitoringConfig) {
      ports.push({
        number: props.monitoringConfig.port,
        name: "metrics",
      });
    }

    const deploy = new Deployment(this, `${id}-deployment`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: {
          "app.kubernetes.io/name": props.name,
          "app.kubernetes.io/managed-by": "generators",
        },
        annotations: props.annotations,
      },
      replicas: props.replicas ?? 1,
      // to avoid multiattach errors, deployments that mount RWO volumes get set to recreate
      strategy: props.volumes?.some((vol) =>
        vol.props.accessModes?.some(
          (am) => am == PersistentVolumeAccessMode.READ_WRITE_ONCE,
        ),
      )
        ? DeploymentStrategy.recreate()
        : undefined,
      podMetadata: {
        labels: {
          "app.kubernetes.io/name": props.name,
        },
        annotations: volumeBackupAnnotation,
      },
      securityContext: DEFAULT_SECURITY_CONTEXT,
      serviceAccount: serviceAccount,
      automountServiceAccountToken: props.automountServiceAccount,
      containers: [
        {
          name: props.name,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          args: props.args,
          image: props.image,
          ports: ports,
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

    if (props.configmapMounts) {
      for (const vol of props.configmapMounts) {
        const cm = ConfigMap.fromConfigMapName(
          this,
          `${id}-${vol.name}-cm`,
          vol.name,
        );
        const deployVol = Volume.fromConfigMap(
          this,
          `${id}-${vol.name}-vol`,
          cm,
          vol.options,
        );
        deploy.addVolume(deployVol);
        deploy.containers[0].mount(vol.mountPath, deployVol, {
          subPath: vol.subPath,
        });
      }
    }

    const svcPorts = props.ports?.map(function (
      port: number,
      index: number,
    ): ServicePort {
      return {
        targetPort: port,
        port: port,
        name: index === 0 ? "http" : `http-${index}`,
      };
    });
    if (props.monitoringConfig) {
      svcPorts?.push({
        targetPort: props.monitoringConfig.port,
        port: props.monitoringConfig.port,
        name: "metrics",
      });
    }

    const svc = deploy.exposeViaService({
      name: props.name,
      ports: svcPorts,
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
