import { Include } from "cdk8s";
import { Construct } from "constructs";
import { readdirSync } from "fs";
import { join } from "path";

export function basename(path: string): string {
  return path.split("/").toReversed()[0];
}

/**
 * Include all CRD manifests from a directory into the given scope.
 * Using cdk8s Include is appropriate here since CRDs are raw YAML definitions.
 */
export function AddCRDs(scope: Construct, crdDir: string): void {
  readdirSync(crdDir).forEach((file) => {
    new Include(scope, `crd-${file}`, {
      url: join(crdDir, file),
    });
  });
}
