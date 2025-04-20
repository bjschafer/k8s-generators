import { argv } from "process";
import { Updater, VeleroUpdater } from "./defs";

// start with velero since it's weird
let updater: Updater;

switch (argv[2]) {
  case "velero":
    updater = new VeleroUpdater().WithVersion("v1.16.0");
    break;

  default:
    throw new Error(`Unknown app ${argv[2]}`);
}
updater.Run();
