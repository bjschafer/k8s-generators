import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseAllDocuments, stringify } from "yaml";

export interface Updater {
  Run(): void;
}

abstract class CommandUpdater {
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
    const manifests = execSync(`${this.command} ${this.args}`).toString();
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
