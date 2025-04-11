import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ExternalSecretV1Beta1,
  ExternalSecretV1Beta1SpecData,
  ExternalSecretV1Beta1SpecSecretStoreRefKind,
} from "../imports/external-secrets.io";

export interface BitwardenSecretProps {
  name: string;
  namespace: string;
  /**
   * Format is `{ desired secret key: uuid or name of secret in sm}`
   */
  data: Record<string, string>;
}

export class BitwardenSecret extends Chart {
  constructor(scope: Construct, id: string, props: BitwardenSecretProps) {
    super(scope, id);

    new ExternalSecretV1Beta1(this, "secret", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      spec: {
        secretStoreRef: {
          kind: ExternalSecretV1Beta1SpecSecretStoreRefKind.CLUSTER_SECRET_STORE,
          name: "bitwarden",
        },
        data: Object.entries(props.data).map(
          (value: [string, string]): ExternalSecretV1Beta1SpecData => {
            return {
              secretKey: value[0],
              remoteRef: {
                key: value[1],
              },
            };
          },
        ),
        target: {
          name: props.name,
        },
      },
    });
  }
}
