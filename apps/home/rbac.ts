import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ApiResource,
  ClusterRole,
  Secret,
  ServiceAccount,
} from "cdk8s-plus-27";
import { IngressRoute } from "../../imports/traefik.containo.us";
import { toApiEndpoint } from "../../lib/util";

export class HomeRbac extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const sa = new ServiceAccount(this, `${id}-serviceAccount`, {
      metadata: {
        name: id,
        namespace: id,
      },
    });
    new Secret(this, `${id}-sa-secret`, {
      type: "kubernetes.io/service-account-token",
      metadata: {
        annotations: {
          "kubernetes.io/service-account.name": sa.name,
        },
        name: id,
        namespace: id,
      },
    });

    const role = new ClusterRole(this, `${id}-role`, {
      metadata: {
        name: id,
        namespace: id,
      },
    });
    role.allowRead(
      ApiResource.NAMESPACES,
      ApiResource.PODS,
      ApiResource.NODES,
      ApiResource.INGRESSES,
      toApiEndpoint(IngressRoute.GVK.apiVersion, IngressRoute.GVK.kind),
      toApiEndpoint("metrics.k8s.io", "nodes"),
      toApiEndpoint("metrics.k8s.io", "pods"),
    );
  }
}
