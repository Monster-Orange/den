/**
 * configure-aws-profiles
 *
 * Interactively maps den environments to AWS CLI profiles.
 * Writes the selection to config/local/aws-profiles.json (gitignored).
 *
 * Usage:
 *   make aws-configure
 *   npx tsx src/scripts/configure-aws-profiles.ts
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import inquirer from "inquirer";
import type { Environment } from "../shared/types/index.js";
import { getDistRoot } from "../shared/paths.js";

import { product } from "../shared/product.js";
import { plural } from "../shared/plural.js";
// Den-root anchored: WRITES config/local/aws-profiles.json, and the reader
// (shared/environment/aws-profiles.ts) already anchors at getDistRoot().
const ROOT = getDistRoot();
const CONFIG_DIR = path.join(ROOT, "config", "local");
const PROFILES_FILE = path.join(CONFIG_DIR, "aws-profiles.json");

/** Environments that may need AWS credentials (local uses Docker). */
const AWS_ENVS: Environment[] = ["dev", "sandbox", "staging", "production"];

function listAwsProfiles(): string[] {
  try {
    const out = execSync("aws configure list-profiles", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  console.log(`\n  ${product().cli} · Configure AWS Profiles\n`);
  console.log("  Maps each environment to an AWS CLI profile used for");
  console.log("  CloudWatch log streaming, health checks, and re-auth.\n");

  const profiles = listAwsProfiles();

  if (!profiles.length) {
    console.log(
      "  ⚠  No AWS profiles found. Run 'aws configure' or set up AWS SSO first.\n",
    );
    console.log(
      "  You can still save an empty config and re-run later with: make aws-configure\n",
    );
  } else {
    console.log(
      `  Found ${plural(profiles.length, "profile")}: ${profiles.join(", ")}\n`,
    );
  }

  // Load existing config
  let existing: Partial<Record<Environment, string>> = {};
  if (fs.existsSync(PROFILES_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
      console.log("  Current config:");
      for (const [env, profile] of Object.entries(existing)) {
        console.log(`    ${env.padEnd(12)} → ${profile}`);
      }
      console.log("");
    } catch {
      /* start fresh */
    }
  }

  const choices = [
    { name: "(none — skip this environment)", value: "" },
    ...profiles.map((p) => ({ name: p, value: p })),
  ];

  const questions = AWS_ENVS.map((env) => ({
    type: "list" as const,
    name: env,
    message: `AWS profile for ${env}:`,
    choices,
    default: existing[env] ?? "",
  }));

  const answers = await inquirer.prompt<Record<Environment, string>>(questions);

  // Build result, dropping empty selections
  const result: Partial<Record<Environment, string>> = {};
  for (const env of AWS_ENVS) {
    if (answers[env]) result[env] = answers[env];
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(result, null, 2) + "\n");

  console.log("\n  Saved to config/local/aws-profiles.json");
  if (Object.keys(result).length) {
    for (const [env, profile] of Object.entries(result)) {
      console.log(`    ${env.padEnd(12)} → ${profile}`);
    }
  } else {
    console.log("    (no profiles configured)");
  }
  console.log("\n  Re-run any time with: make aws-configure\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
