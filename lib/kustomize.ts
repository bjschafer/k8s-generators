import { basename } from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";

export function NewKustomize(outdir: string) {
  const files = fs
    .readdirSync(outdir)
    .filter(
      (f) =>
        f.endsWith(".yaml") &&
        !f.startsWith("Namespace") &&
        f != "kustomization.yaml",
    );
  // while we could use the kustomize construct, it's not really necessary
  // instead, we just write out the kustomization.yaml file and let kustomize do the rest
  const kustomization = {
    resources: files.map((f) => basename(f)),
  };

  fs.writeFileSync(`${outdir}/kustomization.yaml`, yaml.dump(kustomization));
}
