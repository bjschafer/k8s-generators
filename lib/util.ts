import { IApiEndpoint, IApiResource } from "cdk8s-plus-27";
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

/**
 * Used to hash a string to be used in forcing updates of configmaps. Prepends const "bjs" to avoid accidentally getting yaml'd
 * @param str the string to hash
 * @return the hash of str with "bjs" prepended
 */
export function hashString(str: string): string {
  const prefix = "bjs";
  return prefix + crypto.createHash("sha256").update(str).digest("hex");
}
