/**
 * Generic CRD / static-manifest updater. Replaces the old
 * `download-crds.ts` + `defs.ts` switch-statement approach with a single
 * engine driven by the declarative registry in `tools/sources.ts`.
 *
 * Usage:
 *   bun run tools/update-crds.ts <name> [version]
 *   bun run tools/update-crds.ts --all
 *   bun run tools/update-crds.ts <name|--all> --out-dir <dir>   # write elsewhere (e.g. for testing)
 *
 * `version` overrides the source's registry/app-const version for a single
 * run without editing tools/sources.ts. `--out-dir` redirects output to
 * `<dir>/<source-name>` instead of the source's real `outputDir` - use this
 * to validate a fetch without touching tracked files under `apps/`.
 */
import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Yaml } from "cdk8s";
import { parseAllDocuments, stringify } from "yaml";
import { type CrdSource, sources } from "./sources";

const REPO_ROOT = join(__dirname, "..");

/** Loose YAML-doc-as-object type; these are ad-hoc k8s manifests, not typed resources. */
// oxlint-disable-next-line no-explicit-any
type AnyDoc = any;

export function parseConstStringFromAppTs(appName: string, constName: string): string {
  const appTsPath = join(REPO_ROOT, "apps", appName, "app.ts");
  const src = readFileSync(appTsPath, "utf8");
  const re = new RegExp("\\bconst\\s+" + constName + "\\s*=\\s*[\"'`](.*?)[\"'`]");
  const m = re.exec(src);
  if (!m) {
    throw new Error(`Could not find const ${constName} in ${appTsPath}`);
  }
  return m[1];
}

function resolveVersion(source: CrdSource, override?: string): string | undefined {
  if (override) {
    return override;
  }
  switch (source.version.kind) {
    case "literal":
      return source.version.value;
    case "app-const":
      return parseConstStringFromAppTs(source.version.appName, source.version.constName);
    case "none":
      return undefined;
  }
}

function flattenDocs(raw: string): AnyDoc[] {
  const docs = parseAllDocuments(raw);
  if (docs.length === 1) {
    const maybe: AnyDoc = docs[0].toJS();
    if (maybe?.kind === "List" && Array.isArray(maybe.items)) {
      return maybe.items;
    }
    return [maybe];
  }
  return docs.map((d) => d.toJS());
}

function fetchItems(source: CrdSource, version?: string): AnyDoc[] {
  switch (source.fetch.kind) {
    case "web": {
      const items: AnyDoc[] = [];
      for (const url of source.fetch.urls(version)) {
        items.push(...(Yaml.load(url) as AnyDoc[]));
      }
      return items;
    }
    case "command": {
      const { command, args, versionCheck } = source.fetch;
      if (versionCheck) {
        const stdout = execFileSync(versionCheck.command, versionCheck.args).toString();
        const found = versionCheck.extract(stdout);
        const expected = version
          ? versionCheck.expected
            ? versionCheck.expected(version)
            : version
          : undefined;
        if (expected && found !== expected) {
          throw new Error(
            `${source.name}: installed \`${command}\` reports version "${found}", expected "${expected}" ` +
              `(from tools/sources.ts). Update the installed tool, or bump the version in the registry if ` +
              `this drift is intentional.`,
          );
        }
      }
      const raw = execFileSync(command, args(version), {
        maxBuffer: 50 * 1024 * 1024, // default is 1024 * 1024
      }).toString();
      return flattenDocs(raw);
    }
  }
}

function filenameFor(source: CrdSource, item: AnyDoc): string {
  const name = item?.metadata?.name ?? "unnamed";
  return source.filenameKind ? `${item.kind}.${name}.yaml` : `${name}.yaml`;
}

function writeItems(source: CrdSource, outputDir: string, items: AnyDoc[]): number {
  mkdirSync(outputDir, { recursive: true });
  const crdOnly = source.crdOnly ?? true;
  let written = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || !item.kind) {
      continue;
    }
    if (crdOnly && item.kind !== "CustomResourceDefinition") {
      continue;
    }
    const path = join(outputDir, filenameFor(source, item));
    writeFileSync(path, stringify(item));
    written++;
  }
  return written;
}

function runOne(
  source: CrdSource,
  opts: { versionOverride?: string; outDirOverride?: string },
): void {
  const version = resolveVersion(source, opts.versionOverride);
  const outputDir = opts.outDirOverride
    ? join(opts.outDirOverride, source.name)
    : join(REPO_ROOT, source.outputDir);

  console.log(`[${source.name}] fetching${version ? ` version ${version}` : ""} -> ${outputDir}`);
  const items = fetchItems(source, version);
  const written = writeItems(source, outputDir, items);
  console.log(`[${source.name}] wrote ${written} file(s)`);
}

function usage(): never {
  console.error("Usage: bun run tools/update-crds.ts <name|--all> [version] [--out-dir <dir>]\n");
  console.error("Known sources:");
  for (const s of sources) {
    const flag = s.enabled === false ? " (disabled - placeholder)" : "";
    console.error(`  ${s.name.padEnd(24)}${flag}`);
    console.error(`  ${" ".repeat(24)}${s.description}`);
  }
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
  }

  let outDirOverride: string | undefined;
  const outFlagIdx = argv.indexOf("--out-dir");
  if (outFlagIdx !== -1) {
    outDirOverride = argv[outFlagIdx + 1];
    if (!outDirOverride) {
      throw new Error("--out-dir requires a directory argument");
    }
    argv.splice(outFlagIdx, 2);
  }

  const [target, versionOverride] = argv;

  if (target === "--all") {
    if (versionOverride) {
      throw new Error(
        "A version override can't be used with --all; run a single source to override its version.",
      );
    }
    for (const source of sources.filter((s) => s.enabled !== false)) {
      runOne(source, { outDirOverride });
    }
    return;
  }

  const source = sources.find((s) => s.name === target);
  if (!source) {
    console.error(`Unknown source "${target}"\n`);
    usage();
  }
  if (source.enabled === false) {
    console.warn(
      `[${source.name}] this source is marked disabled - it's a placeholder for a planned migration and ` +
        `hasn't been validated against a real apps/ chart. Proceeding since it was named explicitly.`,
    );
  }
  runOne(source, { versionOverride, outDirOverride });
}

main();
