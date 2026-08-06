import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ExternalSecret,
  ExternalSecretSpecData,
  ExternalSecretSpecDataFrom,
  ExternalSecretSpecDataFromSourceRefGeneratorRefKind,
  ExternalSecretSpecDataRemoteRefConversionStrategy,
  ExternalSecretSpecDataRemoteRefDecodingStrategy,
  ExternalSecretSpecDataRemoteRefMetadataPolicy,
  ExternalSecretSpecSecretStoreRefKind,
  ExternalSecretSpecTargetTemplate,
} from "../imports/external-secrets.io";
import { Password } from "../imports/generators.external-secrets.io";
import { EnvValue, ISecret, Secret } from "cdk8s-plus-34";

export interface BitwardenSecretProps {
  name: string;
  namespace: string;
  /**
   * Format is `{ desired secret key: uuid or name of secret in sm}`
   */
  data: Record<string, string>;
  /**
   * Reshapes the synced keys into a differently-typed Secret. Needed when the
   * consumer wants something other than an Opaque key/value map -- an image
   * pull secret, say, which has to be kubernetes.io/dockerconfigjson with the
   * payload under `.dockerconfigjson`.
   */
  template?: ExternalSecretSpecTargetTemplate;
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
        data: Object.entries(props.data).map((value: [string, string]): ExternalSecretSpecData => {
          return {
            secretKey: value[0],
            remoteRef: {
              key: value[1],
              conversionStrategy: ExternalSecretSpecDataRemoteRefConversionStrategy.DEFAULT,
              decodingStrategy: ExternalSecretSpecDataRemoteRefDecodingStrategy.NONE,
              metadataPolicy: ExternalSecretSpecDataRemoteRefMetadataPolicy.NONE,
            },
          };
        }),
        target: {
          name: props.name,
          template: props.template,
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

export interface GeneratedSecretValue {
  /**
   * Length of the generated value, before any `hex` transformation.
   *
   * @default 48
   */
  readonly length?: number;
  /**
   * How many of the characters are digits.
   *
   * @default 10
   */
  readonly digits?: number;
  /**
   * How many of the characters are symbols. Left at zero by default: these
   * values usually end up in an env var, a URL or a header, and every symbol
   * is one more thing that has to survive being quoted somewhere.
   *
   * @default 0
   */
  readonly symbols?: number;
  /**
   * Emit the SHA-256 of the generated value -- 64 lowercase hex characters --
   * rather than the value itself. For consumers that demand a fixed-width hex
   * string, an AES-256 key being the usual one, which the generator's
   * alphanumeric alphabet cannot produce on its own.
   *
   * @default false
   */
  readonly hex?: boolean;
}

export interface GeneratedSecretProps {
  readonly name: string;
  readonly namespace: string;
  /**
   * Format is `{ desired secret key: how to generate it }`.
   */
  readonly data: Record<string, GeneratedSecretValue>;
}

/**
 * A Secret whose values are minted by external-secrets' Password generator
 * rather than read out of Bitwarden.
 *
 * For values that only ever have to be *stable*, not *known* -- a JWT signing
 * key, a token-encryption key, a pepper. Nothing outside the cluster needs to
 * see them, so putting them in Bitwarden would only be a second place to keep
 * in sync.
 *
 * Each key gets its own generator, so no two values are derivable from one
 * another. `refreshInterval: "0"` means generate once and never rotate --
 * these are keys that existing data is encrypted under or existing sessions
 * are signed with, so a silent reroll would be a silent outage. Rotating one
 * is a deliberate act: delete the Secret and let it be reminted.
 */
export class GeneratedSecret extends Chart {
  public readonly secretName: string;
  public readonly secret: ISecret;
  private readonly data: Record<string, GeneratedSecretValue>;

  constructor(scope: Construct, id: string, props: GeneratedSecretProps) {
    super(scope, id);
    this.secretName = props.name;
    this.secret = Secret.fromSecretName(this, `${id}-isecret`, props.name);
    this.data = props.data;

    const dataFrom: ExternalSecretSpecDataFrom[] = [];
    const template: Record<string, string> = {};

    for (const [key, config] of Object.entries(props.data)) {
      // Secret keys are conventionally SCREAMING_SNAKE env var names; object
      // names have to be a DNS label.
      const slug = key.toLowerCase().replaceAll("_", "-");
      const generatorName = `${props.name}-${slug}`;

      new Password(this, `${slug}-generator`, {
        metadata: {
          name: generatorName,
          namespace: props.namespace,
        },
        spec: {
          length: config.length ?? 48,
          digits: config.digits ?? 10,
          symbols: config.symbols ?? 0,
          noUpper: false,
          allowRepeat: true,
        },
      });

      dataFrom.push({
        sourceRef: {
          generatorRef: {
            apiVersion: "generators.external-secrets.io/v1alpha1",
            kind: ExternalSecretSpecDataFromSourceRefGeneratorRefKind.PASSWORD,
            name: generatorName,
          },
        },
        // Every generator hands back its value under the key `password`, so
        // without this the second one through would clobber the first.
        rewrite: [{ regexp: { source: "^password$", target: slug } }],
      });

      template[key] = config.hex
        ? `{{ index . "${slug}" | sha256sum }}`
        : `{{ index . "${slug}" }}`;
    }

    new ExternalSecret(this, "secret", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      spec: {
        refreshInterval: "0",
        dataFrom: dataFrom,
        target: {
          name: props.name,
          // The default merge policy is Replace, so the rewritten intermediate
          // keys stay internal to the render and only these land in the Secret.
          template: {
            data: template,
          },
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
