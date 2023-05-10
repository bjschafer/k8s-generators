import { EnvVar, Quantity } from "../imports/k8s";
import { AppProps, YamlOutputType } from "cdk8s";
import { EnvValue } from "cdk8s-plus-25";

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

export const LSIO_ENVVALUE: { [key: string]: EnvValue } = {
  TZ: EnvValue.fromValue(TZ),
  PUID: EnvValue.fromValue(MEDIA_UID),
  PGID: EnvValue.fromValue(MEDIA_GID),
};

export const DNS_NAMESERVERS = ["10.0.10.100", "10.0.10.101"];
export const DNS_SEARCH = ["cmdcentral.xyz"];

export const BACKUP_ANNOTATION_NAME = "backup.velero.io/backup-volumes";

export function DEFAULT_APP_PROPS(namespace: string): AppProps {
  return {
    outdir: `dist/${namespace}`,
    yamlOutputType: YamlOutputType.FILE_PER_RESOURCE,
  };
}

export const INGRESS_CLASS_NAME = "traefik";

export const CLUSTER_ISSUER = {
  kind: "ClusterIssuer",
  name: "letsencrypt",
};

export function GET_SERVICE_URL(
  name: string,
  namespace: string,
  includeScheme: boolean,
  port?: number
): string {
  const pieces = [];
  if (includeScheme) {
    pieces.push("http://");
  }
  pieces.push(`${name}.${namespace}.svc.cluster.local`);
  if (port) {
    pieces.push(`:${port}`);
  }
  return pieces.join("");
}

export function GET_COMMON_LABELS(
  name: string,
  instance?: string
): { [name: string]: string } {
  return {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/instance": instance ?? name,
  };
}

export const DEFAULT_SECURITY_CONTEXT = {
  ensureNonRoot: false,
  readOnlyRootFilesystem: false,
};
