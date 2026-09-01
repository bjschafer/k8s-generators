import { AppProps, YamlOutputType } from "cdk8s";
import { DnsPolicy, EnvValue } from "cdk8s-plus-34";
import { EnvVar, Quantity } from "../imports/k8s";

export const DEFAULT_CPU_LIMIT = Quantity.fromString("250m");
export const DEFAULT_MEM_LIMIT = Quantity.fromString("256Mi");

// The k3s release every node runs. Bumping this is what actually triggers a
// rolling cluster upgrade (apps/system-upgrade compares it against each node's
// kubelet version, so it stays inert until the two disagree). Keep the mise.toml
// kubectl pin in step with it; renovate.json disables that pin's own updates
// precisely so it can only move with this line.
// renovate: datasource=custom.k3s depName=k3s versioning=loose
export const K3S_VERSION = "v1.36.4+k3s1";

// `v1.36.3+k3s1` -> `v1.36.3`. k3s appends its own build number to the upstream
// Kubernetes version, and a container tag cannot contain `+`.
export const KUBERNETES_VERSION = K3S_VERSION.split("+")[0];

// The tag for in-cluster kubectl container images. This deliberately is *not*
// derived from KUBERNETES_VERSION: rancher publishes its kubectl image per
// upstream patch on its own cadence and lags behind k3s, so deriving the tag
// renders a reference to something that may not exist yet. That is not
// hypothetical -- it is exactly how the watchstate prune CronJob wedged, sitting
// in ImagePullBackOff against `rancher/kubectl:v1.36.3` (404, while v1.36.2 was
// the newest published) and, under concurrencyPolicy Forbid, silently skipping
// every subsequent run. Renovate tracks this against the registry's real tag
// list, so it can only ever name a tag that exists; the assertion below is what
// keeps it tied to the cluster instead.
// renovate: datasource=docker depName=rancher/kubectl
export const KUBECTL_IMAGE_VERSION = "v1.36.2";

// kubectl is supported within one minor of the apiserver -- one *minor*, not an
// exact patch match, which is the slack that lets the pin above float on
// rancher's cadence. Nothing else stops a k3s minor bump from stranding it (or
// Renovate from running it a minor ahead of the cluster), so fail the synth
// rather than ship a manifest that talks to the apiserver out of support.
const minorOrdinal = (version: string): number => {
  const parsed = /^v(\d+)\.(\d+)\./.exec(version);
  if (!parsed) throw new Error(`Unparseable Kubernetes version: ${version}`);
  return Number(parsed[1]) * 1000 + Number(parsed[2]);
};

if (Math.abs(minorOrdinal(KUBECTL_IMAGE_VERSION) - minorOrdinal(KUBERNETES_VERSION)) > 1) {
  throw new Error(
    `KUBECTL_IMAGE_VERSION (${KUBECTL_IMAGE_VERSION}) is more than one minor away from the cluster's ${KUBERNETES_VERSION}. ` +
      `Bump it to a tag rancher has actually published for the cluster's minor.`,
  );
}

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

export const DNS_POLICY_NONE = {
  policy: DnsPolicy.NONE,
  nameservers: DNS_NAMESERVERS,
  searches: DNS_SEARCH,
};

export const BACKUP_ANNOTATION_EXCLUDE = "velero.io/exclude-from-backup";

export function DEFAULT_APP_PROPS(namespace: string): AppProps {
  return {
    outdir: `dist/${namespace}`,
    outputFileExtension: ".yaml",
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
  port?: number,
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

export function GET_COMMON_LABELS(name: string, instance?: string): { [name: string]: string } {
  return {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/instance": instance ?? name,
    "app.kubernetes.io/managed-by": "generators",
  };
}

export const DEFAULT_SECURITY_CONTEXT = {
  ensureNonRoot: false,
  readOnlyRootFilesystem: false,
};

// Phase 1 hardening: for images audited as running non-root (either the image
// ships a non-root USER, or a live pod was confirmed running non-root).
// Does NOT flip readOnlyRootFilesystem -- that's a later phase.
export const NONROOT_SECURITY_CONTEXT = {
  ensureNonRoot: true,
  readOnlyRootFilesystem: false,
};

// Same as NONROOT_SECURITY_CONTEXT, but spells out the uid/gid explicitly.
// Needed when the image's USER directive is a *name* rather than a number
// (e.g. `USER pda`): the kubelet can't resolve a name to a uid, so it refuses
// to start the container with "has runAsNonRoot and image has non-numeric
// user", even though the user really is non-root. Read the numbers off the
// running workload with `kubectl exec <pod> -- id`.
export function NONROOT_SECURITY_CONTEXT_UID(user: number, group?: number) {
  return {
    ...NONROOT_SECURITY_CONTEXT,
    user: user,
    group: group,
  };
}

export const IP_CIDRS_V4: { [name: string]: string } = {
  WIRED_LAN: "10.0.3.0/24",
  DMZ: "10.0.4.0/24",
  GUEST: "10.5.0.0/23",
  SERVERS_STATIC: "10.0.10.0/24",
  SERVERS_DHCP: "10.0.11.0/24",
  WIRELESS_LAN: "10.0.30.0/24",
  IOT: "10.50.0.0/24",
  IP_CAMERAS: "10.0.45.0/24",
  NETWORK_MANAGEMENT: "10.0.99.0/24",
};

export const RELOADER_ENABLED = {
  "reloader.stakater.com/auto": "true",
};

// external-dns reads exactly one annotation prefix -- whichever
// --annotation-prefix names (see apps/external-dns/app.ts) -- and a resource
// missing the one being read looks like a resource that wants no record, which
// --policy=sync then deletes. That makes changing prefixes a three-step
// migration rather than an edit: add the new one to this list, flip the flag
// once every live object is confirmed to carry both, then drop the old one.
// This list is the seam that keeps steps 1 and 3 to one line each; v0.22.0's
// alpha -> GA move went through it in dc389b72 / 40df221c / this commit.
const EXTERNAL_DNS_PREFIXES = ["external-dns.kubernetes.io/"] as const;

function externalDnsAnnotation(suffix: string, value: string): Record<string, string> {
  return Object.fromEntries(EXTERNAL_DNS_PREFIXES.map((prefix) => [`${prefix}${suffix}`, value]));
}

/** The name external-dns should publish for this resource, under every prefix it may read. */
export function externalDnsHostname(hostname: string): Record<string, string> {
  return externalDnsAnnotation("hostname", hostname);
}

/** The record value external-dns should publish, overriding what it would infer. */
export function externalDnsTarget(target: string): Record<string, string> {
  return externalDnsAnnotation("target", target);
}
export const METALLB_IP_ANNOTATION_KEY = "metallb.io/loadBalancerIPs";
