/**
 * Issue 730: the held write agent_signing_key_create. Den makes the
 * agents' own signing key: an ed25519 SSH key with no passphrase (agents
 * and Den's pin commits sign with it unattended), in
 * <state>/agent-signing/id_ed25519 (folder 0700, key 0600), sets
 * agents.git.signing_key in config/local/user.yml, and shows the public
 * key with the line that adds it on GitHub as a signing key.
 *
 * It is never the person's own key. It is critical: only the person's own
 * Allow runs it (CRITICAL_HELD_ACTIONS). The private key is never read
 * back or returned; the result holds the public key and paths only.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { type DetailKey, line, reviewLines } from "../review-lines.js";
import { signingKeyAddLine } from "./git-signing.js";

export const AGENT_SIGNING_KEY_ACTION = "agent_signing_key_create";

/** Where the key goes under the state dir. */
export const agentSigningKeyPath = (stateDir: string): string =>
  path.join(stateDir, "agent-signing", "id_ed25519");

export interface AgentSigningKeyDeps {
  stateDir: string;
  /** agents.git.signing_key now (an absolute path), or undefined. */
  current: () => string | undefined;
  /** Sets agents.git.signing_key in config/local/user.yml. */
  setKey: (p: string) => void;
  /** The key's comment and GitHub title (the brand's agents). */
  title?: string;
  env?: NodeJS.ProcessEnv;
}

export type AgentSigningKeyCheck =
  | {
      ok: true;
      args: Record<string, never>;
      summary: string;
      params: Record<string, string>;
      details: string[];
      detailKeys: DetailKey[];
      personOnly: true;
    }
  | { ok: false; error: string };

export interface AgentSigningKeyResult {
  path: string;
  publicKey: string;
  addLine: string;
}

export function agentSigningKeyOp(d: AgentSigningKeyDeps): {
  check: (a: Record<string, unknown>) => AgentSigningKeyCheck;
  run: (a: Record<string, unknown>) => Promise<AgentSigningKeyResult>;
} {
  const file = agentSigningKeyPath(d.stateDir);
  const title = d.title ?? "Den agents";
  const refusal = (): string | null => {
    const have = d.current();
    if (have && fs.existsSync(have))
      return `agents.git.signing_key is already set (${have}); nothing was made`;
    if (fs.existsSync(file))
      return `${file} is there already; set agents.git.signing_key to it, or remove it first`;
    return null;
  };
  return {
    check: () => {
      const no = refusal();
      if (no) return { ok: false, error: no };
      return {
        ok: true,
        args: {},
        summary: `make the agents' signing key (${file}) and sign their commits with it`,
        params: { path: file },
        ...reviewLines([
          line(
            "Makes an ed25519 SSH key with no passphrase at {path}. Den and its agents sign with it; it isn't hidden from other programs run under the same login.",
            "ap.det.agent_signing_key_create.make",
            { path: file },
          ),
          line(
            "Sets agents.git.signing_key in config/local/user.yml: agents' commits and Den's pin commits are signed with it.",
            "ap.det.agent_signing_key_create.set",
          ),
          line(
            "Then add its public key on GitHub as a signing key, so GitHub shows those commits as Verified.",
            "ap.det.agent_signing_key_create.github",
          ),
        ]),
        personOnly: true,
      };
    },
    run: async () => {
      const no = refusal();
      if (no) throw new Error(no);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(file), 0o700);
      const kg = spawnSync(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", title, "-f", file],
        { env: d.env ?? process.env, encoding: "utf-8", timeout: 30_000 },
      );
      if (kg.status !== 0)
        throw new Error(
          `ssh-keygen failed: ${String(kg.stderr ?? kg.error ?? "").trim() || `exit ${kg.status}`}`,
        );
      fs.chmodSync(file, 0o600);
      d.setKey(file);
      return {
        path: file,
        publicKey: fs.readFileSync(`${file}.pub`, "utf-8").trim(),
        addLine: signingKeyAddLine({ signingKey: file }),
      };
    },
  };
}
