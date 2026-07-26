/**
 * Fetches the upstream JSON Schemas declared in `tools/schemas.ts` into
 * `schemas/`. Companion to `tools/update-crds.ts`, same shape of CLI:
 *
 *   bun run tools/update-schemas.ts <name> [version]
 *   bun run tools/update-schemas.ts --all
 *   bun run tools/update-schemas.ts <name|--all> --out-dir <dir>
 *
 * Run `mise run schemas` afterwards to regenerate `imports/helm-values/`
 * from the result -- or just `mise run update-schemas`, which chains both.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { REPO_ROOT, resolveVersion } from "./sources";
import { type SchemaSource, schemaSources } from "./schemas";

async function fetchSchema(source: SchemaSource, version?: string): Promise<string> {
  switch (source.fetch.kind) {
    case "helm": {
      const { chart, repo } = source.fetch;
      if (!version) {
        throw new Error(`${source.name}: a helm source needs a version`);
      }
      // Untar into a throwaway dir: we want exactly one file out of the
      // archive, and leaving chart trees lying around under the repo would
      // land them in dist/-adjacent globs.
      const dir = mkdtempSync(join(tmpdir(), `schema-${source.name}-`));
      try {
        execFileSync(
          "helm",
          ["pull", chart, "--repo", repo, "--version", version, "--untar", "--untardir", dir],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        // Helm requires values.schema.json at the chart root, so this path is
        // fixed -- a subchart's schema would need its own source stanza.
        const rel = join(chart, "values.schema.json");
        const file = join(dir, rel);
        if (!existsSync(file)) {
          throw new Error(
            `${source.name}: ${chart}@${version} does not contain ${rel}. Upstream may have dropped ` +
              `its values schema -- if so, remove this source and un-type the app's HelmApp<T>.`,
          );
        }
        return readFileSync(file, "utf8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case "url": {
      const url = source.fetch.url(version);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`${source.name}: GET ${url} returned ${res.status} ${res.statusText}`);
      }
      return await res.text();
    }
  }
}

async function runOne(
  source: SchemaSource,
  opts: { versionOverride?: string; outDirOverride?: string },
): Promise<void> {
  const version = resolveVersion(source.version, opts.versionOverride);
  const outputFile = opts.outDirOverride
    ? join(opts.outDirOverride, basename(source.outputFile))
    : join(REPO_ROOT, source.outputFile);

  console.log(`[${source.name}] fetching${version ? ` version ${version}` : ""} -> ${outputFile}`);
  const raw = await fetchSchema(source, version);

  // Reserialize rather than writing upstream's bytes through: charts publish
  // these at wildly different indentation, and a formatting-only diff on every
  // refetch buries the substantive schema changes we actually want to review.
  const parsed: unknown = inlineRootRef(JSON.parse(raw));
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(parsed, null, 4) + "\n");
  console.log(`[${source.name}] wrote ${outputFile}`);
}

/**
 * Replace a root that is nothing but a `$ref` with the definition it points
 * at, leaving the definition in place for the inner `$ref`s that still target
 * it.
 *
 * cert-manager publishes its schema this way -- the root is
 * `{"$schema": ..., "$ref": "#/$defs/helm-values"}` -- and
 * json-schema-to-typescript 15 can't resolve a ref in that position: it dies
 * with "Refs should have been resolved by the resolver!". Only the root
 * position is affected; `$defs` and dotted definition keys are both fine.
 * The rewrite is semantically a no-op for validators, which would follow the
 * ref to the same subschema.
 */
// oxlint-disable-next-line no-explicit-any
function inlineRootRef(schema: any): any {
  const ref: unknown = schema?.$ref;
  if (typeof ref !== "string") {
    return schema;
  }
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) {
    throw new Error(
      `root $ref "${ref}" doesn't point into $defs/definitions; json2ts can't resolve a root ref ` +
        `and this one can't be inlined automatically.`,
    );
  }
  const [, container, pointer] = m;
  // JSON Pointer escaping: ~1 is "/", ~0 is "~". Unescape in that order.
  const key = pointer.replaceAll("~1", "/").replaceAll("~0", "~");
  const target: unknown = schema[container]?.[key];
  if (!target || typeof target !== "object") {
    throw new Error(`root $ref "${ref}" points at a missing definition`);
  }
  const { $ref: _dropped, ...rest } = schema;
  return { ...rest, ...target };
}

function usage(): never {
  console.error(
    "Usage: bun run tools/update-schemas.ts <name|--all> [version] [--out-dir <dir>]\n",
  );
  console.error("Known schemas:");
  for (const s of schemaSources) {
    console.error(`  ${s.name.padEnd(16)}${s.outputFile}`);
    console.error(`  ${" ".repeat(16)}${s.description}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
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
        "A version override can't be used with --all; run a single schema to override its version.",
      );
    }
    for (const source of schemaSources) {
      await runOne(source, { outDirOverride });
    }
    return;
  }

  const source = schemaSources.find((s) => s.name === target);
  if (!source) {
    console.error(`Unknown schema "${target}"\n`);
    usage();
  }
  await runOne(source, { versionOverride, outDirOverride });
}

// Not top-level `await`: tsconfig's module/target combo rejects it (TS1378),
// and update-crds.ts' synchronous `main()` has no equivalent to model.
main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
