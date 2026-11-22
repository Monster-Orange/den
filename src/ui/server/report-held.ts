/**
 * Issue 565: agents use Report. The held write `report` (the MCP tool
 * `report`, and `<cli> report` run by an agent) files through the page's
 * own path (report-routes.ts): the same destinations, each with the same
 * visibility label (reportDestinations), the same scrub (compose: the
 * redactor every preview and send runs), the same send (fileReport) and
 * an optional screenshot.
 *
 *   - To a public destination, or one whose visibility is not known, it
 *     is the person's own Allow (personOnly): they see what will be
 *     posted, and nothing is sent without it.
 *   - To a private (or internal) one it follows the approval policy like
 *     any other routine write (notify by default).
 *   - The screenshot is the agent's own report draft's (POST
 *     /api/report/drafts, which keeps it here): `draftId`. Only a PNG;
 *     another agent's draft is refused. Filed, the draft goes.
 *   - The audit says who filed it (the agent) and where it went.
 *
 * Filed as the person on GitHub (their `gh`), as the page's Send is.
 */
import type { HeldAction, HeldCheck } from "./approval-routes.js";
import type { AskedBy } from "./approvals.js";
import {
  compose,
  fileReport,
  reportDestinations,
  type DestinationVisibility,
  type ReportRouteDeps,
} from "./report-routes.js";
import { draftStore } from "../../shared/report-store.js";
import { REPORT_ID, pngOfDataUrl } from "../../shared/report-shots.js";
import { visibilityWords, visibleToEveryone } from "../../shared/feedback.js";

/** The line under it: who can read what is posted. */
const VISIBILITY_NOTE: Record<DestinationVisibility, string> = {
  public:
    "The text and the screenshot are visible to everyone. Secrets, tokens, emails, IP addresses and store references are removed first.",
  private: "Only people with access to this repository can see it.",
  internal: "Only people with access to this repository can see it.",
  unknown:
    "Den can't tell who can see this repository, so it is treated as public: the text and the screenshot may be visible to everyone.",
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** The form an ask carries, as the page's send has it. */
function formOf(a: Record<string, unknown>) {
  const page = str(a.page)?.slice(0, 2000);
  return {
    kind: a.kind ?? "bug",
    title: a.title,
    description: typeof a.description === "string" ? a.description : "",
    repo: a.repo,
    // An agent's report is always scrubbed: it can't turn that off.
    redact: true,
    // The Den version always; the page when one is named.
    sections: { Den: true, ...(page ? { Page: true } : {}) },
    client: page ? { Page: page } : {},
    page,
  };
}

/** The agent's own draft's screenshot, or why not. */
function draftShot(
  d: ReportRouteDeps,
  id: unknown,
  agent: string | undefined,
): { shot: string; id: string } | string | null {
  if (id === undefined || id === null || id === "") return null;
  if (typeof id !== "string" || !REPORT_ID.test(id))
    return "draftId: a report draft's id (16 hex)";
  const draft = draftStore(d.stateDir()).get(id);
  if (!draft) return `there is no report draft ${id}`;
  if (agent && draft.by !== `agent:${agent}`)
    return `report draft ${id} is not this agent's`;
  if (!draft.shot) return `report draft ${id} has no screenshot`;
  if (!pngOfDataUrl(draft.shot))
    return `report draft ${id}'s screenshot is not a PNG within the size limit`;
  return { shot: draft.shot, id };
}

export function reportHeld(d: ReportRouteDeps): HeldAction {
  return {
    async check(a, who): Promise<HeldCheck> {
      const s = d.settings();
      if (!s.enabled)
        return {
          ok: false,
          error: "reports are turned off here (feedback.enabled: false)",
        };
      const f = formOf(a);
      const repo = str(f.repo) ?? s.repos[0];
      if (!repo || !s.repos.includes(repo))
        return {
          ok: false,
          error: `repo: one of this install's report destinations: ${s.repos.join(", ") || "none"}`,
        };
      const shot = draftShot(d, a.draftId, who?.agent);
      if (typeof shot === "string") return { ok: false, error: shot };
      const c = await compose({ ...f, repo }, d);
      if (typeof c === "string") return { ok: false, error: c };
      const dest = await reportDestinations(d);
      const vis: DestinationVisibility =
        dest.repos.find((r) => r.repo === repo)?.visibility ?? "unknown";
      const addTo =
        typeof a.addTo === "number" && Number.isSafeInteger(a.addTo)
          ? a.addTo
          : undefined;
      if (addTo !== undefined && addTo < 1)
        return { ok: false, error: "addTo: an issue number" };
      const where = `${repo} (${visibilityWords(vis)})`;
      const lines: string[] = [
        `Goes to: ${where}`,
        `${visibilityWords(vis)}: ${VISIBILITY_NOTE[vis]}`,
        addTo !== undefined
          ? `Added as a comment to issue ${addTo}.`
          : `Title: ${c.title}`,
        "Filed on GitHub as you (your gh sign-in). What will be posted:",
        c.body,
        ...(shot
          ? [
              "With a screenshot the agent took. Den does not mask a screenshot: only the text above is scrubbed.",
            ]
          : []),
      ];
      const visKey = {
        public: "pub",
        private: "priv",
        internal: "int",
        unknown: "unk",
      }[vis];
      return {
        ok: true,
        args: {
          kind: f.kind,
          title: f.title,
          description: f.description,
          repo,
          redact: f.redact,
          ...(f.page ? { page: f.page } : {}),
          ...(addTo !== undefined ? { addTo } : {}),
          ...(a.fileNew === true ? { fileNew: true } : {}),
          ...(shot ? { draftId: shot.id } : {}),
        },
        summary: `file a report on ${where}: ${c.title}`,
        params: { repo, vis: visibilityWords(vis), title: c.title },
        details: lines,
        detailKeys: [
          { key: "ap.det.report.to", vars: { repo } },
          { key: `ap.det.report.${visKey}` },
          null,
          { key: "ap.det.report.as" },
          null,
          ...(shot ? [{ key: "ap.det.report.shot" }] : []),
        ],
        // Issue 565: a public (or not known) destination is the person's own.
        personOnly: visibleToEveryone(vis),
      };
    },
    async run(a, asked?: AskedBy) {
      const f = formOf(a);
      const shot = draftShot(d, a.draftId, undefined);
      if (typeof shot === "string") return { ok: false, error: shot };
      const by = asked?.agent ? `agent:${asked.agent}` : "person";
      const r = await fileReport(
        d,
        {
          ...f,
          ...(typeof a.addTo === "number" ? { addTo: a.addTo } : {}),
          ...(a.fileNew === true ? { fileNew: true } : {}),
          ...(shot ? { shot: shot.shot, draftId: shot.id } : {}),
        },
        // The hour's limit is the person's: it is filed as them.
        "person",
        by,
      );
      return r.body;
    },
  };
}
