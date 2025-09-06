import { argv } from "process";
import { Updater, VeleroUpdater, VMUpdater, WebUpdater } from "./defs";

// start with velero since it's weird
let updater: Updater;

switch (argv[2]) {
  case "cert-manager": {
    const version = argv[3];
    updater = new WebUpdater(
      `https://github.com/cert-manager/cert-manager/releases/download/v${version}/cert-manager.crds.yaml`,
      "apps/cert-manager/crds",
    );
    break;
  }
  case "cnpg": {
    const version = argv[3];
    const release = version.split(".", 2).join(".");
    updater = new WebUpdater(
      `https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-${release}/releases/cnpg-${version}.yaml`,
      "/tmp/cnpg",
    );
    break;
  }
  case "metrics": {
    updater = new VMUpdater();
    break;
  }
  case "velero": {
    updater = new VeleroUpdater().WithVersion("v1.16.0");
    break;
  }

  default:
    throw new Error(`Unknown app ${argv[2]}`);
}
updater.Run();
