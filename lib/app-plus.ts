import { ApiObject, Chart, JsonPatch, Size } from "cdk8s";
import {
  ConfigMap,
  ConfigMapVolumeOptions,
  ContainerPort,
  ContainerResources,
  ContainerSecurityContextProps,
  Deployment,
  DeploymentStrategy,
  EnvFrom,
  EnvValue,
  Ingress,
  IngressBackend,
  ISecret,
  MountOptions,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeClaimProps,
  PersistentVolumeMode,
  PodDnsProps,
  PodSecurityContextProps,
  Probe,
  Secret,
  Service,
  ServiceAccount,
  ServicePort,
  ServiceType,
  Volume,
} from "cdk8s-plus-34";
import { Construct } from "constructs";
import { CLUSTER_ISSUER, DEFAULT_SECURITY_CONTEXT } from "./consts";
import { WellKnownLabels } from "./labels";
import { StorageClass } from "./volume";

export interface AppPlusVolume {
  readonly props: PersistentVolumeClaimProps;
  readonly name: string;
  readonly mountPath: string;
  readonly labels?: { [key: string]: string };
}

export interface ConfigMapVolume {
  readonly name: string;
  readonly mountPath: string;
  readonly subPath?: string;
  readonly options?: ConfigMapVolumeOptions;
}

export interface AppPlusExtraVolumeMount {
  readonly volume: Volume;
  readonly mountPath: string;
  readonly options?: MountOptions;
}

export interface AppPlusIngressHost {
  readonly host: string;
  // @default the app's first port
  readonly port?: number;
  // @default "/"
  readonly path?: string;
}

export interface ServiceProps {
  readonly type?: ServiceType;
  annotations?: { [p: string]: string };
}

export interface AppPlusProps {
  readonly name: string;
  readonly namespace: string;
  readonly image: string;
  readonly resources: ContainerResources;
  readonly annotations?: { [p: string]: string };
  readonly labels?: { [p: string]: string };
  readonly replicas?: number;
  readonly ports?: number[] | ContainerPort[];
  readonly volumes?: AppPlusVolume[];
  // volumes owned by something else -- an NFS export shared with another app,
  // or a claim another workload in this namespace already declares. `volumes`
  // creates the PVC; this one only mounts what's already there.
  readonly extraVolumeMounts?: AppPlusExtraVolumeMount[];
  readonly configmapMounts?: ConfigMapVolume[];
  readonly extraEnv?: { [key: string]: EnvValue };
  readonly envFrom?: EnvFrom[];
  readonly disableProbes?: boolean;
  readonly livenessProbe?: Probe;
  readonly readinessProbe?: Probe;
  // for slow-starting apps (e.g. ones that run db migrations on boot), gates the
  // liveness/readiness probes until the container comes up.
  readonly startupProbe?: Probe;
  readonly serviceAccountName?: string;
  readonly automountServiceAccount?: boolean;
  // pull secret for images in a private registry
  readonly dockerRegistryAuth?: ISecret;
  // hostnames served in addition to the default `<name>.cmdcentral.xyz`, all
  // routed to the app's first port at "/".
  readonly extraIngressHosts?: string[];
  // full control over the ingress rules, *replacing* the default host rather
  // than adding to it. For apps served under an unrelated name, or ones
  // fanning hostnames out across several ports.
  readonly ingressHosts?: AppPlusIngressHost[];
  // labels applied to the Ingress only, on top of `labels`. For markers that
  // describe the route rather than the workload, e.g. cmdcentral.xyz/external.
  readonly ingressLabels?: { [p: string]: string };
  // @default `<name>-tls`
  readonly tlsSecretName?: string;
  readonly disableIngress?: boolean;
  readonly limitToAMD64?: boolean;
  readonly command?: string[];
  readonly args?: string[];
  readonly monitoringConfig?: {
    readonly port: number;
  };
  // if true, configures traefik to talk tls to the backend
  readonly backendHTTPS?: boolean;
  readonly service?: ServiceProps;
  readonly dns?: PodDnsProps;
  readonly deploymentStrategy?: DeploymentStrategy;
  readonly enableServiceLinks?: boolean;
  readonly disableService?: boolean;
  // overrides for lib/consts.ts DEFAULT_SECURITY_CONTEXT, e.g. to opt an
  // audited-safe app into runAsNonRoot. Do not use to relax the default.
  readonly securityContext?: PodSecurityContextProps;
  readonly containerSecurityContext?: ContainerSecurityContextProps;
}

export class AppPlus extends Chart {
  public readonly Deployment: Deployment;
  public readonly Service: Service | undefined;
  public readonly Ingress?: Ingress;

  constructor(scope: Construct, id: string, props: AppPlusProps) {
    super(scope, id);

    const volumes: Volume[] = [];
    if (props.volumes) {
      for (const vol of props.volumes) {
        const pvc = new PersistentVolumeClaim(this, `${id}-${vol.mountPath}`, {
          metadata: {
            name: `${vol.name}`,
            namespace: props.namespace,
            labels: { ...props.labels, ...vol.labels },
          },
          accessModes: vol.props.accessModes ?? [PersistentVolumeAccessMode.READ_WRITE_ONCE],
          storage: vol.props.storage ?? Size.gibibytes(5),
          storageClassName: vol.props.storageClassName ?? StorageClass.CEPH_RBD,
          volumeMode: vol.props.volumeMode ?? PersistentVolumeMode.FILE_SYSTEM,
          // pins the claim to an existing PV instead of provisioning a new one
          volume: vol.props.volume,
        });
        const v = Volume.fromPersistentVolumeClaim(this, `${id}-${vol.mountPath}-vol`, pvc);
        volumes.push(v);
      }
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
        ...props.ports.map(
          (port): ContainerPort => (typeof port === "number" ? { number: port } : port),
        ),
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
          [WellKnownLabels.Name]: props.name,
          [WellKnownLabels.ManagedBy]: "generators",
          ...props.labels,
        },
        annotations: props.annotations,
      },
      replicas: props.replicas ?? 1,
      // to avoid multiattach errors, deployments that mount RWO volumes get set to recreate
      strategy: props.volumes?.some((vol) =>
        (vol.props.accessModes ?? [PersistentVolumeAccessMode.READ_WRITE_ONCE]).some(
          (am) => am === PersistentVolumeAccessMode.READ_WRITE_ONCE,
        ),
      )
        ? DeploymentStrategy.recreate()
        : props.deploymentStrategy,
      podMetadata: {
        labels: {
          "app.kubernetes.io/name": props.name,
          ...props.labels,
        },
      },
      securityContext: props.securityContext ?? DEFAULT_SECURITY_CONTEXT,
      serviceAccount: serviceAccount,
      automountServiceAccountToken: props.automountServiceAccount,
      dockerRegistryAuth: props.dockerRegistryAuth,
      enableServiceLinks: props.enableServiceLinks,
      dns: props.dns,
      containers: [
        {
          name: props.name,
          securityContext: props.containerSecurityContext ?? DEFAULT_SECURITY_CONTEXT,
          command: props.command,
          args: props.args,
          image: props.image,
          ports: ports,
          resources: props.resources,
          envFrom: props.envFrom,
          envVariables: props.extraEnv,
          readiness: props.disableProbes
            ? undefined
            : (props.readinessProbe ??
              (ports[0] ? Probe.fromTcpSocket({ port: ports[0].number }) : undefined)),
          liveness: props.disableProbes
            ? undefined
            : (props.livenessProbe ??
              (ports[0] ? Probe.fromTcpSocket({ port: ports[0].number }) : undefined)),
          startup: props.disableProbes ? undefined : props.startupProbe,
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

    for (const extra of props.extraVolumeMounts ?? []) {
      deploy.addVolume(extra.volume);
      deploy.containers[0].mount(extra.mountPath, extra.volume, extra.options);
    }

    if (props.configmapMounts) {
      // A single ConfigMap can be mounted at several paths (e.g. two subPath mounts
      // pulling different keys out of the same map), so create one volume per
      // ConfigMap and mount it repeatedly. Volume options come from the first entry.
      const cmVolumes = new Map<string, Volume>();
      for (const vol of props.configmapMounts) {
        let deployVol = cmVolumes.get(vol.name);
        if (!deployVol) {
          const cm = ConfigMap.fromConfigMapName(this, `${id}-${vol.name}-cm`, vol.name);
          deployVol = Volume.fromConfigMap(this, `${id}-${vol.name}-vol`, cm, vol.options);
          cmVolumes.set(vol.name, deployVol);
          deploy.addVolume(deployVol);
        }
        deploy.containers[0].mount(vol.mountPath, deployVol, {
          subPath: vol.subPath,
        });
      }
    }

    let svc: Service | undefined;
    if (!props.disableService) {
      const svcPorts: ServicePort[] = ports.map(function (
        port: ContainerPort,
        index: number,
      ): ServicePort {
        return {
          targetPort: port.number,
          port: port.number,
          protocol: port.protocol,
          name: port.name ?? (index === 0 ? "http" : `http-${index}`),
        };
      });
      svc = deploy.exposeViaService({
        name: props.name,
        ports: svcPorts,
        serviceType: props.service?.type,
      });
      for (const [key, val] of Object.entries(props.labels ?? {})) {
        svc.metadata.addLabel(key, val);
      }
      for (const [key, val] of Object.entries(props.service?.annotations ?? {})) {
        svc.metadata.addAnnotation(key, val);
      }

      if (props.backendHTTPS) {
        svc.metadata.addAnnotation("traefik.ingress.kubernetes.io/service.serversscheme", "https");
      }
    }

    if (!props.disableIngress) {
      if (!svc) throw new Error("Cannot create Ingress when disableService is true");

      const ingress = new Ingress(this, `${props.name}-ingress`, {
        metadata: {
          name: props.name,
          namespace: props.namespace,
          annotations: {
            "cert-manager.io/cluster-issuer": CLUSTER_ISSUER.name,
          },
          labels: { ...props.labels, ...props.ingressLabels },
        },
      });

      const rules: AppPlusIngressHost[] = props.ingressHosts ?? [
        { host: `${props.name}.cmdcentral.xyz` },
        ...(props.extraIngressHosts ?? []).map((host) => ({ host })),
      ];

      for (const rule of rules) {
        ingress.addHostRule(
          rule.host,
          rule.path ?? "/",
          IngressBackend.fromService(svc, { port: rule.port ?? ports[0]?.number }),
        );
      }

      const tlsSecretName = props.tlsSecretName ?? `${props.name}-tls`;
      ingress.addTls([
        {
          hosts: rules.map((rule) => rule.host),
          secret: Secret.fromSecretName(this, `${props.name}-tls`, tlsSecretName),
        },
      ]);

      this.Ingress = ingress;
    }

    this.Deployment = deploy;
    this.Service = svc;
  }
}
