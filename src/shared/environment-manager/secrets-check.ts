/**
 * Local-secrets readiness check.
 *
 * Repos scaffolded by stack that declare `config.local.sidecars[].secrets`
 * ship a COMMITTED, generated `.stack-secrets.example.yml` listing every
 * secret they need, and expect a gitignored `.stack-secrets.yml` beside it
 * with real values. That example file is the whole contract — den reads it
 * generically and needs no per-repo knowledge.
 *
 * Why this gate exists: a sidecar's generated `up.sh` validates only that each
 * secret is PRESENT and NON-EMPTY, so the placeholder value (`replace-me`)
 * sails through. Starting a stack that way is not a harmless no-op — a
 * database container bakes the password it is first started with into its data
 * volume at initdb time, and no later edit of the secrets file changes it. The
 * result is a stack that looks healthy (liveness probes don't authenticate)
 * while every consumer fails to connect. Refusing to start is the only cheap
 * moment to prevent it.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { getDistRoot } from "../paths.js";
import { getReposRoot } from "../den-config.js";

import { product } from "../product.js";
/** stack's generated placeholder, plus the `<angle-bracket>` fill-me-in convention. */
const PLACEHOLDER_RE = /^(replace-me|<[^>]*>)$/;

const EXAMPLE_FILE = ".stack-secrets.example.yml";
const SECRETS_FILE = ".stack-secrets.yml";

export interface SecretsCheckResult {
  ok: boolean;
  /** Absolute path to the secrets file the engineer needs to fill in. */
  secretsPath: string;
  /** Absolute path to the committed example that declares the contract. */
  examplePath: string;
  /** True when `.stack-secrets.yml` doesn't exist at all. */
  fileMissing: boolean;
  /** Declared keys absent from the secrets file (names only — never values). */
  missingKeys: string[];
  /** Declared keys still holding a placeholder or empty value. */
  placeholderKeys: string[];
}

function parseFlatYaml(file: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Check a repo's local secrets against its declared contract.
 *
 * Returns `null` when the repo declares no contract (no example file) — i.e.
 * most repos — so callers can treat "no contract" as "nothing to enforce".
 */
export function checkRepoSecrets(repoPath: string): SecretsCheckResult | null {
  const examplePath = path.join(repoPath, EXAMPLE_FILE);
  const secretsPath = path.join(repoPath, SECRETS_FILE);
  if (!fs.existsSync(examplePath)) return null;

  const declared = parseFlatYaml(examplePath);
  if (!declared) return null; // unparseable contract — don't invent failures
  const keys = Object.keys(declared);
  if (keys.length === 0) return null;

  if (!fs.existsSync(secretsPath)) {
    return {
      ok: false,
      secretsPath,
      examplePath,
      fileMissing: true,
      missingKeys: keys,
      placeholderKeys: [],
    };
  }

  const actual = parseFlatYaml(secretsPath) ?? {};
  const missingKeys: string[] = [];
  const placeholderKeys: string[] = [];
  for (const key of keys) {
    if (!(key in actual)) {
      missingKeys.push(key);
      continue;
    }
    const value = actual[key];
    const text = value == null ? "" : String(value).trim();
    if (text === "" || PLACEHOLDER_RE.test(text)) placeholderKeys.push(key);
  }

  return {
    ok: missingKeys.length === 0 && placeholderKeys.length === 0,
    secretsPath,
    examplePath,
    fileMissing: false,
    missingKeys,
    placeholderKeys,
  };
}

/**
 * Other checkouts of the same repo on this machine, in the order
 * `readManifestAnyBranch` already established: other managed branch
 * clones first, then the engineer's own sibling checkout.
 */
function otherCheckouts(repoName: string, excludePath: string): string[] {
  const out: string[] = [];
  const managedRoot = path.join(
    getDistRoot(),
    `${product().servicesDir}`,
    repoName,
  );
  try {
    for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(path.join(managedRoot, entry.name));
    }
  } catch {
    /* no managed clones */
  }
  out.push(path.join(getReposRoot(), repoName));
  const exclude = path.resolve(excludePath);
  return out.filter((p) => path.resolve(p) !== exclude);
}

export interface SecretsSeedResult {
  /** Keys filled in from the donor (names only — never values). */
  filled: string[];
  /** Checkout the values came from. */
  donorPath: string;
}

/**
 * Fill a freshly cloned repo's secrets file from ANOTHER checkout of the SAME
 * repo on this machine.
 *
 * A managed clone starts with stack's placeholders, which blocks `make
 * setup` and would poison containers if started — while the engineer's own
 * sibling checkout of that same repo usually already holds every value. Copying
 * them is exactly what they would do by hand, so do it for them and say so.
 *
 * Conservative by construction: only keys DECLARED by the contract, only when
 * unset in the target, and only from donor values that are themselves real.
 * Never overwrites an existing value.
 */
export function seedSecretsFromSibling(
  repoName: string,
  repoPath: string,
): SecretsSeedResult | null {
  const check = checkRepoSecrets(repoPath);
  if (!check || check.ok) return null;

  const wanted = new Set([...check.missingKeys, ...check.placeholderKeys]);
  for (const donorPath of otherCheckouts(repoName, repoPath)) {
    const donorFile = path.join(donorPath, SECRETS_FILE);
    if (!fs.existsSync(donorFile)) continue;
    const donor = parseFlatYaml(donorFile);
    if (!donor) continue;

    const fill = new Map<string, string>();
    for (const key of wanted) {
      const raw = donor[key];
      const text = raw == null ? "" : String(raw).trim();
      if (text === "" || PLACEHOLDER_RE.test(text)) continue;
      fill.set(key, text);
    }
    if (fill.size === 0) continue;

    writeSecretValues(check.secretsPath, check.examplePath, fill);
    return { filled: [...fill.keys()].sort(), donorPath };
  }
  return null;
}

/**
 * Write values into a flat `KEY: VALUE` secrets file, line-wise so the
 * generated `# Used by:` comments and key order survive. Creates the file from
 * the example when absent.
 */
function writeSecretValues(
  secretsPath: string,
  examplePath: string,
  values: Map<string, string>,
): void {
  const source = fs.existsSync(secretsPath) ? secretsPath : examplePath;
  const lines = fs.readFileSync(source, "utf-8").split("\n");
  const remaining = new Map(values);

  const updated = lines.map((line) => {
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*)(.*)$/.exec(line);
    if (!m) return line;
    const key = m[2];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${m[1]}${key}: ${quoteIfNeeded(value)}`;
  });

  // Declared keys the file never listed (e.g. a hand-trimmed file).
  for (const [key, value] of remaining) {
    updated.push(`${key}: ${quoteIfNeeded(value)}`);
  }

  fs.writeFileSync(secretsPath, updated.join("\n"), { mode: 0o600 });
  // `mode` above only applies when the file is CREATED — an existing file keeps
  // its old permissions, so tighten explicitly. This file holds live credentials.
  try {
    fs.chmodSync(secretsPath, 0o600);
  } catch {
    /* best-effort — a read-only FS shouldn't fail the seed */
  }
}

/**
 * Quote values the flat-file readers would otherwise mangle. `up.sh`'s awk
 * strips a trailing ` #…` before unquoting, so a value containing " #" cannot
 * round-trip through that parser at all — left as-is rather than silently
 * corrupted, since real secrets don't contain it.
 */
function quoteIfNeeded(value: string): string {
  if (!/[:#'"]|^\s|\s$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Operator-facing explanation of a failed check. Key names only — never values.
 * Leads with the absolute path because the file lives inside a managed
 * clone, which is not somewhere an engineer would think to look.
 */
export function describeSecretsCheck(
  repoName: string,
  result: SecretsCheckResult,
): string[] {
  const lines: string[] = [];
  const unset = [...result.missingKeys, ...result.placeholderKeys];
  lines.push(
    result.fileMissing
      ? `${repoName}: local secrets file has not been created yet`
      : `${repoName}: ${unset.length} local secret(s) still unset — ${unset.join(", ")}`,
  );
  lines.push(`  file:     ${result.secretsPath}`);
  lines.push(`  declared: ${result.examplePath}`);
  lines.push(
    `  Starting now would initialize containers with placeholder credentials.`,
  );
  lines.push(
    `  A database volume keeps the password it is FIRST created with, so this`,
  );
  lines.push(
    `  is not self-correcting — fill the values in, then run Sync again.`,
  );
  return lines;
}
