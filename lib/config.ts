import { Chart } from "cdk8s";
import { ConfigMap } from "cdk8s-plus-32";
import { Construct } from "constructs";

export interface DataConfigMapProps {
  name: string;
  namespace: string;
  data: Record<string, string>;
}

export class DataConfigMap extends Chart {
  constructor(scope: Construct, id: string, props: DataConfigMapProps) {
    super(scope, id);

    new ConfigMap(this, "cm", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      data: props.data,
    });
  }
}
