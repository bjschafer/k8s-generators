import { argv } from "process";
import { Updater, VeleroUpdater, VMUpdater, WebUpdater } from "./defs";

// start with velero since it's weird
let updater: Updater;

switch (argv[2]) {
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
