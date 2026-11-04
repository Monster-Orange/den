/**
 * 1Password Developer API Keys setup.
 *
 * Creates and populates the developer-keys item (OP_DEV_KEYS_ITEM) inside the
 * personal vault (OP_API_KEYS_VAULT), which services can use to inject
 * secrets at `make up` time via `op run --env-file=.env.op`.
 *
 * Which keys to collect is org data: `secrets.developer_keys.fields` in the
 * org config (default: only the keys the engine itself uses), and
 * `secrets.developer_keys.env_file` names a dotenv file whose values are
 * offered as defaults.
 *
 * Usage:
 *   make den-setup-1password          — full interactive setup
 *   npx tsx scripts/setup-1password.ts --check   — non-interactive vault check
 *                                                   exits 0 if ready, 1 if not
 */

import { execFile, spawnSync } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import {
  OP_ACCOUNT_DEFAULT,
  OP_API_KEYS_VAULT,
  OP_DEV_KEYS_ITEM,
} from "../src/shared/constants.js";
import {
  readSecretsConfig,
  type DeveloperKeyDef,
} from "../src/shared/secrets/index.js";

import { product } from "../src/shared/product.js";
// Ensure op invocations hit the den-owned account even when this script is
// run directly via `npx tsx` (not through make, which already exports OP_ACCOUNT).
process.env.OP_ACCOUNT ||= OP_ACCOUNT_DEFAULT;

const execFileAsync = promisify(execFile);

async function opJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("op", [...args, "--format=json"]);
  return JSON.parse(stdout) as T;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEN_ROOT = path.resolve(__dirname, "..");

const VAULT_NAME = OP_API_KEYS_VAULT;
const ITEM_NAME = OP_DEV_KEYS_ITEM;

// ─── .env reader ─────────────────────────────────────────────────────────────

/**
 * Parse a .env file and return key→value pairs.
 * Handles quoted values, inline comments, and blank/comment lines.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip inline comments (unquoted)
    if (!val.startsWith('"') && !val.startsWith("'")) {
      val = val.split(/\s+#/)[0].trim();
    }
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && val) result[key] = val;
  }
  return result;
}

const DEVELOPER_KEYS = readSecretsConfig().developer_keys ?? {};

/**
 * The dotenv file `secrets.developer_keys.env_file` names (relative to the
 * den root), or undefined when none is configured.
 */
const DOTENV_PATH: string | undefined = DEVELOPER_KEYS.env_file
  ? path.resolve(DEN_ROOT, DEVELOPER_KEYS.env_file)
  : undefined;

/** Parsed key→value map of DOTENV_PATH, or {} when absent. */
function loadSourceDotEnv(): Record<string, string> {
  if (!DOTENV_PATH || !fs.existsSync(DOTENV_PATH)) return {};
  return parseEnvFile(DOTENV_PATH);
}

interface SecretDef {
  field: string;
  description: string;
  url: string;
  required: boolean;
}

/** The keys the engine itself uses, when the org config lists none. */
const DEFAULT_SECRETS: DeveloperKeyDef[] = [
  {
    field: "CURSOR_API_KEY",
    description: "Cursor API key  (journeys pillar agent)",
    url: "https://cursor.com/dashboard",
    required: false,
  },
];

const SECRETS: SecretDef[] = (
  DEVELOPER_KEYS.fields?.length ? DEVELOPER_KEYS.fields : DEFAULT_SECRETS
).map((d) => ({
  field: d.field,
  description: d.description ?? "",
  url: d.url ?? "",
  required: d.required === true,
}));

// ─── 1Password types ──────────────────────────────────────────────────────────

interface OpVault {
  id: string;
  name: string;
}

interface OpField {
  id: string;
  label: string;
  value?: string;
  type: string;
}

interface OpItemDetail {
  id: string;
  title: string;
  fields?: OpField[];
}

// ─── Input helpers ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stdin = process.stdin as any;

/** Read a plain echoed line using Node's TTY directly — no subprocess. */
function readLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buf = "";
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        stdin.pause();
        stdin.removeListener("data", onData);
        resolve(buf.slice(0, nl).replace(/\r$/, "").trim());
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Read a secret without echoing characters.
 * Uses Node TTY raw mode — no subprocess, no stty, works through make/npx/tsx.
 * CTRL-C is caught explicitly in raw mode and exits cleanly.
 */
function readSecret(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(promptText);

    // Non-TTY fallback (piped input): read normally
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.resume();
      const onData = (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(buf.slice(0, nl).replace(/\r$/, ""));
        }
      };
      stdin.on("data", onData);
      return;
    }

    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let secret = "";

    const onData = (char: string) => {
      switch (char) {
        case "\r":
        case "\n":
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(secret);
          break;
        case "\u0003": // CTRL-C
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          process.exit(130);
          break;
        case "\u007f": // backspace
        case "\b":
          secret = secret.slice(0, -1);
          break;
        default:
          if (char >= " ") secret += char;
          break;
      }
    };

    stdin.on("data", onData);
  });
}

// ─── 1Password helpers ────────────────────────────────────────────────────────

async function ensureOpInstalled(): Promise<void> {
  try {
    await execFileAsync("op", ["--version"]);
  } catch {
    console.error("❌  1Password CLI (op) not found.");
    console.error("    Install it: brew install 1password-cli");
    process.exit(1);
  }
}

async function ensureSignedIn(): Promise<boolean> {
  try {
    await execFileAsync("op", ["whoami"]);
    return true;
  } catch {
    return false;
  }
}

async function signIn(): Promise<void> {
  console.log("🔐  Not signed in to 1Password — signing in now...");
  const result = spawnSync("op", ["signin"], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("❌  1Password sign-in failed.");
    process.exit(1);
  }
  if (!(await ensureSignedIn())) {
    console.error("❌  Still not signed in after op signin.");
    process.exit(1);
  }
}

async function getVault(name: string): Promise<OpVault | null> {
  try {
    return await opJson<OpVault>(["vault", "get", name]);
  } catch {
    return null;
  }
}

async function getItem(vaultName: string): Promise<OpItemDetail | null> {
  try {
    return await opJson<OpItemDetail>([
      "item",
      "get",
      ITEM_NAME,
      "--vault",
      vaultName,
    ]);
  } catch {
    return null;
  }
}

function fieldValue(item: OpItemDetail, fieldName: string): string {
  return (
    item.fields?.find(
      (f) => f.label === fieldName || f.id === fieldName.toLowerCase(),
    )?.value ?? ""
  );
}

// ─── Check mode ───────────────────────────────────────────────────────────────

/**
 * Non-interactive check used by make web / make den-up.
 *
 * Signs in automatically if the CLI session has expired — that is NOT a reason
 * to run full setup. Only exits 1 (triggering setup) when the vault, item, or
 * required fields are genuinely missing.
 */
async function checkMode(): Promise<void> {
  try {
    await execFileAsync("op", ["--version"]);
  } catch {
    console.error("1password-cli not installed");
    process.exit(1);
  }

  // Session expired → sign in interactively, then proceed with the check.
  // This is NOT a setup failure — the vault may already be fully configured.
  if (!(await ensureSignedIn())) {
    console.log("🔐  1Password session expired — signing in...");
    const result = spawnSync("op", ["signin"], { stdio: "inherit" });
    if (result.status !== 0 || !(await ensureSignedIn())) {
      console.error("1Password sign-in failed");
      process.exit(1);
    }
  }

  if (!(await getVault(VAULT_NAME))) {
    console.error(
      `vault "${VAULT_NAME}" not found — run: make ${product().cli}-setup-1password`,
    );
    process.exit(1);
  }

  const item = await getItem(VAULT_NAME);
  if (!item) {
    console.error(
      `item "${ITEM_NAME}" not found — run: make ${product().cli}-setup-1password`,
    );
    process.exit(1);
  }

  const missing = SECRETS.filter(
    (s) => s.required && !fieldValue(item, s.field),
  );
  if (missing.length > 0) {
    console.error(
      `required fields not set (${missing.map((s) => s.field).join(", ")}) — run: make ${product().cli}-setup-1password`,
    );
    process.exit(1);
  }

  process.exit(0);
}

// ─── Setup mode ───────────────────────────────────────────────────────────────

async function setupMode(): Promise<void> {
  console.log();
  console.log("🔑  1Password Developer API Keys Setup");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    `Creates item "${ITEM_NAME}" in vault "${VAULT_NAME}" with your API keys.`,
  );
  console.log(
    "These are resolved at `make up` time via `op run` — keys never touch disk.",
  );
  console.log();

  await ensureOpInstalled();

  if (!(await ensureSignedIn())) {
    await signIn();
  } else {
    const { stdout } = await execFileAsync("op", ["whoami"]);
    console.log(`✓  Signed in as ${stdout.trim().split("\n")[0]}`);
  }
  console.log();

  // ── Vault ───────────────────────────────────────────────────────────────
  const vault = await getVault(VAULT_NAME);
  if (!vault) {
    console.error(`❌  Vault "${VAULT_NAME}" not found in 1Password.`);
    console.error(
      "    Ask your team admin to ensure the vault exists and you have access.",
    );
    process.exit(1);
  }
  console.log(`✓  Vault "${VAULT_NAME}" found`);
  console.log();

  // ── Item ─────────────────────────────────────────────────────────────────
  let item = await getItem(VAULT_NAME);
  if (item) {
    console.log(`✓  Item "${ITEM_NAME}" already exists`);
  } else {
    console.log(`  Creating item "${ITEM_NAME}"...`);
    const fieldArgs = SECRETS.map((s) => `${s.field}[password]=`);
    item = await opJson<OpItemDetail>([
      "item",
      "create",
      "--category=login",
      `--title=${ITEM_NAME}`,
      `--vault=${VAULT_NAME}`,
      ...fieldArgs,
    ]);
    console.log(`✓  Item "${ITEM_NAME}" created`);
  }
  console.log();

  // ── Fill fields ──────────────────────────────────────────────────────────
  const sourceEnv = loadSourceDotEnv();
  const sourceEnvLabel = DOTENV_PATH
    ? path.relative(DEN_ROOT, DOTENV_PATH)
    : "";
  const sourceEnvExists = DOTENV_PATH ? fs.existsSync(DOTENV_PATH) : false;

  console.log("Fill in your API keys. Press Enter to skip a field.");
  console.log();

  // Show .env source check once up front
  if (sourceEnvExists) {
    console.log(
      `  ${chalk.green("✓")} ${sourceEnvLabel} found — will offer matching values`,
    );
  } else if (DOTENV_PATH) {
    console.log(
      `  ${chalk.red("✗")} ${sourceEnvLabel} not found — enter keys manually`,
    );
  }
  console.log();

  let anyUpdated = false;
  for (const secret of SECRETS) {
    const current = fieldValue(item, secret.field);
    const sourceVal = sourceEnv[secret.field];
    const envVal = process.env[secret.field];
    const tag = secret.required ? " (required)" : " (optional)";
    const status = current ? " " + chalk.green("✓") + " set" : "";

    console.log(`  ${chalk.bold(secret.field)}${chalk.dim(tag)}${status}`);
    console.log(`  ${chalk.dim(secret.description)}`);
    if (secret.url) console.log(`  ${chalk.dim(secret.url)}`);

    // Per-field source checks
    console.log(
      (DOTENV_PATH
        ? `  ${sourceEnvLabel}: ${sourceVal ? chalk.green("✓ found") : chalk.dim("✗ not set")}  `
        : "  ") +
        `shell env: ${envVal ? chalk.green("✓ found") : chalk.dim("✗ not set")}`,
    );

    // Track the value we will save (null = nothing to save, keep current).
    let valueToSave: string | null = null;

    // Priority 1: the configured dotenv file
    if (sourceVal) {
      const answer = (
        await readLine(`  Use value from ${sourceEnvLabel}? (Y/n): `)
      )
        .trim()
        .toLowerCase();
      if (!answer || answer === "y") {
        valueToSave = sourceVal;
      }
    }

    // Priority 2: host environment variable
    if (valueToSave === null && envVal) {
      const answer = (
        await readLine("  Use value from shell environment? (Y/n): ")
      )
        .trim()
        .toLowerCase();
      if (!answer || answer === "y") {
        valueToSave = envVal;
      }
    }

    // Priority 3: manual entry
    if (valueToSave === null) {
      const raw = (await readSecret("  Value (Enter to skip): ")).trim();
      if (raw) valueToSave = raw;
    }

    if (valueToSave === null) {
      if (!current && secret.required) {
        console.log(
          "  ⚠️   Skipped — fill this in before `make up` will work.\n",
        );
      } else {
        console.log("  → keeping existing value\n");
      }
      continue;
    }

    await execFileAsync("op", [
      "item",
      "edit",
      ITEM_NAME,
      "--vault",
      VAULT_NAME,
      `${secret.field}[password]=${valueToSave}`,
    ]);
    console.log("  ✓  saved\n");
    anyUpdated = true;
  }

  // ── Verify ───────────────────────────────────────────────────────────────
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Verifying...");
  console.log();

  const updatedItem = (await getItem(VAULT_NAME))!;
  let allRequired = true;

  for (const secret of SECRETS) {
    const val = fieldValue(updatedItem, secret.field);
    if (val) {
      console.log(`  ✓  ${secret.field}`);
    } else if (secret.required) {
      console.log(`  ✗  ${secret.field}  ← required, not set`);
      allRequired = false;
    } else {
      console.log(`  –  ${secret.field}  (optional, not set)`);
    }
  }

  console.log();
  if (allRequired) {
    console.log(
      `✅  Setup complete. \`make ${product().cli}-up\` will inject secrets automatically.`,
    );
  } else {
    console.log("⚠️   Setup incomplete — required fields are missing.");
    console.log(
      `    Run \`make ${product().cli}-setup-1password\` again to fill them in.`,
    );
  }

  if (anyUpdated) {
    console.log();
    console.log(
      "💡  Reminder: ensure 1Password CLI integration is enabled in the app:",
    );
    console.log(
      "    1Password.app → Settings → Developer → Integrate with 1Password CLI",
    );
  }
  console.log();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const isCheck = process.argv.includes("--check");

if (isCheck) {
  checkMode().catch(() => process.exit(1));
} else {
  setupMode().catch((err: Error) => {
    console.error("❌ ", err.message);
    process.exit(1);
  });
}
