/**
 * Issue 1018: a test install's fixture person without a browser session.
 *
 * A throwaway test install (one an automated job starts) has no person to
 * press Settings › Set up test person. Its launcher may instead pass a
 * one-time setup value, `<PREFIX>_FIXTURE_SETUP_SECRET`, in the server's
 * own start environment (never a file, never a setting):
 *
 *  - The server takes it out of its environment at start, so nothing it
 *    starts inherits it, and keeps it only when the test-install binding
 *    holds then (the mark, the launch flag, its own state folder, no
 *    owner). On any other install it is dropped unread.
 *  - `<cli> web fixture-person --from-setup-secret` sends the CLI's own
 *    copy once. The server compares it in constant time and, on a match,
 *    makes the sealed key exactly as Set up test person does.
 *  - The value is spent by the first try that reaches it, matched or not.
 *    No answer echoes it.
 */
import { createHash, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";

/** The launcher's value, `<PREFIX>_FIXTURE_SETUP_SECRET` (profile readEnv). */
export const FIXTURE_SETUP_SECRET_ENV_KEY = "FIXTURE_SETUP_SECRET";
/** The CLI flag that sends it. */
export const FROM_SETUP_SECRET_FLAG = "--from-setup-secret";
/** The audit line when it made the key. */
export const SETUP_SECRET_AUDIT = "fixture person made from the setup secret";

export type SetupSecretRefusal =
  | "no_setup_secret"
  | "setup_secret_used"
  | "setup_secret_wrong";

const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();

/**
 * Spent values, in the state folder (one tag a line, 0600), so a restart
 * with the same value doesn't bring it back. A tag is a hash of the value
 * under its own context, never the value; the launcher's value is random,
 * so a tag can't be turned back into it.
 */
export const SETUP_SECRET_SPENT_FILE = "fixture-setup-secret.spent";
const SPENT_CONTEXT = "den-fixture-setup-spent-v1:";
const spentTag = (v: string) =>
  createHash("sha256")
    .update(SPENT_CONTEXT + v, "utf8")
    .digest("hex");

function spentTags(stateDir: string): Set<string> {
  try {
    return new Set(
      fs
        .readFileSync(path.join(stateDir, SETUP_SECRET_SPENT_FILE), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{64}$/.test(l)),
    );
  } catch {
    return new Set();
  }
}

/**
 * The value, held in memory only, as a digest. `take` compares once: the
 * first call that reaches it spends it, whatever the answer, and (with a
 * state folder) records it spent there before it compares. take() is
 * synchronous, so two tries can't both reach it.
 */
export class SetupSecret {
  private held: Buffer | null;
  private tag: string | null;
  private spent: boolean;
  private stateDir: string | null;

  constructor(value: string | null | undefined, stateDir?: string) {
    const v = typeof value === "string" ? value : "";
    this.held = v ? digest(v) : null;
    this.tag = v ? spentTag(v) : null;
    this.stateDir = stateDir ?? null;
    this.spent =
      !!this.tag && !!this.stateDir && spentTags(this.stateDir).has(this.tag);
    if (this.spent) this.held = null;
  }

  /** Whether a value was kept at start and not yet spent. */
  get waiting(): boolean {
    return this.held !== null;
  }

  /** Drops the value unread (the install isn't a test install). */
  drop(): void {
    this.held = null;
    this.tag = null;
    this.spent = false;
  }

  take(
    presented: unknown,
  ): { ok: true } | { ok: false; code: SetupSecretRefusal } {
    if (this.spent) return { ok: false, code: "setup_secret_used" };
    if (!this.held) return { ok: false, code: "no_setup_secret" };
    const want = this.held;
    this.held = null;
    this.spent = true;
    if (this.stateDir && this.tag) {
      try {
        fs.appendFileSync(
          path.join(this.stateDir, SETUP_SECRET_SPENT_FILE),
          `${this.tag}\n`,
          { mode: 0o600 },
        );
      } catch {
        // Not recorded: a match still makes no key (caller checks), and a
        // restart with this value would be let in once more. Refuse.
        return { ok: false, code: "setup_secret_used" };
      }
    }
    const got = digest(typeof presented === "string" ? presented : "");
    return timingSafeEqual(got, want)
      ? { ok: true }
      : { ok: false, code: "setup_secret_wrong" };
  }
}

/** Each refusal's own words; none of them names or echoes the value. */
export function setupSecretRefusal(
  code: SetupSecretRefusal,
  cli: string,
): string {
  switch (code) {
    case "no_setup_secret":
      return (
        "This install wasn't started with a setup value, so it can't make the test person " +
        "this way. Start it with the launcher's setup value, or press Settings › Access › " +
        "Set up test person in a browser."
      );
    case "setup_secret_used":
      return (
        "The setup value was already used on this install; it works once. Restart the test " +
        `install with a new one, or sign in as the fixture person with \`${cli} web fixture-login\`.`
      );
    case "setup_secret_wrong":
      return (
        "That setup value doesn't match the one this install was started with. It is spent " +
        "now: restart the test install with a new one."
      );
  }
}

/** How the fixture key was made, kept beside it for doctor. */
export type FixtureMadeBy = "setup-secret" | "settings" | "creation" | "grant";
export const FIXTURE_MADE_BY_FILE = "fixture-person.made-by";
const MADE_BY = new Set<FixtureMadeBy>([
  "grant",
  "setup-secret",
  "settings",
  "creation",
]);

export function writeFixtureMadeBy(stateDir: string, how: FixtureMadeBy): void {
  try {
    fs.writeFileSync(path.join(stateDir, FIXTURE_MADE_BY_FILE), `${how}\n`, {
      mode: 0o600,
    });
  } catch {
    /* doctor then says it can't tell */
  }
}

export function readFixtureMadeBy(stateDir: string): FixtureMadeBy | null {
  try {
    const v = fs
      .readFileSync(path.join(stateDir, FIXTURE_MADE_BY_FILE), "utf8")
      .trim() as FixtureMadeBy;
    return MADE_BY.has(v) ? v : null;
  } catch {
    return null;
  }
}
