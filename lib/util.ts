import { IApiEndpoint, IApiResource } from "cdk8s-plus-27";

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
