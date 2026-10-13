import { Construct } from "constructs";
import { App, Chart } from "cdk8s";
import {
  ClusterRole,
  ContainerResources,
  DeploymentStrategy,
  EnvFrom,
  RoleBinding,
  ServiceAccount,
} from "cdk8s-plus-34";
import { AppPlus } from "./app-plus";
import { DNS_POLICY_NONE } from "./consts";
import { ImageUpdaterRegistryAccess } from "./argo";
import { OpenBaoSecret } from "./secrets";

// Every bot pulls from bjschafer's private GHCR org, so they all share one
// pull secret name -- one bao entry per namespace, same shape.
const PULL_SECRET_NAME = "github-registry-cred";

export interface BotProps {
  readonly name: string;
  readonly namespace: string;
  readonly image: string;
  readonly resources: ContainerResources;
  /**
   * Grants the pod's default ServiceAccount the built-in `view` ClusterRole.
   * Only for bots that actually query the cluster.
   *
   * @default false
   */
  readonly allowClusterView?: boolean;
}

/**
 * A headless chat bot: one deployment, no service, no ingress.
 *
 * Bundles the pieces every bot needs and that are each easy to leave out --
 * the GHCR pull secret, the RBAC letting argocd-image-updater read it, and the
 * bot token -- because a bot missing any one of them fails differently and
 * none of the failures point at the missing piece.
 *
 * Expects two bao entries in the bot's namespace: `bot-token` with a
 * `BOT_TOKEN` field, and `github-registry-cred` with the raw GHCR
 * dockerconfigjson in a `dockerconfigjson` field.
 */
export function NewBot(app: App, props: BotProps): void {
  const registryCred = new OpenBaoSecret(app, `${props.name}-registry-cred`, {
    name: PULL_SECRET_NAME,
    namespace: props.namespace,
    keys: ["dockerconfigjson"],
    // The kubelet only accepts a pull secret of this type with the config under
    // this exact key; the bao entry just holds the raw JSON.
    template: {
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": '{{ index . "dockerconfigjson" }}' },
    },
  });

  const botToken = new OpenBaoSecret(app, `${props.name}-bot-token`, {
    name: "bot-token",
    namespace: props.namespace,
    keys: ["BOT_TOKEN"],
  });

  new ImageUpdaterRegistryAccess(app, `${props.name}-updater-access`, {
    namespace: props.namespace,
    pullSecretName: PULL_SECRET_NAME,
  });

  if (props.allowClusterView) {
    new BotClusterView(app, `${props.name}-view`, props);
  }

  new AppPlus(app, `${props.name}-app`, {
    name: props.name,
    namespace: props.namespace,
    image: props.image,
    resources: props.resources,
    envFrom: [new EnvFrom(undefined, undefined, botToken.secret)],
    dockerRegistryAuth: registryCred.secret,
    dns: DNS_POLICY_NONE,
    disableService: true,
    disableIngress: true,
    limitToAMD64: true,
    // the `view` binding is worthless without a token to present with it
    automountServiceAccount: props.allowClusterView,
    // a bot holds a single long-poll session upstream; two replicas briefly
    // overlapping during a rolling update means duplicate replies.
    deploymentStrategy: DeploymentStrategy.recreate(),
  });
}

class BotClusterView extends Chart {
  constructor(scope: Construct, id: string, props: BotProps) {
    super(scope, id, { namespace: props.namespace });

    const binding = new RoleBinding(this, "binding", {
      metadata: {
        name: `${props.name}-view`,
        namespace: props.namespace,
      },
      role: ClusterRole.fromClusterRoleName(this, "view-clusterrole", "view"),
    });
    binding.addSubjects(
      ServiceAccount.fromServiceAccountName(this, "default-sa", "default", {
        namespaceName: props.namespace,
      }),
    );
  }
}
