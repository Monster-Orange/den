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
 *   - #251: a pass that waits says why, once per reason (the log and the
 *     audit). While the server agent waits on its person (a permission
 *     prompt, a question, a held Allow), one bell item says the update
 *     waits on them; after server_agent.update_wait_checks passes in a
 *     row it needs them. It never goes past a pending Allow.
 *   - Issue 327: that wait names what the server agent waits on (the
 *     tool its dialog asks for, or the notice) and since when, in the
 *     state, the log and the bell. Its bell item goes, read or not, once
 *     the update goes on, and at the first pass after a restart (the
 *     process that posted it is gone).
 *   - #251: after a self-update, the new pin must be committed in the
 *     distribution's folder. Two passes in a row with it uncommitted: the
 *     log, and one bell item.
 *   - #176: Den commits and pushes that pin itself (pin-commit.ts), on the
 *     lead install only, once the new version is verified (the watch wrote
 *     "good" and this Den runs it). The server agent's state doesn't
 *     matter: resumed, busy, idle or not running. A push that fails is
 *     tried again at every pass; the bell says it once. With pin_commit:
 *     pr it opens a pull request instead; the approval policy (issue 160)
 *     may hold it for the person's Allow.
 *
 * Every input is a function (tests fake each); the server wires them.
 */
import semver from "semver";
import type { UpdateState } from "./den-update.js";
import type { PinStep } from "./pin-commit.js";
import type { NotificationStore } from "../../shared/notifications.js";
import type { UpdateTick } from "../../shared/update-check-state.js";
import { UPDATE_WAIT_CHECKS_DEFAULT } from "../../shared/den-config.js";

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

/**
 * #251: why an auto update waits. permission / asked / approval: the
 * server agent waits on its person; busy: mid-turn; updating: an update
 * is under way.
 */
export type UpdateWait =
  | "updating"
  | "approval"
  | "permission"
  | "asked"
  | "busy";

/** The waits that are the person's to end. */
export function waitsOnPerson(w: UpdateWait | null): boolean {
  return w === "permission" || w === "asked" || w === "approval";
}

const WAIT_TEXT: Record<UpdateWait, string> = {
  updating: "an update is under way",
  approval: "an Allow is waiting for the person",
  permission: "the Den agent is waiting on its person's Allow",
  asked: "the Den agent asked its person a question",
  busy: "the Den agent is in the middle of a turn",
};

/** Issue 327: what the server agent waits on, and since when (ISO). */
export interface WaitDetail {
  what: string;
  since: string;
}

/** Why it waits, in words, with what and since when when known. */
export function waitText(why: UpdateWait, at?: WaitDetail | null): string {
  const base = WAIT_TEXT[why];
  if (!at || (why !== "permission" && why !== "asked")) return base;
  return `${base}: ${at.what || "(no text)"} since ${at.since}`;
}

/** #251: the one bell item an update waiting on the person keeps. */
export const UPDATE_WAIT_SUBJECT = "record:den-update-wait";

/**
 * #251 / issue 327: post and clear that item. `note` replaces any earlier
 * one (one item); `done` takes it out read or not (withdraw keeps a read
 * one, so a note the person had opened outlived the update).
 */
export function updateWaitNotes(
  store: Pick<NotificationStore, "add" | "remove">,
  title: string,
): {
  note(
    version: string,
    why: UpdateWait,
    needsYou: boolean,
    at?: WaitDetail | null,
  ): void;
  done(): void;
} {
  const done = () =>
    void store.remove((n) => n.subject === UPDATE_WAIT_SUBJECT);
  return {
    note(version, why, needsYou, at) {
      done();
      const asked = why === "asked";
      const head = `${title}'s update to ${version} waits: the ${title} agent`;
      const base = asked
        ? `${head} asked you a question`
        : `${head} is waiting on your Allow`;
      store.add({
        kind: needsYou ? "waiting" : "service",
        subject: UPDATE_WAIT_SUBJECT,
        scope: "workspace/den-server",
        text: at ? `${base}: ${at.what} (since ${at.since})` : base,
        msg: at
          ? {
              key: asked
                ? "bell.m.updateWaitsAskedWhat"
                : "bell.m.updateWaitsWhat",
              vars: { v: version, what: at.what, since: at.since },
            }
          : {
              key: asked ? "bell.m.updateWaitsAsked" : "bell.m.updateWaits",
              vars: { v: version },
            },
        link: "/server-agent",
      });
    },
    done,
  };
}

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
  /** #251: why an update would wait now, or null (idle). Over idle(). */
  waitWhy?(): Promise<UpdateWait | null>;
  /** Issue 327: what the server agent waits on, since when, or null. */
  waitWhat?(): WaitDetail | null;
  /** #251: server_agent.update_wait_checks (default 2). */
  waitChecks?(): number;
  /** #251: a line for the server log and the audit trail. */
  log?(line: string): void;
  /**
   * #251: the one bell item while the update waits on the person; with
   * `needsYou`, it counts as needing them; `at`: what it waits on
   * (issue 327). done(): it goes, read or not.
   */
  waitNote?(
    version: string,
    why: UpdateWait,
    needsYou: boolean,
    at?: WaitDetail | null,
  ): void;
  waitDone?(): void;
  /**
   * #251: whether the distribution's pin (its package.json) is committed
   * in its folder: null when Den can't tell (no git).
   */
  pinState?(): Promise<"committed" | "uncommitted" | null>;
  /** #251: the one bell item while the pin of `version` isn't committed. */
  pinNote?(version: string, why: UpdateWait | null): void;
  pinDone?(): void;
  /**
   * #176: commit and push the pin of `version` (pin-commit.ts commitPin),
   * or push a commit an earlier pass couldn't. Absent: the pin is left to
   * the server agent (server_agent.pin_commit: off).
   */
  pinCommit?(version: string): Promise<PinStep>;
  /** #176: the bell: the pin pushed, or (once) why it isn't. */
  pinNotice?(step: PinStep): void;
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
  /** #251: the last wait's reason and how many passes waited on the person. */
  let lastWhy: string | null = null;
  let personPasses = 0;
  // Issue 327: a bell item from before a restart may be there: the first
  // pass that doesn't wait clears it.
  let noted = true;
  const waitWhy = async (): Promise<UpdateWait | null> =>
    d.waitWhy
      ? d.waitWhy().catch(() => "busy" as const)
      : (await d.idle().catch(() => false))
        ? null
        : "busy";
  const notWaiting = () => {
    lastWhy = null;
    personPasses = 0;
    if (noted) {
      noted = false;
      d.waitDone?.();
    }
  };
  let pinUncommitted = 0;
  let pinNoted: string | null = null;
  /** #251: the running version's pin committed? Two passes: say so. */
  /**
   * #176: the version whose pin is on its way another way (a pull request,
   * a held Allow): its uncommitted files are expected, not said again.
   */
  let pinElsewhere: string | null = null;
  const checkPin = async (have: string) => {
    if (!d.pinState || d.pinned() !== have || pinElsewhere === have) return;
    const st = await d.pinState().catch(() => null);
    if (st !== "uncommitted") {
      pinUncommitted = 0;
      if (pinNoted) {
        pinNoted = null;
        d.pinDone?.();
        if (st === "committed")
          d.log?.(`update check: the pin of ${have} is committed`);
      }
      return;
    }
    pinUncommitted += 1;
    if (pinUncommitted < 2 || pinNoted === have) return;
    pinNoted = have;
    const why = await waitWhy();
    d.log?.(
      `update check: Den ${have} runs, but its pin isn't committed in the distribution's folder` +
        (waitsOnPerson(why) ? ` (${WAIT_TEXT[why!]})` : ""),
    );
    d.pinNote?.(have, why);
  };
  /**
   * #176: the lead install's verified version: Den commits and pushes its
   * pin. Each pass, until it is pushed (pin.json says when it is done).
   */
  let pinSkipped: string | null = null;
  const commitPin = async (have: string) => {
    if (!d.pinCommit || d.role() !== "lead" || d.pinned() !== have) return;
    const last = d.last();
    if (!last || last.state !== "good" || last.to !== have) return;
    const r = await d.pinCommit(have).catch(
      (e: unknown): PinStep => ({
        did: "skipped",
        version: have,
        why: e instanceof Error ? e.message : String(e),
      }),
    );
    if (
      r.did === "pr" ||
      r.did === "branch_pushed" ||
      r.did === "held" ||
      (r.did === "done" && r.how === "pr")
    )
      pinElsewhere = have;
    switch (r.did) {
      case "pr":
        d.log?.(
          `update check: the pin of ${have} is on ${r.branch}, pull request ${r.url}`,
        );
        d.pinNotice?.(r);
        return;
      case "branch_pushed":
      case "held":
        if (r.first) {
          d.log?.(
            r.did === "held"
              ? `update check: the pin of ${have} waits for the person's Allow (approval policy)`
              : `update check: the pin of ${have} is on ${r.branch}, but no pull request: ${r.why}`,
          );
          d.pinNotice?.(r);
        }
        return;
      case "pushed":
        d.log?.(
          `update check: the pin of ${have} is committed and pushed (${r.sha.slice(0, 12)})`,
        );
        d.pinNotice?.(r);
        return;
      case "push_failed":
      case "commit_failed":
        if (r.first) {
          d.log?.(
            `update check: the pin of ${have}: ${r.did.replace("_", " ")}: ${r.why}`,
          );
          d.pinNotice?.(r);
        }
        return;
      case "skipped":
        if (pinSkipped === `${have} ${r.why}`) return;
        pinSkipped = `${have} ${r.why}`;
        d.log?.(
          `update check: the pin of ${have} isn't Den's to commit: ${r.why}`,
        );
        return;
      default:
        return;
    }
  };
  return {
    async tick() {
      const have = d.running();
      if (!have) return { did: "current" };
      await commitPin(have);
      await checkPin(have);
      const no = d.cantUpdate();
      if (no) return { did: "skipped", why: no };
      const lead = d.role() === "lead";
      const want = lead ? await d.latest().catch(() => null) : d.pinned();
      if (!newer(want, have)) {
        notWaiting();
        return { did: "current" };
      }
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
      const wait = await waitWhy();
      if (wait) {
        const at = waitsOnPerson(wait)
          ? (() => {
              try {
                return d.waitWhat?.() ?? null;
              } catch {
                return null;
              }
            })()
          : null;
        const said = waitText(wait, at);
        if (said !== lastWhy) {
          lastWhy = said;
          d.log?.(`update check: Den ${want} waits: ${said}`);
        }
        if (waitsOnPerson(wait)) {
          personPasses += 1;
          noted = true;
          d.waitNote?.(
            want,
            wait,
            personPasses >= (d.waitChecks?.() ?? UPDATE_WAIT_CHECKS_DEFAULT),
            at,
          );
        } else {
          personPasses = 0;
          if (noted) {
            noted = false;
            d.waitDone?.();
          }
        }
        return {
          did: "waiting",
          version: want,
          why: said,
          wait,
        };
      }
      notWaiting();
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
