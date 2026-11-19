/**
 * Issue 565: agents use Den's Report. `<cli> report` from an agent's shell
 * and the MCP tool `report` both ask for the held write `report`; this is
 * its check and run. Nothing here is a second Report: the text is
 * compose's (the browser's preview: the same targets, the same scrub), the
 * visibility is reportTargets' (the form's label), and the filing is
 * fileReport's (the browser's send).
 *
 *   - To a public target (or one whose visibility isn't known: the safe
 *     reading, as in the form) it is the person's own Allow, always: the
 *     Review is exactly what will be posted, with the form's "visible to
 *     everyone" warning (personOnly; approval-policy.ts places `report`
 *     as `widens`).
 *   - To a private or internal target it follows the approval policy like
 *     any other routine write.
 *   - The issue says which agent filed it (agentLine, inside the scrubbed
 *     text). The agent is the one its token proves: an ask's own `from`
 *     is dropped, and only the queue's re-check (no asker) reads it back.
 *   - The audit says who filed it and where (fileReport → deps.audit).
 *   - Not signed in to GitHub, or an open issue with the same title:
 *     refused before anything waits, with the new-issue link as the
 *     fallback, or the issue to add to.
 *   - A screenshot is an image file on this machine: the Review names it,
 *     and the run says to attach it (GitHub's issue API takes no images;
 *     the browser hands the person its masked screenshot to paste too).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { HeldAction, HeldAsker, HeldCheck } from "./approval-routes.js";
import {
  compose,
  fileReport,
  newIssueUrl,
  reportTargets,
  sameTitle,
  type ReportRouteDeps,
} from "./report-routes.js";

const KINDS = ["bug", "idea", "question"] as const;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** The line an agent's report ends with, naming the agent. */
export function agentLine(agent: string | undefined): string {
  return agent
    ? `_Filed by the agent ${agent} through Den's Report._`
    : "_Filed by an agent through Den's Report._";
}

/** A path as the person reads it: ~/… inside home. */
function shown(p: string): string {
  const home = os.homedir();
  const rel = path.relative(home, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : p;
}

export function reportHeld(d: ReportRouteDeps): HeldAction {
  return {
    async check(a, who?: HeldAsker): Promise<HeldCheck> {
      const s = d.settings();
      if (!s.enabled)
        return {
          ok: false,
          error: "reports are turned off here (feedback.enabled: false)",
        };
      // The queue's re-check before a run has no asker: the stored args
      // say who asked. An ask's own claim is never read.
      const fromArg = str(a.from);
      const from =
        who === undefined
          ? fromArg && AGENT_RE.test(fromArg)
            ? fromArg
            : undefined
          : who.agent;
      const kind = str(a.kind) ?? "bug";
      if (!(KINDS as readonly string[]).includes(kind))
        return { ok: false, error: "kind: bug, idea or question" };
      const title = str(a.title);
      if (!title) return { ok: false, error: "a title is needed" };
      const description =
        typeof a.description === "string" ? a.description.trim() : "";
      const redact = a.redact !== false;
      const repo = str(a.repo) ?? s.repos[0];
      const addTo =
        typeof a.add_to === "number" &&
        Number.isSafeInteger(a.add_to) &&
        a.add_to > 0
          ? a.add_to
          : undefined;
      if (a.add_to !== undefined && addTo === undefined)
        return { ok: false, error: "add_to: an issue number" };
      const fileNew = a.file_new === true;
      const shot = str(a.screenshot);
      if (shot !== undefined) {
        if (!path.isAbsolute(shot) || !IMAGE_RE.test(shot))
          return {
            ok: false,
            error: "screenshot: the full path of a .png, .jpg or .webp file",
          };
        let file = false;
        try {
          file = fs.statSync(shot).isFile();
        } catch {
          file = false;
        }
        if (!file)
          return { ok: false, error: `screenshot: no file at ${shot}` };
      }

      const c = await compose(
        {
          kind,
          title,
          description: `${description}${description ? "\n\n" : ""}${agentLine(from)}`,
          sections: {},
          redact,
          repo,
        },
        d,
      );
      if (typeof c === "string") return { ok: false, error: c };
      const targets = await reportTargets(d);
      if (!targets.signedIn)
        return {
          ok: false,
          error: `sending needs a GitHub sign-in on this machine (gh auth login): nothing was asked. Fall back to a GitHub issue: ${newIssueUrl(c.repo, c.title, c.body)}`,
        };
      if (addTo === undefined && !fileNew) {
        const dup = await sameTitle(d, c.repo, c.title);
        if (dup)
          return {
            ok: false,
            error: `an open report has this title: issue ${dup.number} ${dup.url}. Ask again with add_to: ${dup.number} to add to it, or file_new: true to file a new one. Nothing was asked.`,
          };
      }
      const visibility =
        targets.repos.find((t) => t.repo === c.repo)?.visibility ?? "public";
      const isPublic = visibility === "public";

      const details: string[] = [];
      const detailKeys: ({
        key: string;
        vars?: Record<string, string>;
      } | null)[] = [];
      const line = (
        text: string,
        key?: string,
        vars?: Record<string, string>,
      ) => {
        details.push(text);
        detailKeys.push(key ? { key, ...(vars ? { vars } : {}) } : null);
      };
      line(`To: ${c.repo} (${visibility})`, `ap.det.report.to.${visibility}`, {
        repo: c.repo,
      });
      if (isPublic)
        line(
          "Public repository. Screenshots and text are visible to everyone. Mask anything private.",
          "ap.det.report.pubW",
        );
      else
        line(
          "Only people with access to this repository can see it.",
          "ap.det.report.privN",
        );
      if (addTo !== undefined)
        line(`Adds a comment to issue ${addTo}.`, "ap.det.report.addTo", {
          n: String(addTo),
        });
      line(`Title: ${c.title}`, "ap.det.report.title", { title: c.title });
      line("Exactly what will be posted:", "ap.det.report.body");
      for (const l of c.body.replace(/\n+$/, "").split("\n")) line(`  ${l}`);
      if (shot)
        line(
          `Screenshot: ${shown(shot)}. Den doesn't scrub images: look at it first. GitHub's issue API takes no images, so it is attached by hand after.`,
          "ap.det.report.shot",
          { path: shown(shot) },
        );

      return {
        ok: true,
        args: {
          kind,
          title,
          ...(description ? { description } : {}),
          repo: c.repo,
          ...(redact ? {} : { redact: false }),
          ...(from ? { from } : {}),
          ...(addTo !== undefined ? { add_to: addTo } : {}),
          ...(fileNew ? { file_new: true } : {}),
          ...(shot ? { screenshot: shot } : {}),
        },
        summary: `file a report on ${c.repo}: ${c.title}`,
        params: { repo: c.repo, title: c.title },
        details,
        detailKeys,
        // Issue 565: a public target is the person's own Allow, always.
        ...(isPublic ? { personOnly: true } : {}),
      };
    },

    async run(a) {
      const from = str(a.from);
      const description =
        typeof a.description === "string" ? a.description : "";
      const c = await compose(
        {
          kind: a.kind,
          title: a.title,
          description: `${description}${description ? "\n\n" : ""}${agentLine(from)}`,
          sections: {},
          redact: a.redact !== false,
          repo: a.repo,
        },
        d,
      );
      if (typeof c === "string") return { ok: false, error: c };
      const r = await fileReport(d, c, {
        who: from ? `agent:${from}` : "agent",
        addTo: typeof a.add_to === "number" ? a.add_to : null,
        fileNew: a.file_new === true,
        by: from ? `agent:${from}` : "agent",
      });
      const shot = str(a.screenshot);
      return r.body.ok === true && shot
        ? {
            ...r.body,
            screenshot: shot,
            next: `Filed. Attach the screenshot (${shown(shot)}) to the issue by hand: GitHub's issue API takes no images.`,
          }
        : r.body;
    },
  };
}
