#!/usr/bin/env bun

/**
 * Migrates a live Kubernetes Secret (originally sourced from a SealedSecret in the
 * legacy prod repo at /Users/bschafer/development/k8s/prod) into Bitwarden Secrets
 * Manager, and emits a ready-to-paste `BitwardenSecret` construct snippet (see
 * lib/secrets.ts) for the new External Secrets Operator pattern.
 *
 * SealedSecrets can't be decrypted offline — the source of truth for values is the
 * live, already-decrypted Secret in the cluster, read via `kubectl get secret -o json`.
 *
 * Usage:
 *   bun run tools/migrate-secret.ts <namespace> <secret-name> [--project-id <id>] [--execute]
 *   bun run tools/migrate-secret.ts --inventory
 *
 * Dry-run (default, no --execute): reads the live Secret, prints the bws secrets that
 * WOULD be created (key names + masked values only — never full values) and a snippet
 * using placeholder UUIDs. Makes no calls to Bitwarden.
 *
 * --execute: actually creates one bws secret per key via `bws secret create` and
 * emits the snippet with the real UUIDs returned by bws. Requires BWS_ACCESS_TOKEN
 * and the `bws` CLI (not installed via this tool — see README at
 * https://bitwarden.com/help/secrets-manager-cli/, `brew install bitwarden/tap/bws`).
 *
 * --inventory: scans the legacy prod repo (PROD_REPO_PATH env var override, defaults
 * to ~/development/k8s/prod) for SealedSecret manifests and prints a checklist of
 * everything left to migrate. SealedSecrets can't be decrypted, but spec.encryptedData
 * keys are plaintext key *names* (only the values are encrypted), so this is safe to
 * read directly off disk.
 */

import { execFileSync } from "node:child_process";
import { Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";

const CLUSTER_SECRET_STORE_PATH = join(
  __dirname,
  "..",
  "dist",
  "external-secrets",
  "ClusterSecretStore.bitwarden.yaml",
);

// Fallback only used if dist/ hasn't been built yet — keep in sync with
// dist/external-secrets/ClusterSecretStore.bitwarden.yaml (spec.provider.bitwardensecretsmanager.projectID).
const FALLBACK_PROJECT_ID = "01e3e960-5d95-4bbc-b63c-b2bc00226981";

const PROD_REPO_PATH =
  process.env.PROD_REPO_PATH ?? join(process.env.HOME ?? "", "development/k8s/prod");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command with argv passed directly to execve (no shell interpolation).
 * Secret values can contain arbitrary characters (quotes, `$`, backticks, newlines),
 * so this deliberately avoids execSync's shell-string form to rule out injection.
 */
function run(cmd: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      code?: string;
    };
    if (e.code === "ENOENT") {
      return { status: 127, stdout: "", stderr: `${cmd}: command not found` };
    }
    return {
      status: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

function defaultProjectId(): string {
  try {
    const doc = parse(readFileSync(CLUSTER_SECRET_STORE_PATH, "utf-8")) as {
      spec?: {
        provider?: { bitwardensecretsmanager?: { projectID?: string } };
      };
    };
    const projectId = doc.spec?.provider?.bitwardensecretsmanager?.projectID;
    if (projectId) return projectId;
  } catch {
    // dist/ not built yet — fall through to the hardcoded default.
  }
  return FALLBACK_PROJECT_ID;
}

function maskValue(value: string): string {
  if (value.length <= 3) return `***(${value.length} chars)`;
  return `${value.slice(0, 3)}…(${value.length} chars)`;
}

/** Crude binary sniff: valid, control-char-free UTF-8 is treated as text. */
function isBinary(buf: Buffer): boolean {
  const text = buf.toString("utf-8");
  if (Buffer.compare(Buffer.from(text, "utf-8"), buf) !== 0) return true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/** "cert-manager" -> "Cert-Manager", "media" -> "Media" */
function titleCaseNamespace(namespace: string): string {
  return namespace
    .split("-")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join("-");
}

/**
 * Bitwarden Secrets Manager secret names are unique per-project, but our per-key
 * naming needs to be globally collision-proof across every migrated app in the same
 * project. `<Title Case Namespace> - <secret-name> - <KEY>` mirrors the k8s
 * coordinates that already uniquely identify the source value (so two apps can never
 * clash) while matching the human-readable "App - Thing" organization of the
 * pre-existing entries in the project (e.g. "Rclone - Config").
 */
function bwsSecretName(namespace: string, secretName: string, key: string): string {
  return `${titleCaseNamespace(namespace)} - ${secretName} - ${key}`;
}

function printSnippet(
  secretName: string,
  namespace: string,
  keyToRef: Record<string, string>,
  dryRun: boolean,
) {
  const dataLines = Object.entries(keyToRef)
    .map(([key, ref]) => `    ${key}: "${ref}",`)
    .join("\n");
  console.log("\n--- paste into app.ts ---");
  if (dryRun) {
    console.log(
      "// DRY RUN: UUIDs below are placeholders. Re-run with --execute to get real ones.",
    );
  }
  console.log(
    `new BitwardenSecret(app, "${secretName}", {\n` +
      `  name: "${secretName}",\n` +
      `  namespace: "${namespace}",\n` +
      `  data: {\n${dataLines}\n  },\n` +
      `});`,
  );
}

function* walkYamlFiles(dir: string): Generator<string> {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkYamlFiles(full);
    } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      yield full;
    }
  }
}

interface SealedSecretEntry {
  file: string;
  namespace: string;
  name: string;
  keys: string[];
}

const col = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));

function runInventory(): void {
  const entries: SealedSecretEntry[] = [];

  for (const full of walkYamlFiles(PROD_REPO_PATH)) {
    let content: string;
    try {
      content = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    // Cheap pre-filter before the (relatively) expensive full YAML parse.
    if (!content.includes("SealedSecret")) continue;

    let docs;
    try {
      docs = parseAllDocuments(content);
    } catch {
      continue;
    }

    for (const doc of docs) {
      const obj = doc.toJS() as {
        kind?: string;
        metadata?: { name?: string; namespace?: string };
        spec?: { encryptedData?: Record<string, unknown> };
      } | null;
      // Guards against false positives like the SealedSecret CRD definition itself
      // (sealed-secrets/controller.yaml), which mentions the string "SealedSecret"
      // but has kind: CustomResourceDefinition.
      if (!obj || obj.kind !== "SealedSecret") continue;

      entries.push({
        file: full.slice(PROD_REPO_PATH.length + 1),
        namespace: obj.metadata?.namespace ?? "(none)",
        name: obj.metadata?.name ?? "(unknown)",
        keys: Object.keys(obj.spec?.encryptedData ?? {}),
      });
    }
  }

  entries.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));

  console.log(`Found ${entries.length} SealedSecret instance(s) under ${PROD_REPO_PATH}\n`);
  console.log(`${col("NAMESPACE", 18)}${col("NAME", 26)}${col("KEYS", 42)}FILE`);
  for (const e of entries) {
    console.log(`${col(e.namespace, 18)}${col(e.name, 26)}${col(e.keys.join(","), 42)}${e.file}`);
  }
  console.log(`\n${entries.length} total. Migrate with:`);
  console.log("  bun run tools/migrate-secret.ts <namespace> <name> --execute\n");
}

function usage(): never {
  console.error(
    "Usage:\n" +
      "  bun run tools/migrate-secret.ts <namespace> <secret-name> [--project-id <id>] [--execute]\n" +
      "  bun run tools/migrate-secret.ts --inventory",
  );
  process.exit(1);
}

function migrate(namespace: string, secretName: string, projectId: string, execute: boolean): void {
  if (execute && !process.env.BWS_ACCESS_TOKEN) {
    console.error("BWS_ACCESS_TOKEN env var is required with --execute (bws CLI auth). Aborting.");
    process.exit(1);
  }

  if (execute) {
    const check = run("bws", ["--version"]);
    if (check.status === 127) {
      console.error(
        "bws CLI not found on PATH. Install it (e.g. `brew install bitwarden/tap/bws`), see " +
          "https://bitwarden.com/help/secrets-manager-cli/ — cannot --execute without it.",
      );
      process.exit(1);
    }
  }

  const got = run("kubectl", ["get", "secret", "-n", namespace, secretName, "-o", "json"]);
  if (got.status !== 0) {
    console.error(`Failed to read secret ${namespace}/${secretName}:\n${got.stderr || got.stdout}`);
    process.exit(1);
  }

  const secret = JSON.parse(got.stdout) as {
    type?: string;
    data?: Record<string, string>;
  };
  const data = secret.data ?? {};
  const keys = Object.keys(data);
  if (keys.length === 0) {
    console.error(`Secret ${namespace}/${secretName} has no data keys. Nothing to migrate.`);
    process.exit(1);
  }

  console.log(
    `Secret ${namespace}/${secretName} (type=${secret.type ?? "Opaque"}), ${keys.length} key(s):\n`,
  );

  const textKeys: { key: string; value: string }[] = [];
  for (const key of keys) {
    const buf = Buffer.from(data[key], "base64");
    if (isBinary(buf)) {
      console.log(
        `  ${key}: SKIPPED (binary data, ${buf.length} bytes) — migrate this one manually`,
      );
      continue;
    }
    const value = buf.toString("utf-8");
    textKeys.push({ key, value });
    console.log(
      `  ${key}: ${maskValue(value)} -> bws secret "${bwsSecretName(namespace, secretName, key)}"`,
    );
  }

  if (textKeys.length === 0) {
    console.log("\nNo text keys to migrate (all binary/skipped).");
    return;
  }

  if (!execute) {
    console.log(
      `\nDRY RUN — no bws secrets created. Re-run with --execute to create them in project ${projectId}.`,
    );
    const placeholders: Record<string, string> = {};
    for (const { key } of textKeys) {
      placeholders[key] = "00000000-0000-0000-0000-000000000000";
    }
    printSnippet(secretName, namespace, placeholders, true);
    return;
  }

  console.log(`\nCreating ${textKeys.length} bws secret(s) in project ${projectId}...\n`);
  const created: Record<string, string> = {};
  for (const { key, value } of textKeys) {
    const bwsName = bwsSecretName(namespace, secretName, key);
    const res = run("bws", ["secret", "create", bwsName, value, projectId, "--output", "json"]);
    if (res.status !== 0) {
      console.error(`\nFAILED creating "${bwsName}": ${res.stderr || res.stdout}`);
      if (Object.keys(created).length > 0) {
        console.error(
          "\nAlready created (safe to keep — re-running will NOT delete these, but WILL re-create " +
            "duplicates for keys already done, so hand-edit the remaining keys or fix the error and " +
            "invoke `bws secret create` yourself for what's left). Snippet so far:",
        );
        printSnippet(secretName, namespace, created, false);
      }
      process.exit(1);
    }
    const parsed = JSON.parse(res.stdout) as { id: string };
    created[key] = parsed.id;
    console.log(`  created "${bwsName}" -> ${parsed.id}`);
  }

  printSnippet(secretName, namespace, created, false);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--inventory")) {
    runInventory();
    return;
  }

  const execute = args.includes("--execute");
  const projectIdFlagIndex = args.indexOf("--project-id");
  const projectIdArg = projectIdFlagIndex !== -1 ? args[projectIdFlagIndex + 1] : undefined;
  const projectId = projectIdArg ?? defaultProjectId();

  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--project-id");
  const [namespace, secretName] = positional;
  if (!namespace || !secretName) usage();

  migrate(namespace, secretName, projectId, execute);
}

main();
