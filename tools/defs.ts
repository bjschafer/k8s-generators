import { Yaml } from "cdk8s";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseAllDocuments, stringify } from "yaml";

export interface Updater {
  Run(): void;
}

export class WebUpdater implements Updater {
  private url: string;
  outputPath: string;

  constructor(url: string, outputPath: string) {
    this.url = url;
    this.outputPath = outputPath;
    mkdirSync(this.outputPath, {
      recursive: true,
    });
  }

  Run(): void {
    const items = Yaml.load(this.url);

    for (const item of items) {
      if (item.kind !== "CustomResourceDefinition") {
        continue;
      }
      const name = item.metadata.name;

      const path = join(this.outputPath, `${name}.yaml`);
      writeFileSync(path, stringify(item));
    }
  }
}

export function parseConstStringFromAppTs(
  appName: string,
  constName: string,
): string {
  const appTsPath = join(__dirname, "..", "apps", appName, "app.ts");
  const src = readFileSync(appTsPath, "utf8");
  const re = new RegExp(`\\bconst\\s+${constName}\\s*=\\s*[\"'\`](.*?)[\"'\`]`);
  const m = re.exec(src);
  if (!m) {
    throw new Error(`Could not find const ${constName} in ${appTsPath}`);
  }
  return m[1];
}

abstract class CommandUpdater implements Updater {
  private outputBase = "./apps";
  private version?: string;

  abstract command: string;
  abstract args: string;
  abstract outputDir: string;

  abstract versionDetector(): string;

  private readyMade = false;
  private getOutputPath(): string {
    const output = join(this.outputBase, this.outputDir);

    if (!this.readyMade) {
      mkdirSync(output, {
        recursive: true,
      });
      this.readyMade = true;
    }

    return output;
  }

  private writeItem(item: any) {
    const name = item.metadata.name;

    const path = join(this.getOutputPath(), `${name}.yaml`);
    writeFileSync(path, stringify(item));
  }

  WithVersion(version: string): this {
    this.version = version;
    return this;
  }

  Run() {
    if (this.version) {
      const foundVersion = this.versionDetector();
      if (foundVersion !== this.version) {
        throw new Error(
          `Found version ${foundVersion} doesn't match requested ${this.version}`,
        );
      }
    }

    // now run the command to grab all the manifests
    const manifests = execSync(`${this.command} ${this.args}`, {
      maxBuffer: 50 * 1024 * 1024, // default 1024 * 1024
    }).toString();
    const docs = parseAllDocuments(manifests);

    // some things spit out a k8s list
    if (docs.length === 1) {
      const maybeList = docs[0].toJS();
      if (maybeList.kind === "List") {
        for (const item of maybeList.items) {
          this.writeItem(item);
        }
        return;
      }
    }

    // and write them out
    for (const doc of docs) {
      this.writeItem(doc.toJS());
    }
  }
}

export class VMUpdater extends CommandUpdater {
  command = "helm";
  args =
    "show crds oci://ghcr.io/victoriametrics/helm-charts/victoria-metrics-k8s-stack";
  outputDir = "metrics/crds";

  versionDetector(): string {
    return ""; // TODO better
  }
}

export class VeleroUpdater extends CommandUpdater {
  command = "velero";
  args = "install --crds-only --dry-run --output yaml";
  outputDir = "velero/crds";

  versionDetector(): string {
    return execSync(
      `${this.command} version --client-only | awk '/Version/ { print $2 }'`,
    )
      .toString()
      .trim();
  }
}
