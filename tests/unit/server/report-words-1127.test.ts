/**
 * Issue 1127: a report (the page's Send, `den report` and the agent's held
 * `report` through fileReport, and the page's send through Den's GitHub
 * App) is checked for listed names before it is filed, the way issue_write
 * is. Only the person's own text is checked (the title and description):
 * the sections Den adds (the page, the version) have any listed name
 * masked, so a person is never asked to rewrite text they didn't write. A
 * refusal carries the hits (field, line, pattern number) for the page to
 * say in the person's language, never the term. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import type * as http from "http";
import * as os from "os";
import * as path from "path";
import {
  filedTextHits,
  filedTextRefusal,
  type FiledText,
} from "../../../src/shared/filed-text-check.js";
import { orgMask, orgPatterns } from "../../../src/shared/org-names.js";
import { feedbackSettings } from "../../../src/shared/report-store.js";
import {
  fileReport,
  handleReportRoutes,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-report-words-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const REPO = "acme-eng/engine";
const LISTED = "zorblax";
const patterns = orgPatterns({ DEN_ORG_NAMES: LISTED });

function deps(diag: Record<string, unknown> = { Den: "den 9.9.9" }) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const asked: { repo: string; fields: string[] }[] = [];
  const sent: { body: Record<string, unknown>; status: number }[] = [];
  let body = "{}";
  const gh = async (args: string[], stdin?: string): Promise<GhResult> => {
    calls.push({ args, stdin });
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
    diagnostics: async () => diag,
    agentOf: () => null,
    personOf: () => "person",
    readBody: async () => body,
    sendJson: (_res, b, status = 200) => {
      sent.push({ body: b as Record<string, unknown>, status });
    },
    // As the server wires them: the destination is public here.
    wordsCheck: async (repo: string, texts: FiledText[]) => {
      asked.push({ repo, fields: texts.map((t) => t.field) });
      const hits = filedTextHits(texts, patterns, repo);
      return hits.length ? { error: filedTextRefusal(hits), hits } : null;
    },
    maskListed: (text: string) => orgMask(text, patterns),
  };
  const setBody = (b: unknown) => {
    body = JSON.stringify(b);
  };
  return { d, calls, asked, sent, setBody };
}

const draft = {
  kind: "bug",
  title: "The bell misses a row",
  description: "Open the bell; a row is missing.",
  repo: REPO,
  fileNew: true,
};

const created = (calls: { args: string[]; stdin?: string }[]) =>
  calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");

describe("issue 1127: a report is checked for listed names before it is filed", () => {
  it("checks the person's title and description, in the destination repo", async () => {
    const f = deps();
    const r = await fileReport(f.d, { ...draft }, "person", "person");
    expect(r.status).toBe(200);
    expect(f.asked).toEqual([{ repo: REPO, fields: ["title", "description"] }]);
    expect(created(f.calls)).toHaveLength(1);
  });

  it("a hit in the person's text files nothing, and answers the hits for the page", async () => {
    const f = deps();
    const r = await fileReport(
      f.d,
      { ...draft, description: "ok\nseen at Zorblax" },
      "person",
      "person",
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      ok: false,
      code: "words",
      hits: [{ field: "description", line: 2, index: 1 }],
    });
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain(LISTED);
    expect(created(f.calls)).toEqual([]);
  });

  it("Den's own sections never trip it: an install address on the list, an empty note, a public repo, and it goes through with no listed name in the filed body", async () => {
    const f = deps({
      Den: "den 9.9.9",
      Page: "http://zorblax-den.lan:7777/projects/zorblax/agents",
    });
    const r = await fileReport(
      f.d,
      {
        ...draft,
        description: "",
        sections: { Den: true, Page: true },
        redact: false,
      },
      "person",
      "person",
    );
    expect(r.status).toBe(200);
    const [c] = created(f.calls);
    expect(c.stdin).toContain("**Page:**");
    expect((c.stdin ?? "").toLowerCase()).not.toContain(LISTED);
  });

  it("the page's send through Den's GitHub App is checked too", async () => {
    const f = deps();
    f.setBody({ ...draft, title: "Zorblax crash" });
    const req = { method: "POST", headers: {} } as http.IncomingMessage;
    handleReportRoutes(
      req,
      {} as http.ServerResponse,
      "/api/report/github-send",
      f.d,
    );
    // The route answers asynchronously.
    for (let i = 0; i < 50 && !f.sent.length; i++)
      await new Promise((r) => setImmediate(r));
    expect(f.sent[0]).toMatchObject({
      status: 400,
      body: { ok: false, code: "words", hits: [{ field: "title", line: 1 }] },
    });
  });
});
