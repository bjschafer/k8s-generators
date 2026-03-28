#!/usr/bin/env bun

/**
 * Validates VMRule Prometheus alert rules using promtool and pint.
 * Skips VictoriaLogs-based rules (type=vlogs) since they use VQL syntax, not PromQL.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { parse, stringify } from "yaml";

const rootDir = join(import.meta.dir, "..");
const tmpDir = mkdtempSync(join(tmpdir(), "vmrule-validate-"));
const tmpFiles: string[] = [];
let exitCode = 0;

try {
  const glob = new Bun.Glob("dist/**/VMRule.*.yaml");

  for await (const file of glob.scan({ cwd: rootDir })) {
    const content = readFileSync(join(rootDir, file), "utf-8");
    const doc = parse(content) as Record<string, any>;

    if (doc?.kind !== "VMRule") continue;

    const labels = doc.metadata?.labels ?? {};

    // Skip VictoriaLogs rules — they use VQL syntax, not PromQL
    if (labels["alerts.cmdcentral.xyz/kind"] === "logs") {
      console.log(`Skipping logs rule: ${file}`);
      continue;
    }

    // Skip Helm-chart-generated VMRules — validated upstream, may use VM-specific extensions
    if (labels["app.kubernetes.io/managed-by"] === "Helm") continue;

    // Strip VictoriaMetrics-specific group fields that promtool doesn't understand:
    // - params: query parameter overrides (e.g. tenant routing)
    // - concurrency: parallel query evaluation
    const groups = (doc.spec?.groups ?? [])
      .filter((g: any) => g.type !== "vlogs")
      .map(({ params: _params, concurrency: _concurrency, ...rest }: any) => rest);
    if (groups.length === 0) continue;

    const tmpFile = join(tmpDir, basename(file));
    writeFileSync(tmpFile, stringify({ groups }));
    tmpFiles.push(tmpFile);
  }

  if (tmpFiles.length === 0) {
    console.log("No metrics VMRule files to validate.");
    process.exit(0);
  }

  console.log(`Validating ${tmpFiles.length} VMRule file(s) with promtool...`);
  const promtool = spawnSync("promtool", ["check", "rules", ...tmpFiles], { stdio: "inherit" });
  if (promtool.status !== 0) exitCode = 1;

  console.log(`\nLinting ${tmpFiles.length} VMRule file(s) with pint...`);
  const pint = spawnSync("pint", ["--offline", "lint", ...tmpFiles], { stdio: "inherit" });
  if (pint.status !== 0) exitCode = 1;
} finally {
  for (const f of tmpFiles) {
    try {
      unlinkSync(f);
    } catch {}
  }
  try {
    rmdirSync(tmpDir);
  } catch {}
}

process.exit(exitCode);
