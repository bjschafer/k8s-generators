import { App, Chart, Helm, HelmProps } from "cdk8s";
import {
  ARGO_DEFAULT_PROPS,
  ARGO_DESTINATION_SERVER,
  ARGO_NAMESPACE,
  ArgoAppProps,
} from "./argo";
import { Construct } from "constructs";
import { Application } from "../imports/argoproj.io";

export interface ArgoHelmAppProps {
  readonly chart: string;
  readonly repoUrl: string;
  readonly targetRevision: string;
}

export function NewArgoHelmApp(
  name: string,
  props: ArgoHelmAppProps,
  argoProps: ArgoAppProps,
  values: any,
): void {
  const app = new App(ARGO_DEFAULT_PROPS);

  class helmChart extends Chart {
    constructor(scope: Construct, id: string) {
      super(scope, id);

      new Application(this, "app", {
        metadata: {
          namespace: ARGO_NAMESPACE,
          name: name,
        },
        spec: {
          destination: {
            namespace: argoProps.namespace,
            server: argoProps.destination_server ?? ARGO_DESTINATION_SERVER,
          },
          project: argoProps.project ?? "default",
          source: {
            helm: {
              releaseName: name,
              valuesObject: values,
            },
            ...props,
          },
          syncPolicy: {
            syncOptions: ["CreateNamespace=true"],
            ...argoProps.sync_policy,
          },
        },
      });
    }
  }

  new helmChart(app, name);
  app.synth();
}

interface values {
  [key: string]: any;
}

export interface HelmAppProps<T extends values>
  extends Omit<HelmProps, "values"> {
  readonly chart: string;
  readonly repo: string;
  readonly targetRevision: string;
  readonly values: T;
}

export class HelmApp<T extends values> extends Chart {
  constructor(scope: Construct, id: string, props: HelmAppProps<T>) {
    super(scope, id);

    new Helm(this, `${id}-chart`, props);
  }
}
