import { App, Chart } from "cdk8s";
import {
  ARGO_DEFAULT_PROPS,
  ARGO_DESTINATION_SERVER,
  ARGO_NAMESPACE,
  ArgoAppProps,
} from "./argo";
import { Construct } from "constructs";
import { Application } from "../imports/argoproj.io";

export interface HelmAppProps {
  readonly chart: string;
  readonly repoUrl: string;
  readonly targetRevision: string;
}

export function NewHelmApp(
  name: string,
  props: HelmAppProps,
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
