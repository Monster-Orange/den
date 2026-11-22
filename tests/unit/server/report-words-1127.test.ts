/**
 * Issue 1127: a report (the page's Send, `den report` and the agent's held
 * `report`, all through fileReport) is checked for listed names before it
 * is filed, the way issue_write is. A hit files nothing and names the
 * field, line and pattern number, never the term. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { feedbackSettings } from "../../../src/shared/report-store.js";
import {
  fileReport,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-report-words-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const REPO = "acme-eng/engine";

function deps(refusal: string | null) {
  const calls: string[][] = [];
  const asked: { repo: string; fields: string[] }[] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list")
      return { code: 0, stdout: "[]", stderr: "" };
    if (args[0] === "issue" && args[1] === "create")
      return {
        code: 0,
        stdout: `https://github.com/${REPO}/issues/9\n`,
        stderr: "",
      };
    return { code: 0, stdout: "", stderr: "" };
  };
  const d: ReportRouteDeps = {
    settings: () =>
      feedbackSettings({ bugs: `https://github.com/${REPO}/issues` }, {}, {}),
    stateDir: () => stateDir,
    gh,
    names: () => ({ home: "/home/pat", hosts: [] }),
    diagnostics: async () => ({ Den: "den 9.9.9" }),
    agentOf: () => null,
    personOf: () => "person",
    readBody: async () => "",
    sendJson: () => undefined,
    wordsCheck: async (repo, texts) => {
      asked.push({ repo, fields: texts.map((t) => t.field) });
      return refusal;
    },
  };
  return { d, calls, asked };
}

const draft = {
  kind: "bug",
  title: "The bell misses a row",
  description: "Open the bell; a row is missing.",
  repo: REPO,
  fileNew: true,
};

const created = (calls: string[][]) =>
  calls.filter((a) => a[0] === "issue" && a[1] === "create");

describe("issue 1127: a report is checked for listed names before it is filed", () => {
  it("asks the check with the destination repo, the title and the body", async () => {
    const f = deps(null);
    const r = await fileReport(f.d, { ...draft }, "person", "person");
    expect(r.status).toBe(200);
    expect(f.asked).toEqual([{ repo: REPO, fields: ["title", "body"] }]);
    expect(created(f.calls)).toHaveLength(1);
  });

  it("a hit files nothing and answers the check's refusal", async () => {
    const f = deps("title line 1 matches listed pattern #1; nothing was sent");
    const r = await fileReport(f.d, { ...draft }, "person", "person");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "words" });
    expect(String(r.body.error)).toContain("title line 1");
    expect(created(f.calls)).toEqual([]);
  });
});
