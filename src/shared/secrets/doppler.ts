/**
 * Doppler strategy — reads/writes flat keys with the `doppler` CLI.
 * Selected with `secrets.provider: doppler` (the default).
 *
 * Project/config come from `secrets.doppler.{project,config}` in
 * config/den.yml, else from the directory's `doppler setup` scope,
 * else from DOPPLER_PROJECT / DOPPLER_CONFIG / DOPPLER_TOKEN. A scoped ref
 * (a `secret_env` value, `<project>/<config>/<key>`) names its own.
 */
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { flatKeyFor } from "./keys.js";
import type { PreflightResult, SecretRef, SecretsProvider } from "./types.js";

import { product } from "../product.js";
const execFileAsync = promisify(execFile);

export interface DopplerOptions {
  project?: string;
  config?: string;
  keys?: Record<string, string>;
  timeoutMs?: number;
}

export class DopplerProvider implements SecretsProvider {
  readonly name = "doppler" as const;
  private readonly timeout: number;

  constructor(private readonly opts: DopplerOptions = {}) {
    this.timeout = opts.timeoutMs ?? 30_000;
  }

  /**
   * `--project/--config` flags: a scoped ref's own vault/item, else the
   * configured ones (when set explicitly).
   */
  scopeArgs(ref?: SecretRef): string[] {
    if (ref?.scoped) return ["--project", ref.vault, "--config", ref.item];
    const a: string[] = [];
    if (this.opts.project) a.push("--project", this.opts.project);
    if (this.opts.config) a.push("--config", this.opts.config);
    return a;
  }

  keyFor(ref: SecretRef): string {
    return flatKeyFor(ref, this.opts.keys);
  }

  async isReady(): Promise<boolean> {
    try {
      await execFileAsync("doppler", ["me", "--json"], {
        timeout: this.timeout,
      });
      return true;
    } catch {
      return false;
    }
  }

  async get(ref: SecretRef): Promise<string> {
    const key = this.keyFor(ref);
    const { stdout } = await execFileAsync(
      "doppler",
      ["secrets", "get", key, "--plain", ...this.scopeArgs(ref)],
      { timeout: this.timeout },
    );
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

  /** Value goes over stdin so it never appears in the process table. */
  async set(ref: SecretRef, value: string): Promise<void> {
    const key = this.keyFor(ref);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "doppler",
        ["secrets", "set", key, "--silent", ...this.scopeArgs(ref)],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(`doppler secrets set ${key} failed: ${stderr.trim()}`),
            ),
      );
      child.stdin?.end(value);
    });
  }

  async preflight(): Promise<PreflightResult> {
    if (!(await this.isReady())) {
      return {
        ok: false,
        message:
          "Doppler CLI is not installed or not logged in.\n" +
          "Install: brew install dopplerhq/cli/doppler  then: doppler login",
      };
    }
    try {
      await execFileAsync(
        "doppler",
        ["secrets", "--only-names", "--json", ...this.scopeArgs()],
        { timeout: this.timeout },
      );
      return { ok: true };
    } catch {
      return {
        ok: false,
        message:
          "Doppler is logged in but no project/config is selected.\n" +
          `Run \`doppler setup\` in the repo, or set secrets.doppler.project/config in ${product().configFile}.`,
      };
    }
  }

  runPrefix(): string[] {
    return ["doppler", "run", ...this.scopeArgs(), "--"];
  }
}
