import {
  ContainerPort,
  ContainerResources,
  Deployment,
  Ingress,
  IngressBackend,
  Namespaces,
  NetworkPolicy,
  NetworkPolicyIpBlock,
  NetworkPolicyPort,
  NetworkPolicyRule,
  NetworkPolicyTrafficDefault,
  Probe,
  Secret,
  Volume,
} from "cdk8s-plus-28";
import { Construct } from "constructs";
import { Chart } from "cdk8s";
import {
  CLUSTER_ISSUER,
  DEFAULT_SECURITY_CONTEXT,
  IP_CIDRS_V4,
} from "./consts";

const DEFAULT_IMAGE = "rclone/rclone";

export interface RcloneProps {
  readonly name: string;
  readonly namespace: string;
  readonly image?: string;
  readonly resources: ContainerResources;
  readonly backends: RcloneServeBackend[];
  // since there's no auth in front of it, we may want to block ad-hoc ingress
  readonly defaultBlockIngress: boolean;
  readonly configSecretName: string;
}

/**
 * Describes an already configured Rclone backend
 */
export interface RcloneServeBackend {
  readonly name: string;
  readonly port: number;
  readonly serviceName?: string; // if not specified is generated from name
  readonly ingressHost?: string; // if not specified, no ingress is generated

  // these next two only take effect if defaultBlockIngress is set to true
  readonly allowIngressFromNS?: string[];
  readonly allowIngressFromInternal?: boolean;
}

export class Rclone extends Chart {
  constructor(scope: Construct, id: string, props: RcloneProps) {
    super(scope, id);

    const configSecret = Secret.fromSecretName(
      this,
      `${id}-config-secret`,
      props.configSecretName,
    );
    const configVolume = Volume.fromSecret(this, `${id}-config`, configSecret);

    const deploy = new Deployment(this, `${id}-deployment`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: {
          "app.kubernetes.io/name": props.name,
          "app.kubernetes.io/managed-by": "generators",
        },
      },
      replicas: 1,
      podMetadata: {
        labels: {
          "app.kubernetes.io/name": props.name,
        },
      },
      securityContext: DEFAULT_SECURITY_CONTEXT,
      containers: [
        {
          name: props.name,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          image: props.image ?? DEFAULT_IMAGE,
          args: [
            "--config",
            "/config/rclone.conf",
            "--fast-list",
            "serve",
            "s3",
            props.backends[0].name, // TODO this needs to support multiple backends
            "--addr",
            `:${props.backends[0].port}`, // TODO this needs to support multiple backends
          ],
          ports: props.backends.map(
            (backend: RcloneServeBackend): ContainerPort => {
              return { number: backend.port, name: backend.name };
            },
          ),
          resources: props.resources,
          // TODO these could be done better, i'd imagine
          readiness: Probe.fromHttpGet("/", { port: props.backends[0].port }),
          liveness: Probe.fromHttpGet("/", { port: props.backends[0].port }),
          volumeMounts: [
            {
              volume: configVolume,
              path: "/config", // TODO fix
            },
          ],
        },
      ],
    });

    const svcs = [];

    // unconditionally create services from backends
    for (const backend of props.backends) {
      const backendName = this.getBackendName(props, backend);
      const svc = deploy.exposeViaService({
        name: backendName,
        ports: [
          {
            port: backend.port,
            targetPort: backend.port,
          },
        ],
      });

      if (backend.ingressHost) {
        svcs.push({
          host: backend.ingressHost,
          port: backend.port,
          svc: svc,
        });
      }
    }

    if (svcs.length > 0) {
      const ingress = new Ingress(this, `${props.name}-ingress`, {
        metadata: {
          name: props.name,
          namespace: props.namespace,
          annotations: {
            "cert-manager.io/cluster-issuer": CLUSTER_ISSUER.name,
          },
        },
      });

      const hosts: string[] = [];

      for (const svc of svcs) {
        hosts.push(svc.host);
        ingress.addHostRule(
          svc.host,
          "/",
          IngressBackend.fromService(svc.svc, { port: svc.port }),
        );
      }

      ingress.addTls([
        {
          hosts: hosts,
          secret: Secret.fromSecretName(
            this,
            `${props.name}-tls`,
            `${props.name}-tls`,
          ),
        },
      ]);
    }

    if (props.defaultBlockIngress) {
      new NetworkPolicy(this, `${props.name}-netpol-block-ingress`, {
        metadata: {
          name: "default-block-ingress",
          namespace: props.namespace,
        },
        selector: deploy,
        ingress: {
          default: NetworkPolicyTrafficDefault.DENY,
        },
      });

      const peers: NetworkPolicyIpBlock[] = [
        IP_CIDRS_V4.WIRED_LAN,
        IP_CIDRS_V4.WIRELESS_LAN,
        IP_CIDRS_V4.SERVERS_STATIC,
        IP_CIDRS_V4.SERVERS_DHCP,
      ].map((cidr: string, index: number): NetworkPolicyIpBlock => {
        return NetworkPolicyIpBlock.ipv4(
          this,
          `${props.name}-local-peers-${index}`,
          cidr,
        );
      });

      const allowIngressFromInternalPorts: number[] = [];

      for (const backend of props.backends) {
        if (backend.allowIngressFromInternal) {
          allowIngressFromInternalPorts.push(backend.port);
        }

        if (backend.allowIngressFromNS) {
          const nsSelector = Namespaces.select(
            this,
            `${props.name}-${backend.name}-ns`,
            {
              names: backend.allowIngressFromNS,
            },
          );

          new NetworkPolicy(
            this,
            `${this.getBackendName(props, backend)}-ns-allow`,
            {
              metadata: {
                name: `${this.getBackendName(props, backend)}-allow-namespaces`,
                namespace: props.namespace,
              },
              selector: deploy,
              ingress: {
                rules: [
                  {
                    peer: nsSelector,
                    ports: [NetworkPolicyPort.tcp(backend.port)],
                  },
                ],
              },
            },
          );
        }
      }
      new NetworkPolicy(this, `${props.name}-allow-internal`, {
        metadata: {
          name: `${props.name}-allow-internal`,
          namespace: props.namespace,
        },
        selector: deploy,
        ingress: {
          rules: peers.map((peer: NetworkPolicyIpBlock): NetworkPolicyRule => {
            return {
              peer: peer,
              ports: allowIngressFromInternalPorts.map(
                (port: number): NetworkPolicyPort => {
                  return NetworkPolicyPort.tcp(port);
                },
              ),
            };
          }),
        },
      });
    }
  }

  private getBackendName(
    props: RcloneProps,
    backend: RcloneServeBackend,
  ): string {
    return backend.serviceName ?? `${props.name}-gateway-${backend.name}`;
  }
}
