/**
 * Backend-agnostic developer-secrets setup.
 *
 * Dispatches to the `setup` capability of the strategy selected by
 * `secrets.provider` in the org config (override: DEN_SECRETS_PROVIDER or
 * config/local/user.yml). See src/shared/secrets/strategies.ts.
 *
 * Usage:
 *   make den-setup-secrets                 — interactive setup
 *   npx tsx scripts/setup-secrets.ts --check    — non-interactive; exit 0 when ready
 *   npx tsx scripts/setup-secrets.ts --cli      — print "<provider> <binary> <formula>"
 *   npx tsx scripts/setup-secrets.ts --provider — print the selected strategy id
 *   npx tsx scripts/setup-secrets.ts --gate     — the up / web gate: passes
 *                                                 silently unless secrets.required
 *                                                 is true, then like --check
 *
 * With `secrets.provider: none` there is nothing to set up: it says so and
 * exits 0.
 */
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import {
  getSecretsProvider,
  readSecretsConfig,
  resolveProvider,
  strategyFor,
} from "../src/shared/secrets/index.js";

import { envKey, product } from "../src/shared/product.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const gate = process.argv.includes("--gate");

function run(cmd: string, args: string[]): number {
  return spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT }).status ?? 1;
}

const NONE_MESSAGE =
  "No secrets backend is configured (secrets.provider: none), so there is nothing to set up.\n" +
  `To use one, set secrets.provider (doppler | 1password | env) and secrets.refs.<name> in ${product().configFile}.`;

async function main(): Promise<number> {
  const cfg = readSecretsConfig();
  const resolved = resolveProvider(cfg);
  const strategy = strategyFor(resolved.name);
  const label = `secrets backend: ${resolved.name}`;

  // `--provider`: print the selected strategy id (make reads it to offer
  // backend-specific targets). Never probes the backend.
  if (process.argv.includes("--provider")) {
    console.log(resolved.name);
    return 0;
  }

  // `--cli`: print "<provider> <binary> <brew formula>" for make setup's
  // install step ("<provider> - -" when the backend needs no CLI). An unset
  // provider needs nothing installed until something asks for a secret.
  if (process.argv.includes("--cli")) {
    const cli = resolved.implicit ? undefined : strategy.capabilities.cli;
    console.log(`${resolved.name} ${cli?.bin ?? "-"} ${cli?.formula ?? "-"}`);
    return 0;
  }

  // The up / web gate: only a distribution that requires its backend
  // (secrets.required) is checked. Nothing required: pass, silently, whatever
  // the provider; a feature that needs a secret reports it when it asks.
  if (gate && !cfg.required) return 0;

  if (check || gate) {
    if (resolved.name === "none" || (resolved.implicit && !cfg.required)) {
      if (resolved.name === "none")
        console.log(`  ✓ ${NONE_MESSAGE.split("\n")[0]}`);
      return 0;
    }
    const r = await getSecretsProvider().preflight();
    if (r.ok) return 0;
    console.error(chalk.red(`✗ ${label}\n${r.message ?? ""}`));
    return 1;
  }

  const setup = strategy.capabilities.setup;
  if (resolved.name === "none" || !setup) {
    console.log(NONE_MESSAGE);
    return 0;
  }
  if (resolved.implicit && !cfg.required) {
    // Nothing chose a backend and nothing requires one: no store to set up.
    console.log(
      "secrets.provider is not set, so there is nothing to set up.\n" +
        `To use a backend, set secrets.provider (doppler | 1password | env | none) in ${product().configFile}.`,
    );
    return 0;
  }
  console.log(
    chalk.bold(`\n${product().title} developer secrets (${label})\n`),
  );
  const provider = getSecretsProvider();
  const code = await setup({
    cfg,
    provider,
    engineRoot: ROOT,
    cli: product().cli,
    run,
    log: (l) => console.log(l),
    error: (l) => console.error(chalk.red(l)),
  });
  if (code !== 0) return code;
  const r = await provider.preflight();
  console.log(
    r.ok ? chalk.green(`✓ ${label} ready`) : chalk.red(`✗ ${r.message}`),
  );
  if (!r.ok)
    console.log(
      `  Or for one shell: ${envKey("SECRETS_PROVIDER")}=none make web`,
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
