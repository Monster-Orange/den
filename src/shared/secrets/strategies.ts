/**
 * The built-in secrets strategies, registered through the generic strategy
 * registry (src/shared/strategies/registry.ts) exactly as a plugin would
 * register one. Each entry is `{ id, kind: "secrets", detect(), capabilities }`.
 *
 * Capabilities:
 *  - `create(cfg)`: the SecretsProvider for this backend;
 *  - `label`: the name people see ("Save to 1Password");
 *  - `cli`: the CLI it needs, for `make setup`'s install step;
 *  - `refComplete(ref)`: whether a configured `secrets.refs.<name>` gives
 *    this backend enough to address a secret;
 *  - `env(cfg, env)`: optional vars this backend gives the processes Den
 *    starts (only 1password: OP_ACCOUNT, from the distribution's config);
 *  - `setup(ctx)`: optional interactive setup (`make <cli>-setup-secrets`).
 */
import * as path from "path";
import { OP_CLI_TIMEOUT_MS } from "../constants.js";
import {
  getStrategy,
  onPath,
  registerStrategy,
  strategyIds,
  type DetectResult,
  type StrategyEntry,
} from "../strategies/registry.js";
import { DopplerProvider } from "./doppler.js";
import { EnvProvider } from "./env.js";
import { NoneProvider } from "./none.js";
import { OnePasswordProvider } from "./onepassword.js";
import { parseOpTokenSource } from "./op-token.js";
import type { SecretsConfig } from "./index.js";
import type { SecretRef, SecretsProvider } from "./types.js";

export const SECRETS_KIND = "secrets";

export interface SecretsSetupContext {
  cfg: SecretsConfig;
  provider: SecretsProvider;
  /** Den's package root (its scripts live there). */
  engineRoot: string;
  /** The distribution's CLI name, for remediation lines. */
  cli: string;
  /** Run a command with inherited stdio; its exit code. */
  run(cmd: string, args: string[]): number;
  log(line: string): void;
  error(line: string): void;
}

export interface SecretsCapabilities {
  label: string;
  create(cfg: SecretsConfig): SecretsProvider;
  cli?: { bin: string; formula: string };
  refComplete(ref: Partial<SecretRef>): boolean;
  env?(cfg: SecretsConfig, env: NodeJS.ProcessEnv): Record<string, string>;
  setup?(ctx: SecretsSetupContext): Promise<number>;
}

export type SecretsStrategy = StrategyEntry<
  typeof SECRETS_KIND,
  SecretsCapabilities
>;

const nonEmpty = (v: unknown): boolean =>
  typeof v === "string" && v.trim().length > 0;

/** Flat-key backends address a secret by its key, or an env-shaped field. */
const flatRefComplete = (ref: Partial<SecretRef>): boolean =>
  nonEmpty(ref.key) || nonEmpty(ref.field);

function cliDetect(bin: string, label: string) {
  return (env: NodeJS.ProcessEnv = process.env): DetectResult =>
    onPath(bin, env)
      ? { available: true }
      : { available: false, reason: `${label} CLI (${bin}) is not on PATH` };
}

function otherBackends(): string {
  return (
    "Or pick another backend in the org config (secrets.provider: env | doppler | 1password),\n" +
    "  or for just you in config/local/user.yml."
  );
}

const none: SecretsStrategy = {
  id: "none",
  kind: SECRETS_KIND,
  detect: () => ({
    available: true,
    reason: "no secrets backend configured",
  }),
  capabilities: {
    label: "none",
    create: () => new NoneProvider(),
    refComplete: () => false,
  },
};

const env: SecretsStrategy = {
  id: "env",
  kind: SECRETS_KIND,
  detect: () => ({ available: true }),
  capabilities: {
    label: "environment",
    create: (c) => new EnvProvider(c.keys),
    refComplete: flatRefComplete,
    async setup(ctx) {
      ctx.log(
        "The env backend reads secrets from the process environment.\n" +
          `Export them yourself (direnv, CI secrets, \`doppler run -- ${ctx.cli} up\`).`,
      );
      return 0;
    },
  },
};

const doppler: SecretsStrategy = {
  id: "doppler",
  kind: SECRETS_KIND,
  detect: cliDetect("doppler", "The Doppler"),
  capabilities: {
    label: "Doppler",
    create: (c) => new DopplerProvider({ ...c.doppler, keys: c.keys }),
    cli: { bin: "doppler", formula: "dopplerhq/cli/doppler" },
    refComplete: flatRefComplete,
    async setup(ctx) {
      if (!doppler.detect().available) {
        ctx.error(
          "✗ The Doppler CLI is not installed.\n" +
            `  Install it:  brew install dopplerhq/cli/doppler\n  then re-run: make ${ctx.cli}-setup-secrets\n\n  ` +
            otherBackends(),
        );
        return 1;
      }
      if (!(await ctx.provider.isReady())) {
        ctx.log("→ doppler login");
        if (ctx.run("doppler", ["login"]) !== 0) return 1;
      }
      const scope: string[] = [];
      if (ctx.cfg.doppler?.project)
        scope.push("--project", ctx.cfg.doppler.project);
      if (ctx.cfg.doppler?.config)
        scope.push("--config", ctx.cfg.doppler.config);
      ctx.log(`→ doppler setup ${scope.join(" ")}`.trim());
      if (
        ctx.run("doppler", ["setup", "--no-interactive", ...scope]) !== 0 &&
        scope.length === 0
      ) {
        ctx.run("doppler", ["setup"]);
      }
      return 0;
    },
  },
};

const onepassword: SecretsStrategy = {
  id: "1password",
  kind: SECRETS_KIND,
  detect: cliDetect("op", "The 1Password"),
  capabilities: {
    label: "1Password",
    create: (c) =>
      new OnePasswordProvider({
        // From the distribution's config or the engineer's shell; never a
        // built-in account.
        account: c.onepassword?.account,
        // Per machine (user.yml); validated when the config is read.
        tokenSource:
          c.onepassword?.token === undefined
            ? undefined
            : parseOpTokenSource(c.onepassword.token),
        timeoutMs: OP_CLI_TIMEOUT_MS,
      }),
    cli: { bin: "op", formula: "1password-cli" },
    refComplete: (ref) => nonEmpty(ref.item) && nonEmpty(ref.field),
    env(c, e): Record<string, string> {
      const account = c.onepassword?.account?.trim() || e.OP_ACCOUNT?.trim();
      return account ? { OP_ACCOUNT: account } : {};
    },
    async setup(ctx) {
      if (!onepassword.detect().available) {
        ctx.error(
          "✗ The 1Password CLI (op) is not installed.\n" +
            `  Install it:  brew install 1password-cli\n\n  ` +
            otherBackends(),
        );
        return 1;
      }
      return ctx.run(path.join(ctx.engineRoot, "node_modules", ".bin", "tsx"), [
        path.join(ctx.engineRoot, "scripts", "setup-1password.ts"),
      ]);
    },
  },
};

for (const s of [none, env, doppler, onepassword]) registerStrategy(s);

/** The registered secrets strategy `id`, or undefined. */
export function secretsStrategy(id: string): SecretsStrategy | undefined {
  return getStrategy<typeof SECRETS_KIND, SecretsCapabilities>(
    SECRETS_KIND,
    id,
  );
}

/** Every registered secrets strategy id. */
export function secretsStrategyIds(): string[] {
  return strategyIds(SECRETS_KIND);
}
