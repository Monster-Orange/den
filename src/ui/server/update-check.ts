/**
 * SRV-P6 (0.4.48): Den keeps itself current. Every
 * server_agent.update_check_minutes the web server looks at npm (one tick):
 *
 *   - The lead install (LEAD-1; with no Hub record, every install is its
 *     own lead) targets npm's latest. A follower targets the
 *     distribution's pin and never moves it (LEAD-3).
 *   - self_update: auto updates at an idle moment: the server agent idle,
 *     no Allow open, no update under way. Busy, it waits for a later pass.
 *   - self_update: ask puts one held "update Den to X" in Needs you, and a
 *     bell notice, once per version.
 *   - A version that rolled back isn't tried again (its failure is in the
 *     bell already); a newer one is. A failed update says why in the bell.
 *   - A Den run from a checkout is updated with git: skipped.
 *
 * Every input is a function (tests fake each); the server wires them.
 */
import semver from "semver";
import type { UpdateState } from "./den-update.js";
import type { UpdateTick } from "../../shared/update-check-state.js";

// The state file and doctor's line live in src/shared (the CLI reads them).
export {
  readCheckState,
  selfUpdateSummary,
  tickText,
  updateCheckFile,
  writeCheckState,
  type CheckState,
  type UpdateTick,
} from "../../shared/update-check-state.js";

/** #142: a bell item asking the person to Allow a Den update. */
export function isUpdateAsk(n: {
  subject: string;
  msg?: { key: string; vars?: Record<string, string | number> };
}): boolean {
  return (
    n.subject.startsWith("record:den-update-") &&
    n.msg?.key === "bell.m.updateOut"
  );
}

/** #142: an update ask for `have` or older: done with (the item goes). */
export function staleUpdateAsk(
  n: Parameters<typeof isUpdateAsk>[0],
  have: string,
): boolean {
  const v = String(n.msg?.vars?.v ?? "");
  return (
    isUpdateAsk(n) &&
    !!semver.valid(v) &&
    !!semver.valid(have) &&
    semver.lte(v, have)
  );
}

export interface UpdateCheckDeps {
  /** The version running now, or null. */
  running(): string | null;
  /** npm's latest @monster-orange/den, or null (npm can't say). */
  latest(): Promise<string | null>;
  /** The distribution's pinned version (its package.json), or null. */
  pinned(): string | null;
  /** LEAD-1: this install is its distribution's lead, or a follower. */
  role(): "lead" | "follower";
  /** server_agent.self_update (the person's, user.yml). */
  mode(): "ask" | "auto";
  /** Why this install can't update through npm (a checkout), or null. */
  cantUpdate(): string | null;
  /** The last update's state (den-update.ts), or null. */
  last(): UpdateState | null;
  /** The server agent is idle, no Allow is open, no update under way. */
  idle(): Promise<boolean>;
  /** Run the update now (auto). */
  update(
    version: string,
    reason: string,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Hold "update Den to X" for the person; false when it couldn't. */
  ask(version: string, reason: string): Promise<boolean> | boolean;
  /**
   * A bell notice about `version` (Den X is out; an update failed): the
   * English text, and its key and values for the page's language.
   */
  notice(
    version: string,
    text: string,
    msg: { key: string; vars: Record<string, string> },
  ): void;
}

export interface UpdateCheck {
  tick(): Promise<UpdateTick>;
}

/** Whether `want` is a version above `have` (both semver). */
function newer(want: string | null, have: string): want is string {
  return !!want && !!semver.valid(want) && !!semver.valid(have)
    ? semver.gt(want, have)
    : false;
}

export function updateCheck(d: UpdateCheckDeps): UpdateCheck {
  /** The versions already asked about (once each). */
  const asked = new Set<string>();
  return {
    async tick() {
      const have = d.running();
      if (!have) return { did: "current" };
      const no = d.cantUpdate();
      if (no) return { did: "skipped", why: no };
      const lead = d.role() === "lead";
      const want = lead ? await d.latest().catch(() => null) : d.pinned();
      if (!newer(want, have)) return { did: "current" };
      const last = d.last();
      if (
        last &&
        last.to === want &&
        (last.state === "rolled_back" || last.state === "rollback_failed")
      )
        return {
          did: "skipped",
          version: want,
          why: `${want} rolled back here before${last.why ? ` (${last.why})` : ""}; a newer version is tried when it is out`,
        };
      const reason = lead
        ? `Den ${want} is out (this install runs ${have})`
        : `the distribution is pinned to ${want} (this install runs ${have})`;
      if (d.mode() === "ask") {
        if (!asked.has(want)) {
          asked.add(want);
          await d.ask(want, reason);
          d.notice(
            want,
            `Den ${want} is out. Allow the update when it suits you (this install runs ${have}).`,
            { key: "bell.m.updateOut", vars: { v: want, have } },
          );
        }
        return { did: "asked", version: want };
      }
      if (!(await d.idle().catch(() => false)))
        return { did: "waiting", version: want };
      const r = await d.update(want, reason).catch((e: unknown) => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (r.ok) return { did: "updating", version: want };
      const why = r.error ?? "the update didn't run";
      d.notice(want, `Den couldn't update to ${want}: ${why}`, {
        key: "bell.m.updateFailed",
        vars: { v: want, why },
      });
      return { did: "failed", version: want, why };
    },
  };
}
