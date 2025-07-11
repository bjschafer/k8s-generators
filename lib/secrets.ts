import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ExternalSecret,
  ExternalSecretSpecData,
  ExternalSecretSpecSecretStoreRefKind,
} from "../imports/external-secrets.io";
import { EnvValue, ISecret, Secret } from "cdk8s-plus-32";

export interface BitwardenSecretProps {
  name: string;
  namespace: string;
  /**
   * Format is `{ desired secret key: uuid or name of secret in sm}`
   */
  data: Record<string, string>;
}

export class BitwardenSecret extends Chart {
  public readonly secretName: string;
  public readonly secret: ISecret;
  private readonly data: Record<string, string>;

  constructor(scope: Construct, id: string, props: BitwardenSecretProps) {
    super(scope, id);
    this.secretName = props.name;
    this.secret = Secret.fromSecretName(this, `${id}-isecret`, props.name);
    this.data = props.data;

    new ExternalSecret(this, "secret", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      spec: {
        secretStoreRef: {
          kind: ExternalSecretSpecSecretStoreRefKind.CLUSTER_SECRET_STORE,
          name: "bitwarden",
        },
        data: Object.entries(props.data).map(
          (value: [string, string]): ExternalSecretSpecData => {
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

  public toEnvValues(): { [key: string]: EnvValue } {
    const ret: Record<string, EnvValue> = {};
    for (const [name] of Object.entries(this.data)) {
      ret[name] = EnvValue.fromSecretValue({
        secret: this.secret,
        key: name,
      });
    }
    return ret;
  }
}
