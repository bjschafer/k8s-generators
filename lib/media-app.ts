import { Construct } from "constructs";
import { Chart, Size } from "cdk8s";
import {
  ContainerResources,
  Cpu,
  Deployment,
  EnvValue,
  Ingress,
  IngressBackend,
  ISecret,
  MountOptions,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeMode,
  Probe,
  Volume,
} from "cdk8s-plus-26";
import { StorageClass } from "./volume";
import {
  BACKUP_ANNOTATION_NAME,
  DEFAULT_SECURITY_CONTEXT,
  GET_SERVICE_URL,
  LSIO_ENVVALUE,
} from "./consts";
import { NFSConcreteVolume } from "./nfs";

const exportarrVersion = "v1.2.4";

export interface MediaAppProps {
  readonly name: string;
  readonly namespace: string;
  readonly port: number;
  readonly useExternalDNS: boolean;
  readonly enableProbes: boolean;
  readonly image: string;
  readonly resources: ContainerResources;
  readonly nfsMounts?: {
    mountPoint: string;
    nfsConcreteVolume: NFSConcreteVolume;
    mountOptions?: MountOptions;
  }[];
  readonly configMountPath?: string;
  readonly configVolumeSize?: Size;
  readonly configEnableBackups: boolean;
  readonly enableExportarr: boolean;
  readonly ingressSecret: ISecret;
}

export class MediaApp extends Chart {
  private readonly configPVCName: string;
  private readonly hasConfigPVC: boolean;

  constructor(scope: Construct, props: MediaAppProps) {
    super(scope, props.name);

    // early setup of PVC so we can get its name for backup config
    this.configPVCName = `${props.name}-config`;
    this.hasConfigPVC =
      props.configMountPath !== undefined ||
      props.configVolumeSize !== undefined;

    if (!this.hasConfigPVC && props.configEnableBackups) {
      throw new Error(
        `Requested to configure backups for ${props.name} but no config volume was specified.`
      );
    }

    let configVol: Volume | undefined;
    if (this.hasConfigPVC) {
      const pvc = new PersistentVolumeClaim(this, this.configPVCName, {
        metadata: {
          name: this.configPVCName,
        },
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        storage: props.configVolumeSize ?? Size.gibibytes(5),
        storageClassName: StorageClass.CEPH_RBD,
        volumeMode: PersistentVolumeMode.FILE_SYSTEM,
      });
      configVol = Volume.fromPersistentVolumeClaim(
        this,
        `${props.name}-vol`,
        pvc
      );
    }

    const deploy = new Deployment(this, `${props.name}-deployment`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      securityContext: DEFAULT_SECURITY_CONTEXT,
      podMetadata: {
        annotations: props.configEnableBackups
          ? { [BACKUP_ANNOTATION_NAME]: configVol!.name }
          : {},
      },
      containers: [
        {
          name: props.name,
          securityContext: {
            ensureNonRoot: false,
            readOnlyRootFilesystem: false,
          },
          image: props.image,
          ports: [
            {
              name: "http",
              number: props.port,
            },
          ],
          resources: props.resources,
          envVariables: LSIO_ENVVALUE,
          readiness: Probe.fromHttpGet("/", {
            port: props.port,
          }),
          liveness: Probe.fromHttpGet("/", {
            port: props.port,
          }),
        },
      ],
    });

    if (this.hasConfigPVC) {
      deploy.addVolume(configVol!);
      deploy.containers[0].mount(
        props.configMountPath ?? "/config",
        configVol!
      );
    }

    let existingVolumes = new Map<string, Volume>();

    for (const nfsMount of props.nfsMounts ?? []) {
      // we need to handle the edge case where the same volume is mounted at multiple (sub)paths.
      const existingVol = existingVolumes.get(
        nfsMount.nfsConcreteVolume.volume.name
      );
      let vol: Volume;
      if (!existingVol) {
        vol = Volume.fromPersistentVolumeClaim(
          this,
          nfsMount.nfsConcreteVolume.volume.name,
          nfsMount.nfsConcreteVolume.pvc
        );
        existingVolumes.set(nfsMount.nfsConcreteVolume.volume.name, vol);
        deploy.addVolume(vol);
      } else {
        vol = existingVol;
      }

      deploy.containers[0].mount(
        nfsMount.mountPoint,
        vol,
        nfsMount.mountOptions
      );
    }

    if (props.enableExportarr) {
      deploy.addContainer({
        securityContext: DEFAULT_SECURITY_CONTEXT,
        image: `ghcr.io/onedr0p/exportarr:${exportarrVersion}`,
        name: "exportarr",
        args: [props.name],
        portNumber: 9707,
        envVariables: {
          PORT: EnvValue.fromValue("9707"),
          URL: EnvValue.fromValue(
            GET_SERVICE_URL(props.name, props.namespace, true, props.port)
          ),
        },
        resources: {
          cpu: {
            request: Cpu.millis(100),
            limit: Cpu.millis(500),
          },
          memory: {
            request: Size.mebibytes(64),
            limit: Size.mebibytes(256),
          },
        },
        readiness: Probe.fromHttpGet("/healthz", {
          port: 9707,
        }),
        liveness: Probe.fromHttpGet("/healthz", {
          port: 9707,
        }),
      });
    }

    const svc = deploy.exposeViaService({
      name: props.name,
      ports: [
        {
          name: "http",
          targetPort: props.port,
          port: props.port,
        },
      ],
    });

    // new KubeDeployment(this, `${props.name}-deployment`, {
    //   metadata: {
    //     labels: GET_COMMON_LABELS(props.name),
    //     name: props.name,
    //     namespace: props.namespace,
    //   },
    //   spec: {
    //     replicas: 1,
    //     selector: {
    //       matchLabels: GET_COMMON_LABELS(props.name),
    //     },
    //     strategy: {
    //       type: "Recreate",
    //     },
    //     template: {
    //       metadata: {
    //         labels: GET_COMMON_LABELS(props.name),
    //         annotations: props.configEnableBackups
    //           ? { [BACKUP_ANNOTATION_NAME]: `${props.name}-config` }
    //           : {},
    //       },
    //       spec: {
    //         containers: [
    //           {
    //             name: props.name,
    //             env: LSIO_ENV,
    //             image: props.image,
    //             imagePullPolicy: ImagePullPolicy.ALWAYS,
    //             ports: [
    //               {
    //                 name: "http",
    //                 protocol: "TCP",
    //                 containerPort: props.port,
    //               },
    //             ],
    //             // resources: props.resources,
    //             volumeMounts: [
    //               ...this.getConfigVolumeMount(
    //                 props.configMountPath ?? "/config"
    //               ),
    //               ...props.nfsMounts.map<VolumeMount>(function (
    //                 vol
    //               ): VolumeMount {
    //                 return vol.volumeMount;
    //               }),
    //             ],
    //
    //             livenessProbe: props.enableProbes
    //               ? this.getProbe(props.port)
    //               : undefined,
    //             readinessProbe: props.enableProbes
    //               ? this.getProbe(props.port)
    //               : undefined,
    //             startupProbe: props.enableProbes
    //               ? this.getProbe(props.port)
    //               : undefined,
    //           },
    //           {
    //             name: "exportarr",
    //             image: `ghcr.io/onedr0p/exportarr:${exportarrVersion}`,
    //           },
    //         ],
    //         dnsConfig: props.useExternalDNS
    //           ? {
    //               nameservers: DNS_NAMESERVERS,
    //               searches: DNS_SEARCH,
    //             }
    //           : undefined,
    //         volumes: [
    //           ...this.getConfigVolume(),
    //           ...props.nfsMounts.map<Volume>(function (vol): Volume {
    //             return vol.volume;
    //           }),
    //         ],
    //       },
    //     },
    //   },
    // });

    const ingress = new Ingress(this, `${props.name}-ingress`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
    });
    ingress.addHostRule(
      `${props.name}.cmdcentral.xyz`,
      "/",
      IngressBackend.fromService(svc)
    );
    ingress.addTls([
      { hosts: [`${props.name}.cmdcentral.xyz`], secret: props.ingressSecret },
    ]);
    ingress.metadata.addAnnotation(
      "cert-manager.io/cluster-issuer",
      "letsencrypt"
    );
  }

  // private getProbe(port: number): Probe {
  //   return {
  //     failureThreshold: 3,
  //     initialDelaySeconds: 30,
  //     periodSeconds: 10,
  //     tcpSocket: {
  //       port: IntOrString.fromNumber(port),
  //     },
  //     timeoutSeconds: 1,
  //   };
  // }
  //
  // private getConfigVolumeMount(mountPath: string): VolumeMount[] {
  //   if (this.hasConfigPVC) {
  //     return [
  //       {
  //         name: "config",
  //         mountPath: mountPath,
  //       },
  //     ];
  //   }
  //   return [];
  // }
  //
  // private getConfigVolume(): Volume[] {
  //   if (this.hasConfigPVC) {
  //     return [
  //       {
  //         name: "config",
  //         persistentVolumeClaim: {
  //           claimName: this.configPVCName,
  //         },
  //       },
  //     ];
  //   }
  //   return [];
  // }
}
