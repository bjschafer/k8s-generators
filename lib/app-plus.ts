import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ContainerPort,
  Deployment,
  PersistentVolumeClaimProps,
  ServicePort,
} from "cdk8s-plus-25";

export interface AppPlusVolume {
  props: PersistentVolumeClaimProps;
  mountPath: string;
}

export interface AppPlusProps {
  name: string;
  namespace: string;
  image: string;
  ports?: number[];
  volumes?: AppPlusVolume[];
}

export class AppPlus extends Chart {
  constructor(scope: Construct, id: string, props: AppPlusProps) {
    super(scope, id);

    const app = new Deployment(this, `${id}-deployment`, {
      replicas: 1,
      containers: [
        {
          image: props.image,
          ports: props.ports?.map(function (port: number): ContainerPort {
            return {
              number: port,
            };
          }),
        },
      ],
    });

    app.exposeViaService({
      ports: props.ports?.map(function (port: number): ServicePort {
        return {
          port: port,
        };
      }),
    });
  }
}
