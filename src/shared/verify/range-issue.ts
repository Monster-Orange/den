/**
 * Issue 212 follow-up: "Open an issue with this range" (S5). The issue a
 * person files on the failing check's own repo: which check, where, the
 * first failing run and commit, the last passing one, the commits in
 * between, the failure's first line and the recent results. Plain words
 * about the check only: nothing about the install or its names.
 */
import type { ModuleHistory } from "./history.js";

export interface RangeIssueInput {
  project: string;
  module: { id: string; name: string; kind: string };
  history: ModuleHistory;
  /** The commits after the last pass, up to the first failure (git's). */
  commits?: { commit: string; subject: string }[];
}

/** One line, with nothing that can break out of inline code or a list. */
const line = (s: string): string =>
  (s.split("\n")[0] ?? "").replace(/`/g, "'").trim().slice(0, 300);

const MARK: Record<string, string> = {
  passed: "✓",
  failed: "✕",
  error: "!",
  blocked: "‖",
};

/** The issue's title and body; null when the check isn't failing now. */
export function rangeIssue(
  i: RangeIssueInput,
): { title: string; body: string } | null {
  const h = i.history;
  const r = h.range;
  if (!r) return null;
  const first = r.firstFailed.commit ?? "an unknown commit";
  const failing = h.runs.find((x) => x.runId === r.firstFailed.runId);
  const lines = [
    `\`${line(i.module.name)}\` (${line(i.module.kind)}) fails on **${line(h.env)}** in project ${line(i.project)}.`,
    "",
    `- First failing run: \`${line(r.firstFailed.runId)}\`, at commit \`${line(first)}\``,
    r.lastPassed
      ? `- Last passing run: \`${line(r.lastPassed.runId)}\`, at commit \`${line(r.lastPassed.commit ?? "unknown")}\``
      : "- It has not passed in the runs Den keeps.",
  ];
  if (failing?.message) lines.push("", `> ${line(failing.message)}`);
  if (i.commits?.length) {
    lines.push("", "### Commits in between");
    for (const c of i.commits)
      lines.push(`- \`${line(c.commit)}\` ${line(c.subject)}`);
  } else if (r.lastPassed?.commit)
    lines.push(
      "",
      `Commits from \`${line(r.lastPassed.commit)}\` to \`${line(first)}\`: see \`git log ${line(r.lastPassed.commit)}..${line(first)}\`.`,
    );
  lines.push(
    "",
    `### Last ${h.runs.length} runs on ${line(h.env)}, oldest first`,
    "",
    h.runs
      .map((x) =>
        x.state === "passed" && x.flaky ? "↻" : (MARK[x.state] ?? "?"),
      )
      .join(" "),
    "",
    "✓ passed, ✕ failed, ↻ passed after a retry.",
  );
  return {
    title: `${line(i.module.name)} fails on ${line(h.env)} since ${line(first)}`,
    body: lines.join("\n") + "\n",
  };
}
