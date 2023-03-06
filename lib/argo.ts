import { Application, ApplicationSpecSyncPolicy } from "../imports/argoproj.io";
import { Chart } from "cdk8s";
import { Construct } from "constructs";

export const ARGO_NAMESPACE = "argocd";
export const ARGO_GIT_REPO_URL = "git@github.com:bjschafer/k8s-prod.git";
const ARGO_DESTINATION_SERVER = "https://kubernetes.default.svc";

export interface ArgoAppProps {
  readonly namespace: string;
  readonly labels?: { [name: string]: string };
  readonly destination_server?: string;
  readonly project?: string;
  readonly git_repo_url?: string;
  readonly sync_policy: ApplicationSpecSyncPolicy;
  readonly recurse?: boolean;
}

export class ArgoApp extends Chart {
  constructor(scope: Construct, name: string, props: ArgoAppProps) {
    super(scope, name, {
      namespace: props.namespace,
      labels: {
        "app.kubernetes.io/name": name,
        ...props.labels,
      },
    });

    new Application(this, `${name}-application`, {
      metadata: {
        name: name,
        namespace: ARGO_NAMESPACE,
      },
      spec: {
        destination: {
          namespace: props.namespace,
          server: props.destination_server ?? ARGO_DESTINATION_SERVER,
        },
        project: props.project ?? "default",
        source: {
          directory: {
            recurse: props.recurse,
          },
          path: props.namespace,
          repoUrl: props.git_repo_url ?? ARGO_GIT_REPO_URL,
          targetRevision: "HEAD",
        },
        syncPolicy: props.sync_policy,
      },
    });
  }
}
