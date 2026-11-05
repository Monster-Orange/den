/**
 * Backend-agnostic developer-secrets setup.
 *
 * Dispatches to the strategy selected by `secrets.provider` in
 * config/den.yml (override: DEN_SECRETS_PROVIDER or
 * config/local/user.yml). See src/shared/secrets.
 *
 * Usage:
 *   make den-setup-secrets                 — interactive setup
 *   npx tsx scripts/setup-secrets.ts --check    — non-interactive; exit 0 when ready
 *   npx tsx scripts/setup-secrets.ts --cli      — print "<provider> <binary> <formula>"
 *   npx tsx scripts/setup-secrets.ts --gate     — like --check, but a backend that
 *                                                 is not ready only warns unless
 *                                                 secrets.required is true
 */
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import {
  getSecretsProvider,
  readSecretsConfig,
} from "../src/shared/secrets/index.js";

import { envKey, product } from "../src/shared/product.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const gate = process.argv.includes("--gate");

function run(cmd: string, args: string[]): number {
  return spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT }).status ?? 1;
}

function installed(cmd: string): boolean {
  return !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
}

const INSTALL: Record<string, string> = {
  doppler: "brew install dopplerhq/cli/doppler",
  op: "brew install 1password-cli",
};

function otherBackends(current: string): string {
  return (
    "Or pick another backend for just you (config/local/user.yml):\n" +
    "    secrets:\n" +
    `      provider: env        # or 1password / doppler (team default: ${current})\n` +
    `  or for one shell: ${envKey("SECRETS_PROVIDER")}=env make web`
  );
}

async function main(): Promise<number> {
  const provider = getSecretsProvider();
  const cfg = readSecretsConfig();
  const label = `secrets backend: ${provider.name}`;

  // `--cli`: print "<provider> <binary> <brew formula>" for make setup's
  // install step ("env -" when the backend needs no CLI).
  if (process.argv.includes("--cli")) {
    const bin =
      provider.name === "doppler"
        ? "doppler"
        : provider.name === "1password"
          ? "op"
          : "";
    const formula = bin ? INSTALL[bin].replace(/^brew install /, "") : "";
    console.log(`${provider.name} ${bin || "-"} ${formula || "-"}`);
    return 0;
  }

  if (check || gate) {
    const r = await provider.preflight();
    if (r.ok) return 0;
    if (gate && !cfg.required) {
      // Signed in but no default scope: secret_env refs name their own
      // (<project>/<config>/<key>), so only the engine's own secrets lack one.
      if (await provider.isReady()) {
        console.error(
          chalk.gray(
            `   ${label}: signed in, no default scope set (secret_env refs still resolve;` +
              ` test logins and the saved sudo password need one: \`make ${product().cli}-setup-secrets\`).`,
          ),
        );
        return 0;
      }
      console.error(
        chalk.yellow(
          `⚠️  ${label} is not ready — continuing.\n` +
            "   Test logins and the saved sudo password need it; run " +
            `\`make ${product().cli}-setup-secrets\` when you want them.`,
        ),
      );
      return 0;
    }
    console.error(chalk.red(`✗ ${label}\n${r.message ?? ""}`));
    return 1;
  }

  console.log(
    chalk.bold(`\n${product().title} developer secrets (${label})\n`),
  );
  switch (provider.name) {
    case "doppler": {
      if (!installed("doppler")) {
        console.error(
          chalk.red("✗ The Doppler CLI is not installed.\n") +
            `  Install it:  ${INSTALL.doppler}\n  then re-run: make ${product().cli}-setup-secrets\n\n  ` +
            otherBackends(provider.name),
        );
        return 1;
      }
      if (!(await provider.isReady())) {
        console.log("→ doppler login");
        if (run("doppler", ["login"]) !== 0) return 1;
      }
      const scope: string[] = [];
      if (cfg.doppler?.project) scope.push("--project", cfg.doppler.project);
      if (cfg.doppler?.config) scope.push("--config", cfg.doppler.config);
      console.log(`→ doppler setup ${scope.join(" ")}`.trim());
      if (
        run("doppler", ["setup", "--no-interactive", ...scope]) !== 0 &&
        scope.length === 0
      ) {
        run("doppler", ["setup"]);
      }
      break;
    }
    case "1password":
      if (!installed("op")) {
        console.error(
          chalk.red("✗ The 1Password CLI (op) is not installed.\n") +
            `  Install it:  ${INSTALL.op}\n\n  ` +
            otherBackends(provider.name),
        );
        return 1;
      }
      return run(path.join(ROOT, "node_modules", ".bin", "tsx"), [
        path.join(ROOT, "scripts", "setup-1password.ts"),
      ]);
    case "env":
      console.log(
        "The env backend reads secrets from the process environment.\n" +
          `Export them yourself (direnv, CI secrets, \`doppler run -- ${product().cli} up\`).`,
      );
      break;
  }
  const r = await provider.preflight();
  console.log(
    r.ok ? chalk.green(`✓ ${label} ready`) : chalk.red(`✗ ${r.message}`),
  );
  return r.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
