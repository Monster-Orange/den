/**
 * 1Password strategy — reads/writes item fields with the `op` CLI.
 * Selected with `secrets.provider: 1password`.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { PreflightResult, SecretRef, SecretsProvider } from "./types.js";

import { product } from "../product.js";
const execFileAsync = promisify(execFile);

export interface OnePasswordOptions {
  account?: string;
  timeoutMs?: number;
}

export class OnePasswordProvider implements SecretsProvider {
  readonly name = "1password" as const;
  private readonly timeout: number;

  constructor(opts: OnePasswordOptions = {}) {
    this.timeout = opts.timeoutMs ?? 60_000;
    if (opts.account) process.env.OP_ACCOUNT ||= opts.account;
  }

  async isReady(): Promise<boolean> {
    try {
      await execFileAsync("op", ["whoami"], { timeout: this.timeout });
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
    const { stdout } = await execFileAsync("op", args, {
      timeout: this.timeout,
    });
    return String(stdout).trim();
  }

  async tryGet(ref: SecretRef): Promise<string | null> {
    try {
      const v = await this.get(ref);
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /** Overwrite the field; an item that isn't there yet is created (a Password item). */
  async set(ref: SecretRef, value: string): Promise<void> {
    const vault = ref.vault ? ["--vault", ref.vault] : [];
    const field = `${ref.field}[password]=${value}`;
    try {
      await execFileAsync("op", ["item", "edit", ref.item, ...vault, field], {
        timeout: this.timeout,
      });
    } catch (err) {
      try {
        await execFileAsync(
          "op",
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
          { timeout: this.timeout },
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
