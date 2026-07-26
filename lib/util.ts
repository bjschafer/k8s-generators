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
 *
 * Returns the Includes so callers can reach the underlying ApiObjects and
 * patch them -- vendored files are overwritten wholesale on the next
 * `update-crds` run, so local changes have to live in app.ts, not in the file.
 */
export function AddCRDs(scope: Construct, crdDir: string): Include[] {
  return readdirSync(crdDir).map(
    (file) =>
      new Include(scope, `crd-${file}`, {
        url: join(crdDir, file),
      }),
  );
}
