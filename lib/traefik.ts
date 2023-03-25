import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  IngressRoute,
  IngressRouteSpecRoutesKind,
  IngressRouteSpecRoutesServicesKind,
  IngressRouteSpecRoutesServicesPort,
} from "../imports/traefik.containo.us";
import { IntOrString } from "../imports/k8s";
import { Certificate } from "../imports/cert-manager.io";
import { CLUSTER_ISSUER } from "./consts";

export interface AuthentikIngressRouteProps {
  namespace: string;
  hostname: string;
  upstreamService: {
    name: string;
    port: IntOrString;
  };
  tlsSecretName: string;
}

export class AuthentikIngressRoute extends Chart {
  constructor(
    scope: Construct,
    name: string,
    props: AuthentikIngressRouteProps
  ) {
    super(scope, `${name}-authentik-ingressroute`);

    new Certificate(this, `${name}-certificate`, {
      metadata: {
        name: name,
        namespace: props.namespace,
      },
      spec: {
        dnsNames: [props.hostname],
        issuerRef: CLUSTER_ISSUER,
        secretName: props.tlsSecretName,
      },
    });

    new IngressRoute(this, `${name}-ingressroute`, {
      metadata: {
        name: name,
        namespace: props.namespace,
      },
      spec: {
        routes: [
          {
            kind: IngressRouteSpecRoutesKind.RULE,
            match: `Host(\`${props.hostname}\`)`,
            middlewares: [
              {
                name: "authentik",
                namespace: "authentik",
              },
            ],
            priority: 10,
            services: [
              {
                name: props.upstreamService.name,
                kind: IngressRouteSpecRoutesServicesKind.SERVICE,
                port: props.upstreamService.port,
              },
            ],
          },
          {
            kind: IngressRouteSpecRoutesKind.RULE,
            match: `Host(\`${props.hostname}\`) && PathPrefix(\`/outpost.goauthentik.io/\`)`,
            priority: 15,
            services: [
              {
                kind: IngressRouteSpecRoutesServicesKind.SERVICE,
                name: "ak-outpost-authentik-embedded-outpost",
                port: IngressRouteSpecRoutesServicesPort.fromNumber(9000),
              },
            ],
          },
        ],
        tls: {
          secretName: props.tlsSecretName,
        },
      },
    });
  }
}
