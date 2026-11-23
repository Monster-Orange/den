/**
 * Issue 476 (REVIEW-MESH-SPEC slice S1): the server's reviewer. It builds
 * the ReviewRunner (review/mesh/runner.ts) from Den's own pieces and runs
 * its loop, paced by the shared GitHub watcher's interval:
 *
 * - GitHub: `gh` as the person running the server (report-routes.ts runGh),
 *   conditional GETs, writes with JSON on stdin. Reviews post under that
 *   person's login with the agent named (S1's identity; the bot is S2).
 * - Rules: the repo's own, read from the PR's base branch in the local
 *   clone (rules.ts reviewAt), plus the guard on the review section.
 * - Usage: UsageLeftReader (usage/left.ts), against user.yml `usage:` caps.
 * - Legs: a fresh agent session in the reviewer agent's persona, project
 *   and model (agent-ops startAgent with a first prompt), in a read-only
 *   checkout at the head (checkout.ts), with Den's session env allowlist
 *   and the "ask" permission intent, so any command beyond reading waits
 *   for a person. Stopped, and its checkout removed, when it ends.
 * - Hand-back: routing (hub-delivery-service relayMessage) to the author
 *   agent; else the person's notifications, which also get every skip,
 *   outdated review and fork waiting for a person.
 * - Audit: every refused review_submit (audit.ts recordAction).
 *
 * Off until the person turns `reviews.enabled` on.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readUserConfig } from "../../shared/den-config.js";
import { ghGet, ghSend } from "../../shared/github-watch/gh-http.js";
import { githubWatchSettings } from "../../shared/github-watch/settings.js";
import { embedDelivery } from "../../shared/hub-delivery.js";
import type { NotificationKind } from "../../shared/notifications.js";
import { getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { listRecords, readRecord } from "../../shared/agents/records.js";
import {
  reviewCheckout,
  removeCheckout,
} from "../../shared/review/mesh/checkout.js";
import { instructionFiles } from "../../shared/review/mesh/instructions.js";
import {
  ReviewRunner,
  type RunnerDeps,
} from "../../shared/review/mesh/runner.js";
import { reviewSettings } from "../../shared/review/mesh/settings.js";
import {
  authorAgentFor,
  catalogRepoFor,
} from "../../shared/review/mesh/wiring.js";
import {
  matchReview,
  reviewAt,
  reviewRulesGuard,
} from "../../shared/review/rules.js";
import { readUsageLeft, usageCaps } from "../../shared/usage/left.js";
import { runGh } from "./report-routes.js";

let runner: ReviewRunner | null = null;
let timer: NodeJS.Timeout | null = null;
/** Agent ids of running legs: never a PR's author, and stopped at the end. */
const legAgents = new Set<string>();

const user = () => {
  try {
    return readUserConfig();
  } catch {
    return {};
  }
};

const KIND: Record<string, { kind: NotificationKind; key: string }> = {
  review_posted: { kind: "finished", key: "bell.m.reviewPosted" },
  review_skipped: { kind: "service", key: "bell.m.reviewSkipped" },
  review_outdated: { kind: "service", key: "bell.m.reviewOutdated" },
  review_waiting: { kind: "decision", key: "bell.m.reviewWaiting" },
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,254}$/;

/** The local clone of a watched repo (owner/name), or null. */
async function repoPathOf(slug: string): Promise<string | null> {
  const { readCatalog } =
    await import("../../shared/environment-manager/catalog.js");
  const { resolveRepoPath } =
    await import("../../shared/environment-manager/derivation/derive-graph.js");
  const name = catalogRepoFor(readCatalog(), slug);
  return name ? resolveRepoPath(name) : null;
}

/** Fetches a PR's base and head into the clone, under refs/den-review/. */
function fetchPr(
  repoPath: string,
  pr: number,
  base: string,
): { base: string; head: string } {
  if (!BRANCH_RE.test(base) || base.includes(".."))
    throw new Error("bad base ref");
  const b = `refs/den-review/base-${pr}`;
  const h = `refs/den-review/pr-${pr}`;
  git(repoPath, [
    "fetch",
    "-q",
    "--no-tags",
    "origin",
    `+refs/heads/${base}:${b}`,
    `+refs/pull/${pr}/head:${h}`,
  ]);
  return { base: b, head: h };
}

let person: string | null = null;
async function personLogin(): Promise<string> {
  if (person) return person;
  const r = await runGh(["api", "user", "--jq", ".login"]);
  const login = r.stdout.trim();
  if (r.code !== 0 || !/^[A-Za-z0-9-]{1,39}$/.test(login))
    throw new Error("gh isn't signed in, so Den can't post reviews");
  person = login;
  return login;
}

async function buildDeps(log: (l: string) => void): Promise<RunnerDeps> {
  const ops = await import("../cli/agent-ops.js");
  const { webDeps } = await import("./agent-routes.js");
  const { recordAction } = await import("./audit.js");
  const { notificationDeps } = await import("./notification-service.js");
  const { relayMessage } = await import("./hub-delivery-service.js");
  const d = webDeps();
  const login = await personLogin();
  const reviewerRec = () => {
    const s = reviewSettings(user());
    return s.reviewer ? readRecord(getStateDir(), s.reviewer.agent) : null;
  };
  return {
    get: ghGet(runGh),
    send: ghSend(runGh),
    settings: () => reviewSettings(user()),
    usageLeft: () => readUsageLeft(usageCaps(user())),
    who: { install: installLabel(), person: login },
    rulesFor: async (pr, facts) => {
      const repoPath = await repoPathOf(pr.repo);
      if (!repoPath) throw new Error(`no local clone of ${pr.repo}`);
      const refs = fetchPr(repoPath, pr.number, pr.base);
      const base = reviewAt(repoPath, refs.base);
      const head = reviewAt(repoPath, refs.head);
      // Rules Den can't read on the base match nothing, and the guard
      // then adds one blocking review: never "no review needed".
      const rules = base ? matchReview(base.review, facts) : [];
      const guard = reviewRulesGuard(base, head);
      return guard ? [...rules, guard] : rules;
    },
    authorAgent: (pr) =>
      authorAgentFor(
        pr.headRef,
        listRecords(getStateDir()).map((r) => ({
          id: r.id,
          cwd: r.cwd,
          running: !r.stoppedAt,
          leg: legAgents.has(r.id),
        })),
        (cwd) => {
          try {
            return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
          } catch {
            return null;
          }
        },
      ),
    prepare: async (repo, pr, sha) => {
      const repoPath = await repoPathOf(repo);
      const rec = reviewerRec();
      if (!repoPath || !rec) throw new Error("no clone or no reviewer agent");
      const root = path.join(d.workspaceDir(rec.workspace), ".den-review-legs");
      fs.mkdirSync(root, { recursive: true });
      const dir = path.join(
        root,
        `${repo.replace("/", "-")}-${pr}-${sha.slice(0, 12)}`,
      );
      if (fs.existsSync(dir)) removeCheckout(dir);
      reviewCheckout(repoPath, sha, dir);
      return dir;
    },
    instructionFiles,
    startLeg: async (l) => {
      const rec = reviewerRec();
      if (!rec) throw new Error("the reviewer agent is gone");
      const s = await ops.startAgent(
        d,
        {
          workspace: rec.workspace,
          persona: rec.persona,
          runtime: rec.runtime,
          ...(rec.model ? { model: rec.model } : {}),
          name: `${rec.id} review ${l.repo}#${l.pr}`,
          folder: l.dir,
          permission: "ask",
          repo: null,
        },
        { firstPrompt: l.brief },
      );
      legAgents.add(s.rec.id);
      recordAction(null, {
        verb: "review",
        detail: `review leg ${s.rec.id} for ${l.repo}#${l.pr} at ${l.sha.slice(0, 12)}`,
      });
      return s.rec.id;
    },
    endLeg: async (agent, dir) => {
      legAgents.delete(agent);
      try {
        const rec = readRecord(getStateDir(), agent);
        if (rec && !rec.stoppedAt) await ops.stopAgent(d, agent, rec.workspace);
      } catch (e) {
        log(
          `review: stopping leg ${agent}: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        );
      }
      if (dir) {
        try {
          removeCheckout(dir);
        } catch {
          /* already gone */
        }
      }
    },
    relay: async (agent, text) => {
      const rec = readRecord(getStateDir(), agent);
      if (!rec) return false;
      return relayMessage(
        embedDelivery({
          id: `review-${Date.now()}-${agent}`,
          agent,
          project: rec.workspace,
          origin: "Den review",
          text,
          at: Date.now(),
        }),
      );
    },
    notify: (n) => {
      const k = KIND[n.kind] ?? { kind: "service" as const, key: "" };
      notificationDeps().store.add({
        kind: k.kind,
        subject: `review/${n.link ?? n.text}`,
        scope: `workspace/${reviewerRec()?.workspace ?? "den-server"}`,
        text: n.text,
        ...(k.key ? { msg: { key: k.key, vars: n.vars ?? {} } } : {}),
        ...(n.link ? { link: n.link } : {}),
      });
    },
    audit: (a) =>
      recordAction(null, {
        verb: "review_submit",
        detail: `${a.repo}#${a.pr} from ${a.agent ?? "no agent token"}`,
        outcome: "refused",
        reason: a.why,
      }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
  };
}

/** The install's name on GitHub posts: a Setting, never the machine's host name. */
function installLabel(): string {
  const r = (user() as { reviews?: { install_label?: unknown } }).reviews
    ?.install_label;
  return typeof r === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(r)
    ? r
    : product().cli;
}

/** The install's reviewer (made on first use; null while reviews are off). */
export async function reviewRunner(
  log: (l: string) => void = () => {},
): Promise<ReviewRunner | null> {
  if (runner) return runner;
  if (!reviewSettings(user()).enabled) return null;
  runner = new ReviewRunner(await buildDeps(log));
  return runner;
}

/** Starts the loop. Each beat it looks whether reviews are on. */
export function startReviewMesh(o: { log: (line: string) => void }): void {
  if (timer) return;
  let busy = false;
  let last = 0;
  timer = setInterval(() => {
    if (busy) return;
    const every = githubWatchSettings(user()).intervalSeconds * 1000;
    if (Date.now() - last < every) return;
    busy = true;
    last = Date.now();
    reviewRunner(o.log)
      .then((r) => r?.tick())
      .catch((e) =>
        o.log(`review: ${String((e as Error)?.message ?? e).slice(0, 200)}`),
      )
      .finally(() => (busy = false));
  }, 5000);
  timer.unref();
}
