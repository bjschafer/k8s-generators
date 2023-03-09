import {EnvVar, Quantity} from "../imports/k8s";
import {AppProps, YamlOutputType} from "cdk8s";

export const DEFAULT_CPU_LIMIT = Quantity.fromString("250m");
export const DEFAULT_MEM_LIMIT = Quantity.fromString("256Mi");

export const TZ = "America/Chicago";
export const MEDIA_UID = "8675309";
export const MEDIA_GID = "8675309";
export const LSIO_ENV: EnvVar[] = [
  {
    name: "TZ",
    value: TZ,
  },
  {
    name: "PUID",
    value: MEDIA_UID,
  },
  {
    name: "PGID",
    value: MEDIA_GID,
  },
];

export const DNS_NAMESERVERS = ["10.0.10.100", "10.0.10.101"];
export const DNS_SEARCH = ["cmdcentral.xyz"];

export const BACKUP_ANNOTATION_NAME = "backup.velero.io/backup-volumes";

export function DEFAULT_APP_PROPS(namespace: string): AppProps {
  return {
    outdir: `dist/${namespace}`,
    yamlOutputType: YamlOutputType.FILE_PER_RESOURCE,
  };
}