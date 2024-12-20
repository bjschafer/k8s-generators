import { IApiEndpoint, IApiResource } from "cdk8s-plus-31";
import * as crypto from "crypto";

export function basename(path: string): string {
  return path.split("/").reverse()[0];
}

export function toApiEndpoint(
  apiGroup: string,
  resourceType: string,
): IApiEndpoint {
  return new (class implements IApiEndpoint {
    asApiResource(): IApiResource | undefined {
      return new (class implements IApiResource {
        readonly apiGroup: string = apiGroup;
        readonly resourceType: string = resourceType;
      })();
    }

    asNonApiResource(): undefined {}
  })();
}

export interface IHashable {
  toJson(): any[];
}

/**
 * Used to hash a string to be used in forcing updates of configmaps. Prepends const "bjs" to avoid accidentally getting yaml'd
 * @param obj any object that supports CDK8S' toJson()
 * @return the hash of str with "bjs" prepended
 */
export function hashObj(obj: IHashable): string {
  const prefix = "bjs";
  const str = JSON.stringify(obj.toJson());
  return prefix + crypto.createHash("sha256").update(str).digest("hex");
}
