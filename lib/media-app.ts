import { Construct } from "constructs";
import { Chart, Size } from "cdk8s";
import {
  ContainerResources,
  Cpu,
  Deployment,
  DeploymentStrategy,
  EnvValue,
  Ingress,
  IngressBackend,
  ISecret,
  MountOptions,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeMode,
  Probe,
  Secret,
  ServicePort,
  Volume,
} from "cdk8s-plus-26";
import { StorageClass } from "./volume";
import {
  BACKUP_ANNOTATION_NAME,
  DEFAULT_SECURITY_CONTEXT,
  GET_SERVICE_URL,
  LSIO_ENVVALUE,
  PROMETHEUS_RELEASE_LABEL,
} from "./consts";
import { NFSConcreteVolume } from "./nfs";
import { ServiceMonitor } from "../imports/monitoring.coreos.com";

const exportarrVersion = "v1.2.4";
const exportarrPort = 9707;

export interface MediaAppProps {
  readonly name: string;
  readonly namespace: string;
  readonly port: number;
  readonly image: string;
  readonly resources: ContainerResources;
  readonly extraEnv?: { [key: string]: EnvValue };
  readonly nfsMounts?: {
    mountPoint: string;
    nfsConcreteVolume: NFSConcreteVolume;
    mountOptions?: MountOptions;
  }[];
  readonly configVolume?: {
    size?: Size;
    mountPath?: string;
    enableBackups: boolean;
  };
  readonly monitoringConfig?: {
    enableExportarr: boolean;
    existingApiSecretName?: string;
  };
  readonly ingressSecret: ISecret;
}

export class MediaApp extends Chart {
  constructor(scope: Construct, props: MediaAppProps) {
    super(scope, props.name);

    // early setup of PVC so we can get its name for backup config
    const configPVCName = `${props.name}-config`;

    let configVol: Volume | undefined;
    if (props.configVolume) {
      const pvc = new PersistentVolumeClaim(this, configPVCName, {
        metadata: {
          name: configPVCName,
          namespace: props.namespace,
        },
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        storage: props.configVolume.size ?? Size.gibibytes(5),
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
      replicas: 1,
      strategy: DeploymentStrategy.recreate(),
      securityContext: DEFAULT_SECURITY_CONTEXT,
      podMetadata: {
        annotations: props.configVolume?.enableBackups
          ? { [BACKUP_ANNOTATION_NAME]: configVol!.name } // if backups are enabled, then configVol must be defined.
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
          envVariables: {
            ...LSIO_ENVVALUE,
            ...props.extraEnv,
          },
          readiness: Probe.fromTcpSocket({
            port: props.port,
          }),
          liveness: Probe.fromTcpSocket({
            port: props.port,
          }),
        },
      ],
    });

    if (props.configVolume) {
      deploy.addVolume(configVol!);
      deploy.containers[0].mount(
        props.configVolume.mountPath ?? "/config",
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

    const labels = deploy.matchLabels;
    if (props.monitoringConfig?.enableExportarr) {
      const secret = Secret.fromSecretName(
        this,
        props.monitoringConfig?.existingApiSecretName!,
        props.monitoringConfig?.existingApiSecretName!
      );
      deploy.addContainer({
        securityContext: DEFAULT_SECURITY_CONTEXT,
        image: `ghcr.io/onedr0p/exportarr:${exportarrVersion}`,
        name: "exportarr",
        args: [props.name],
        portNumber: 9707,
        envVariables: {
          PORT: EnvValue.fromValue(`${exportarrPort}`),
          URL: EnvValue.fromValue(
            GET_SERVICE_URL(props.name, props.namespace, true, props.port)
          ),
          APIKEY: EnvValue.fromSecretValue({ secret: secret, key: "APIKEY" }),
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

      new ServiceMonitor(this, `${props.name}-servicemonitor`, {
        metadata: {
          name: props.name,
          namespace: props.namespace,
          labels: {
            release: PROMETHEUS_RELEASE_LABEL,
          },
        },
        spec: {
          selector: {
            matchLabels: labels,
          },
          endpoints: [
            {
              port: "metrics",
              path: "/metrics",
            },
          ],
        },
      });
    }

    let portsToExpose: ServicePort[] = [
      { name: "http", targetPort: props.port, port: props.port },
    ];

    if (props.monitoringConfig?.enableExportarr) {
      portsToExpose.push({
        name: "metrics",
        targetPort: exportarrPort,
        port: exportarrPort,
      });
    }

    const svc = deploy.exposeViaService({
      name: props.name,
      ports: portsToExpose,
    });
    for (const key of Object.keys(labels)) {
      // HACK: this sucks, records are awful.
      svc.metadata.addLabel(key, labels[key]);
    }

    const ingress = new Ingress(this, `${props.name}-ingress`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
    });
    ingress.addHostRule(
      `${props.name}.cmdcentral.xyz`,
      "/",
      IngressBackend.fromService(svc, { port: props.port })
    );
    ingress.addTls([
      { hosts: [`${props.name}.cmdcentral.xyz`], secret: props.ingressSecret },
    ]);
  }
}
