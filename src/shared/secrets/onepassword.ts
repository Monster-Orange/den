/**
 * 1Password strategy — reads/writes item fields with the `op` CLI.
 * Selected with `secrets.provider: 1password`.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { PreflightResult, SecretRef, SecretsProvider } from "./types.js";
import {
  DEFAULT_OP_TOKEN_SOURCE,
  OP_TOKEN_ENV,
  OpFailure,
  mapOpFailure,
  readOpToken,
  type OpTokenDeps,
  type OpTokenSource,
} from "./op-token.js";

import { product } from "../product.js";
const execFileAsync = promisify(execFile);

export interface OnePasswordOptions {
  account?: string;
  /**
   * Where the service-account token comes from (`secrets.onepassword.token`).
   * Unset: the default `env:OP_SERVICE_ACCOUNT_TOKEN`, and `op` is run with
   * this process's own env even when that has none (a signed-in desktop app
   * still works).
   */
  tokenSource?: OpTokenSource;
  /** Test seam: the env, platform and home the token source is read with. */
  tokenDeps?: OpTokenDeps;
  timeoutMs?: number;
}

export class OnePasswordProvider implements SecretsProvider {
  readonly name = "1password" as const;
  private readonly timeout: number;
  private readonly tokenSource: OpTokenSource | undefined;
  private readonly tokenDeps: OpTokenDeps | undefined;

  constructor(opts: OnePasswordOptions = {}) {
    this.timeout = opts.timeoutMs ?? 60_000;
    this.tokenSource = opts.tokenSource;
    this.tokenDeps = opts.tokenDeps;
    if (opts.account) process.env.OP_ACCOUNT ||= opts.account;
  }

  /**
   * The options for one `op` call. The token is read now (never cached) and
   * goes only into the child's env. A configured source that yields none
   * fails with its reason; the default source with no token runs `op` as
   * before.
   */
  private async opOptions(): Promise<{
    timeout: number;
    env?: NodeJS.ProcessEnv;
    token?: string;
  }> {
    const explicit = this.tokenSource !== undefined;
    const t = await readOpToken(
      this.tokenSource ?? DEFAULT_OP_TOKEN_SOURCE,
      this.tokenDeps,
    );
    if (!t.ok) {
      if (explicit) throw new OpFailure("token_source", t.reason);
      return { timeout: this.timeout, env: process.env };
    }
    return {
      timeout: this.timeout,
      env: { ...process.env, [OP_TOKEN_ENV]: t.token },
      token: t.token,
    };
  }

  /** Run `op`; a failure carries op's reason in plain words, never the token. */
  private async run(args: string[], rawErrors = false): Promise<string> {
    const { token, ...opts } = await this.opOptions();
    try {
      const { stdout } = await execFileAsync("op", args, opts);
      return String(stdout);
    } catch (err) {
      // `set` keeps op's own error: its caller strips the value it wrote.
      if (rawErrors) throw err;
      const e = err as { stderr?: unknown; killed?: boolean; code?: unknown };
      if (e.killed)
        throw new OpFailure("unknown", "1Password failed: op timed out");
      if (e.code === "ENOENT")
        throw new OpFailure("unknown", "1Password failed: op is not installed");
      const m = mapOpFailure(String(e.stderr ?? ""), token ? [token] : []);
      throw new OpFailure(m.code, m.text);
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.run(["whoami"]);
      return true;
    } catch {
      return false;
    }
  }

  async get(ref: SecretRef): Promise<string> {
    // Direct CLI args rather than an op:// URI — URIs break on "(" "," etc.
    const args = ["item", "get", ref.item];
    if (ref.vault) args.push("--vault", ref.vault);
    args.push("--fields", `label=${ref.field}`, "--reveal");
    return (await this.run(args)).trim();
  }

  async tryGet(ref: SecretRef): Promise<string | null> {
    return (await this.tryGetWithReason(ref)).value;
  }

  async tryGetWithReason(
    ref: SecretRef,
  ): Promise<{ value: string | null; reason?: string }> {
    try {
      const v = await this.get(ref);
      return v.length > 0
        ? { value: v }
        : { value: null, reason: "the field is empty" };
    } catch (err) {
      return {
        value: null,
        reason: err instanceof OpFailure ? err.message : undefined,
      };
    }
  }

  /** Overwrite the field; an item that isn't there yet is created (a Password item). */
  async set(ref: SecretRef, value: string): Promise<void> {
    const vault = ref.vault ? ["--vault", ref.vault] : [];
    const field = `${ref.field}[password]=${value}`;
    try {
      await this.run(["item", "edit", ref.item, ...vault, field], true);
    } catch (err) {
      try {
        await this.run(
          [
            "item",
            "create",
            "--category",
            "password",
            "--title",
            ref.item,
            ...vault,
            field,
          ],
          true,
        );
      } catch {
        throw err;
      }
    }
  }

  async preflight(): Promise<PreflightResult> {
    if (await this.isReady()) return { ok: true };
    return {
      ok: false,
      message:
        "1Password CLI is not signed in. Run: eval $(op signin)\n" +
        `Or switch backends with secrets.provider in ${product().configFile}.`,
    };
  }

  runPrefix(): string[] {
    return [];
  }
}
