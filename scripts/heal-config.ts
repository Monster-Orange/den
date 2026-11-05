/**
 * Idempotent heal for `config/den.yml`.
 *
 * Ensures required keys are populated so users upgrading from older den
 * installs — who may have `github_org` commented out or absent — don't end
 * up with silent empty repo lists. Safe to run repeatedly; exits 0 with a
 * single "already healthy" line when nothing needs doing.
 *
 * Runs during `make setup`; also available as `make den-heal-config`.
 *
 * Keys healed:
 *   - github_org — auto-detected from this den checkout's `origin` URL.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

import { product } from "../src/shared/product.js";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, product().configFile);

function detectOrgFromGitRemote(): string | null {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // SSH:   git@github.com:ORG/den.git
    // HTTPS: https://github.com/ORG/den.git
    //        https://github.com/ORG/den
    const m = url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function main(): void {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      `  ✗ ${CONFIG_PATH} not found — are you in the ${product().cli} repo root?`,
    );
    process.exit(1);
  }

  const content = fs.readFileSync(CONFIG_PATH, "utf-8");

  // Already set (uncommented line with a non-empty value) → no-op.
  const activeMatch = content.match(/^github_org:\s*(\S+)/m);
  if (activeMatch) {
    console.log(`  ✓ github_org already set to ${activeMatch[1]}`);
    return;
  }

  const detected = detectOrgFromGitRemote();
  if (!detected) {
    console.error(
      `  ✗ could not auto-detect github_org from this ${product().cli} checkout's ` +
        `\`remote.origin.url\`. Add \`github_org: <slug>\` to ${product().configFile} ` +
        "manually.",
    );
    process.exit(1);
  }

  let newContent: string;
  if (/^#\s*github_org:/m.test(content)) {
    // Uncomment-and-set the existing commented placeholder, preserving
    // surrounding comments so the file stays readable.
    newContent = content.replace(
      /^#\s*github_org:.*$/m,
      `github_org: ${detected}`,
    );
  } else {
    // No placeholder present — append.
    newContent = content.replace(/\n*$/, "\n") + `github_org: ${detected}\n`;
  }

  fs.writeFileSync(CONFIG_PATH, newContent);
  console.log(
    `  ✓ healed ${product().configFile}: github_org: ${detected} (auto-detected from origin)`,
  );
}

main();
