import {
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
  Pods,
  Probe,
  Secret,
  Volume,
} from "cdk8s-plus-32";
import { Construct } from "constructs";
import { Chart } from "cdk8s";
import {
  CLUSTER_ISSUER,
  DEFAULT_SECURITY_CONTEXT,
  GET_COMMON_LABELS,
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
    const tlsSecret = Secret.fromSecretName(
      this,
      `${props.name}-tls`,
      `${props.name}-tls`,
    );
    const configVolume = Volume.fromSecret(this, `${id}-config`, configSecret);
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

    for (const backend of props.backends) {
      const baseName = `${props.name}-${backend.name}`;

      const deploy = new Deployment(this, `${id}-${backend.name}-deployment`, {
        metadata: {
          name: baseName,
          namespace: props.namespace,
          labels: GET_COMMON_LABELS(props.name),
        },
        replicas: 1,
        podMetadata: {
          labels: {
            "app.kubernetes.io/name": baseName,
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
              `${backend.name}:`,
              "--addr",
              `:${backend.port}`,
            ],
            ports: [
              {
                name: backend.name.substring(0, 15),
                number: backend.port,
              },
            ],
            resources: props.resources,
            readiness: Probe.fromHttpGet("/", { port: backend.port }),
            liveness: Probe.fromHttpGet("/", { port: backend.port }),
            volumeMounts: [
              {
                volume: configVolume,
                path: "/config",
              },
            ],
          },
        ],
      });

      const svc = deploy.exposeViaService({
        name: this.getBackendName(props, backend),
        ports: [
          {
            port: backend.port,
            targetPort: backend.port,
          },
        ],
      });

      if (backend.ingressHost) {
        const ingress = new Ingress(this, `${baseName}-ingress`, {
          metadata: {
            name: baseName,
            namespace: props.namespace,
            annotations: {
              "cert-manager.io/cluster-issuer": CLUSTER_ISSUER.name,
            },
          },
        });

        ingress.addHostRule(
          backend.ingressHost,
          "/",
          IngressBackend.fromService(svc, { port: backend.port }),
        );
        ingress.addTls([
          {
            hosts: [backend.ingressHost],
            secret: tlsSecret,
          },
        ]);
      }

      if (backend.allowIngressFromInternal) {
        new NetworkPolicy(this, `${baseName}-allow-internal`, {
          metadata: {
            name: `${baseName}-allow-internal`,
            namespace: props.namespace,
          },
          selector: deploy,
          ingress: {
            rules: peers.map(
              (peer: NetworkPolicyIpBlock): NetworkPolicyRule => {
                return {
                  peer: peer,
                  ports: [NetworkPolicyPort.tcp(backend.port)],
                };
              },
            ),
          },
        });
      }

      if (backend.allowIngressFromNS) {
        const nsSelector = Namespaces.select(this, `${baseName}-ns`, {
          names: backend.allowIngressFromNS,
        });

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

      const traefikNS = Namespaces.select(this, `${baseName}-traefik-ns`, {
        names: ["kube-system"],
      });
      const traefikSelector = Pods.select(this, `${baseName}-traefik`, {
        namespaces: traefikNS,
        labels: {
          "app.kubernetes.io/name": "traefik",
        },
      });

      if (backend.ingressHost) {
        new NetworkPolicy(this, `${baseName}-allow-traefik`, {
          metadata: {
            name: `${baseName}-allow-traefik`,
            namespace: props.namespace,
          },
          selector: deploy,
          ingress: {
            rules: [
              {
                peer: traefikSelector,
                ports: [NetworkPolicyPort.tcp(backend.port)],
              },
            ],
          },
        });
      }
    }

    if (props.defaultBlockIngress) {
      new NetworkPolicy(this, `${props.name}-netpol-block-ingress`, {
        metadata: {
          name: "default-block-ingress",
          namespace: props.namespace,
        },
        ingress: {
          default: NetworkPolicyTrafficDefault.DENY,
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
