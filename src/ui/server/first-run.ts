/**
 * Issue 819: first run. Until a person has signed in once on this install,
 * a sign-in link the person made in their own terminal (`web login`, `web
 * up`), or the setup link opened on this computer, signs a browser in with
 * no second browser to approve it. From the first person's sign-in on, a
 * new device is approved from a signed-in browser (Settings › Access), and
 * first run never comes back: not after every session ends, not after the
 * secret is replaced (`web logout --all`).
 *
 * Kept as its own file in the state dir (`web-first-run.json`), apart from
 * the sessions and the secret, so neither signing out nor a new secret
 * clears it. An install from before this file counts as set up when it
 * has a person's session or a linked owner: the file is written then.
 * The fixture person (a test install's live checks) never counts.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../../shared/atomic-write.js";

export const FIRST_RUN_FILE = "web-first-run.json";

/** How a session signed in, as the store keeps it (web-session.ts). */
type Via = string | undefined;

export interface FirstRunDeps {
  stateDir: () => string;
  /** How each live session signed in. */
  sessionVias: () => Via[];
  /** Whether a GitHub owner is linked (web-owner.json). */
  ownerLinked: () => boolean;
  now?: () => number;
}

/** A person's sign-in (every one but the fixture person's). */
export function personVia(via: Via): boolean {
  return via !== "fixture";
}

export class FirstRun {
  private seen = false;
  constructor(private readonly deps: FirstRunDeps) {}

  private file(): string {
    return path.join(this.deps.stateDir(), FIRST_RUN_FILE);
  }

  /** Whether a person has ever signed in here (first run is over). */
  done(): boolean {
    if (this.seen) return true;
    if (fs.existsSync(this.file())) return (this.seen = true);
    let before: boolean;
    try {
      before =
        this.deps.ownerLinked() || this.deps.sessionVias().some(personVia);
    } catch {
      // Unreadable: never first run on a guess (nothing written).
      return true;
    }
    if (before) this.mark();
    return before;
  }

  /** A person signed in: first run is over, for good. */
  mark(): void {
    this.seen = true;
    try {
      fs.mkdirSync(this.deps.stateDir(), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(this.file()))
        writeFileAtomic(
          this.file(),
          `${JSON.stringify({ v: 1, at: new Date((this.deps.now ?? Date.now)()).toISOString() })}\n`,
          { mode: 0o600 },
        );
    } catch {
      /* kept in memory for this server; the sessions say it next start */
    }
  }
}
