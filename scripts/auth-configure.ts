/**
 * Per-engineer admin 1Password setup — for environments with no shared admin.
 *
 * Environments where the org config declares a shared admin account
 * (`test_accounts.roles.admin`, optionally limited by its `environments`)
 * need no setup.
 *
 * Elsewhere you need a personal account with admin access. This script lets
 * you point the test pillars at your own 1Password item for those envs.
 *
 * Saves config/local/admin-auth[-{env}].json  (gitignored — no password stored)
 *
 * Usage:
 *   make auth-configure env=staging     # your personal staging admin account
 *   make auth-configure env=production  # your personal production admin account
 */

import { execFile, spawnSync } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { OP_ACCOUNT_DEFAULT } from "../src/shared/constants.js";
import {
  readTestAccountsConfig,
  testAccountsVault,
} from "../src/shared/auth/test-accounts.js";

// Ensure op invocations hit the den-owned account even when this script is
// run directly via `npx tsx` (not through make, which already exports OP_ACCOUNT).
process.env.OP_ACCOUNT ||= OP_ACCOUNT_DEFAULT;

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 1Password types ──────────────────────────────────────────────────────────

interface OpVault {
  id: string;
  name: string;
}

interface OpItem {
  id: string;
  title: string;
  category: string;
}

interface OpField {
  id: string;
  label: string;
  value?: string;
  type: string;
  purpose?: string;
}

interface OpItemDetail {
  id: string;
  title: string;
  fields?: OpField[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function opJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("op", [...args, "--format=json"]);
  return JSON.parse(stdout) as T;
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function pickFromList<T>(
  rl: readline.Interface,
  items: T[],
  getLabel: (item: T) => string,
  question: string,
): Promise<T> {
  items.forEach((item, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${getLabel(item)}`);
  });
  console.log();
  let selected: T | undefined;
  do {
    const answer = await prompt(rl, question);
    const n = parseInt(answer.trim(), 10);
    if (n >= 1 && n <= items.length) {
      selected = items[n - 1];
    } else {
      console.log(`  Enter a number between 1 and ${items.length}`);
    }
  } while (selected === undefined);
  return selected;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/** The org's shared admin item (test_accounts.roles.admin), offered first. */
function sharedAdminDefault():
  | { vault: string; item: string; field: string }
  | undefined {
  const cfg = readTestAccountsConfig();
  const admin = cfg.roles?.admin;
  if (!admin?.item) return undefined;
  return {
    vault: admin.vault ?? testAccountsVault(cfg),
    item: admin.item,
    field: admin.field ?? "password",
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const environment = process.env.E2E_ENVIRONMENT;
  const configFilename = environment
    ? `admin-auth-${environment}.json`
    : "admin-auth.json";
  const configScope = environment
    ? `environment: ${environment}`
    : "all environments (generic fallback)";

  console.log();
  console.log("🔐 Admin 1Password Configuration");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Scope:  ${configScope}`);
  console.log(
    `Saves config/local/${configFilename} (gitignored — no password stored).`,
  );

  if (environment === "production") {
    console.log();
    console.log(
      "  ⚠  Production: for auditability you may want to use your own personal",
    );
    console.log(
      "     admin credentials rather than a shared account, so that actions in",
    );
    console.log("     the environment are traceable to you specifically.");
    console.log();
    console.log(
      "     Select a vault and item that has your personal admin account email",
    );
    console.log("     and password for production saved in 1Password.");
  }

  console.log();

  // ── Check op is installed ────────────────────────────────────────────────
  try {
    await execFileAsync("op", ["--version"]);
  } catch {
    console.error("❌ 1Password CLI (op) not found.");
    console.error("   Install it: brew install 1password-cli");
    process.exit(1);
  }

  // ── Check signed in (auto-sign-in if not) ───────────────────────────────
  try {
    await execFileAsync("op", ["whoami"]);
  } catch {
    console.log("🔐 Not signed in to 1Password — signing in now...");
    const result = spawnSync("op", ["signin"], { stdio: "inherit" });
    if (result.status !== 0) {
      console.error("❌ 1Password sign-in failed.");
      process.exit(1);
    }
    // Verify it worked
    try {
      await execFileAsync("op", ["whoami"]);
    } catch {
      console.error("❌ Still not signed in after op signin.");
      process.exit(1);
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // ── Step 1: Select vault ────────────────────────────────────────────────
    console.log("Fetching vaults...");
    const vaults = await opJson<OpVault[]>(["vault", "list"]);
    if (vaults.length === 0) {
      console.error("❌ No vaults found.");
      process.exit(1);
    }

    // Offer the org's shared admin item (if configured) before the full picker
    const SHARED_ADMIN = sharedAdminDefault();
    if (SHARED_ADMIN) {
      const defaultVault = vaults.find((v) => v.name === SHARED_ADMIN.vault);
      if (defaultVault) {
        console.log(`  Default: ${SHARED_ADMIN.vault} / ${SHARED_ADMIN.item}`);
        const answer = await prompt(rl, "  Use this default? (Y/n): ");
        if (answer.trim().toLowerCase() !== "n") {
          const allItems = await opJson<OpItem[]>([
            "item",
            "list",
            "--vault",
            defaultVault.id,
          ]);
          const defaultItem = allItems.find(
            (i) => i.title === SHARED_ADMIN.item,
          );
          if (defaultItem) {
            const detail = await opJson<OpItemDetail>([
              "item",
              "get",
              defaultItem.id,
              "--vault",
              defaultVault.id,
            ]);
            const fields = detail.fields ?? [];
            const passwordField = fields.find(
              (f) => f.label === SHARED_ADMIN.field,
            );
            const emailField = fields.find(
              (f) =>
                f.purpose === "USERNAME" ||
                f.type === "EMAIL" ||
                f.label?.toLowerCase() === "username" ||
                f.label?.toLowerCase() === "email",
            );
            if (passwordField && emailField?.value) {
              const opRef = `op://${defaultVault.name}/${defaultItem.title}/${passwordField.label}`;
              const email = emailField.value;
              const configDir = path.resolve(__dirname, "../config/local");
              fs.mkdirSync(configDir, { recursive: true });
              fs.writeFileSync(
                path.join(configDir, configFilename),
                JSON.stringify(
                  {
                    email,
                    opRef,
                    itemId: defaultItem.id,
                    vaultId: defaultVault.id,
                    fieldLabel: passwordField.label,
                  },
                  null,
                  2,
                ) + "\n",
              );
              console.log();
              console.log(
                `✅ Admin config saved → config/local/${configFilename}`,
              );
              console.log(`   scope:  ${configScope}`);
              console.log(`   email:  ${email}`);
              console.log(`   opRef:  ${opRef}`);
              console.log();
              console.log(`Run tests: make test-syn-basic env=${environment}`);
              return;
            }
          }
          console.log(
            "  Default item not found — falling back to manual selection.",
          );
          console.log();
        }
      }
    }

    console.log();
    console.log("Select vault:");
    const vault = await pickFromList(
      rl,
      vaults,
      (v) => v.name,
      "Vault number: ",
    );

    // ── Step 2: Select item ─────────────────────────────────────────────────
    console.log();
    console.log(`Fetching items from "${vault.name}"...`);
    const allItems = await opJson<OpItem[]>([
      "item",
      "list",
      "--vault",
      vault.id,
    ]);

    // Prefer Login items, but show all if none; sort alphabetically
    const loginItems = allItems.filter((i) => i.category === "LOGIN");
    const items = (loginItems.length > 0 ? loginItems : allItems).sort((a, b) =>
      a.title.localeCompare(b.title),
    );

    if (items.length === 0) {
      console.error(`❌ No items found in vault "${vault.name}".`);
      process.exit(1);
    }
    console.log();
    console.log("Select item:");
    const item = await pickFromList(rl, items, (i) => i.title, "Item number: ");

    // ── Step 3: Inspect fields ──────────────────────────────────────────────
    console.log();
    console.log(`Fetching fields for "${item.title}"...`);
    const detail = await opJson<OpItemDetail>([
      "item",
      "get",
      item.id,
      "--vault",
      vault.id,
    ]);

    const fields = detail.fields ?? [];

    // Detect email from USERNAME / EMAIL fields
    const emailField = fields.find(
      (f) =>
        f.purpose === "USERNAME" ||
        f.type === "EMAIL" ||
        f.label?.toLowerCase() === "username" ||
        f.label?.toLowerCase() === "email",
    );

    // Find secret fields for the op:// reference
    const secretFields = fields.filter(
      (f) => f.type === "CONCEALED" || f.purpose === "PASSWORD",
    );

    let passwordField: OpField | undefined;
    if (secretFields.length === 1) {
      passwordField = secretFields[0];
    } else if (secretFields.length > 1) {
      console.log();
      console.log("Select password field:");
      passwordField = await pickFromList(
        rl,
        secretFields,
        (f) => f.label,
        "Field number: ",
      );
    } else {
      // Fallback: show all fields
      console.log();
      console.log("No password field detected. Select the credential field:");
      const allNamed = fields.filter((f) => f.label);
      passwordField = await pickFromList(
        rl,
        allNamed,
        (f) => `${f.label} (${f.type})`,
        "Field number: ",
      );
    }

    if (!passwordField) {
      console.error("❌ No field selected.");
      process.exit(1);
    }

    const opRef = `op://${vault.name}/${item.title}/${passwordField.label}`;

    // ── Step 4: Confirm / enter email ───────────────────────────────────────
    let email: string;
    console.log();
    if (emailField?.value) {
      const answer = await prompt(rl, `Admin email [${emailField.value}]: `);
      email = answer.trim() || emailField.value;
    } else {
      email = (await prompt(rl, "Admin email (@example.com): ")).trim();
    }

    if (!email) {
      console.error("❌ Email is required.");
      process.exit(1);
    }

    // ── Step 5: Save ────────────────────────────────────────────────────────
    // Store item ID + field label alongside opRef.
    // headless-login.ts uses the IDs (via `op item get`) which is robust against
    // special characters in vault/item names that can break `op read op://...`.
    const configDir = path.resolve(__dirname, "../config/local");
    const configFile = path.join(configDir, configFilename);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify(
        {
          email,
          opRef,
          itemId: item.id,
          vaultId: vault.id,
          fieldLabel: passwordField.label,
        },
        null,
        2,
      ) + "\n",
    );

    console.log();
    console.log(`✅ Admin config saved → config/local/${configFilename}`);
    console.log(`   scope:  ${configScope}`);
    console.log(`   email:  ${email}`);
    console.log(`   opRef:  ${opRef}`);
    console.log();
    const testCmd = environment
      ? `make test-syn-basic env=${environment}`
      : "make test-syn-basic";
    console.log(`Run tests: ${testCmd}`);
  } finally {
    rl.close();
  }
}

main().catch((err: Error) => {
  console.error("❌", err.message);
  process.exit(1);
});
