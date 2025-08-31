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
  ResourceFieldPaths,
  Secret,
  ServicePort,
  Volume,
} from "cdk8s-plus-33";
import { StorageClass } from "./volume";
import {
  BACKUP_ANNOTATION_NAME,
  DEFAULT_SECURITY_CONTEXT,
  GET_SERVICE_URL,
  LSIO_ENVVALUE,
} from "./consts";
import { NFSConcreteVolume } from "./nfs";
import { VmServiceScrape } from "../imports/operator.victoriametrics.com";

const exportarrVersion = "v2.3.0";
const exportarrPort = 9707;
const mediaLabel = { "app.kubernetes.io/instance": "media" };

export interface MediaAppProps {
  readonly name: string;
  readonly namespace: string;
  readonly port: number;
  readonly image: string;
  readonly resources: ContainerResources;
  readonly extraHostnames?: string[];
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
    enableServiceMonitor: boolean;
    existingApiSecretName?: string;
  };
  readonly ingressSecret: ISecret;
}

export class MediaApp extends Chart {
  constructor(scope: Construct, props: MediaAppProps) {
    super(scope, props.name);

    // early setup of PVC so we can get its name for backup config
    const configPVCName = `${props.name}`;

    let configVol: Volume | undefined;
    if (props.configVolume) {
      const pvc = new PersistentVolumeClaim(this, configPVCName, {
        metadata: {
          name: configPVCName,
          namespace: props.namespace,
          labels: {
            ...mediaLabel,
          },
        },
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        storage: props.configVolume.size ?? Size.gibibytes(5),
        storageClassName: StorageClass.CEPH_RBD,
        volumeMode: PersistentVolumeMode.FILE_SYSTEM,
      });
      configVol = Volume.fromPersistentVolumeClaim(
        this,
        `${props.name}-vol`,
        pvc,
      );
    }

    const deploy = new Deployment(this, `${props.name}-deployment`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: {
          ...mediaLabel,
        },
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
        configVol!,
      );
    }

    const existingVolumes = new Map<string, Volume>();

    for (const nfsMount of props.nfsMounts ?? []) {
      // we need to handle the edge case where the same volume is mounted at multiple (sub)paths.
      const existingVol = existingVolumes.get(
        nfsMount.nfsConcreteVolume.volume.name,
      );
      let vol: Volume;
      if (!existingVol) {
        vol = Volume.fromPersistentVolumeClaim(
          this,
          nfsMount.nfsConcreteVolume.volume.name,
          nfsMount.nfsConcreteVolume.pvc,
        );
        existingVolumes.set(nfsMount.nfsConcreteVolume.volume.name, vol);
        deploy.addVolume(vol);
      } else {
        vol = existingVol;
      }

      deploy.containers[0].mount(
        nfsMount.mountPoint,
        vol,
        nfsMount.mountOptions,
      );
    }

    const labels = deploy.matchLabels;
    if (props.monitoringConfig?.enableExportarr) {
      let apiKey: { [name: string]: EnvValue } = {};
      if (props.monitoringConfig.existingApiSecretName) {
        const secret = Secret.fromSecretName(
          this,
          props.monitoringConfig!.existingApiSecretName!,
          props.monitoringConfig!.existingApiSecretName!,
        );
        apiKey = {
          APIKEY: EnvValue.fromSecretValue({ secret: secret, key: "APIKEY" }),
        };
      }
      deploy.addContainer({
        securityContext: DEFAULT_SECURITY_CONTEXT,
        image: `ghcr.io/onedr0p/exportarr:${exportarrVersion}`,
        name: "exportarr",
        args: [props.name],
        portNumber: 9707,
        envVariables: {
          GOMAXPROCS: EnvValue.fromResource(ResourceFieldPaths.CPU_LIMIT),
          GOMEMLIMIT: EnvValue.fromResource(ResourceFieldPaths.MEMORY_LIMIT),
          PORT: EnvValue.fromValue(`${exportarrPort}`),
          URL: EnvValue.fromValue(
            GET_SERVICE_URL(props.name, props.namespace, true, props.port),
          ),
          ...apiKey,
        },
        resources: {
          cpu: {
            request: Cpu.millis(100),
            limit: Cpu.millis(400),
          },
          memory: {
            request: Size.mebibytes(128),
            limit: Size.mebibytes(384),
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

    if (props.monitoringConfig?.enableServiceMonitor) {
      new VmServiceScrape(this, `${props.name}-servicescrape`, {
        metadata: {
          name: props.name,
          namespace: props.namespace,
          labels: {
            ...mediaLabel,
          },
        },
        spec: {
          selector: {
            matchLabels: labels,
          },
          endpoints: [
            {
              port: props.monitoringConfig.enableExportarr ? "metrics" : "http",
              path: "/metrics",
            },
          ],
        },
      });
    }

    const portsToExpose: ServicePort[] = [
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
    svc.metadata.addLabel("app.kubernetes.io/instance", "media");
    for (const key of Object.keys(labels)) {
      // HACK: this sucks, records are awful.
      svc.metadata.addLabel(key, labels[key]);
    }

    const ingress = new Ingress(this, `${props.name}-ingress`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: {
          ...mediaLabel,
        },
      },
    });
    ingress.addHostRule(
      `${props.name}.cmdcentral.xyz`,
      "/",
      IngressBackend.fromService(svc, { port: props.port }),
    );
    for (const hostname of props.extraHostnames ?? []) {
      ingress.addHostRule(
        hostname,
        "/",
        IngressBackend.fromService(svc, { port: props.port }),
      );
    }
    ingress.addTls([
      { hosts: [`${props.name}.cmdcentral.xyz`], secret: props.ingressSecret },
    ]);
  }
}
