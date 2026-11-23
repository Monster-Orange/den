/**
 * Issue 785, slice 3: an agent reports its resume command with its own
 * token (POST /api/agents/self/resume-command), whatever its runtime:
 * checked strictly, the newest kept, a refused one logged and kept out.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import {
  handleResumeReportRoutes,
  RESUME_REPORT_PATH,
} from "../../../src/ui/server/resume-report-routes.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const agentOf = (id: string, workspace = "north") => ({
  kind: "agent",
  actor: `agent:${id}`,
  workspace,
  grants: [],
  session: { name: "s" },
});

async function setup(principal: unknown, runtime = "codex") {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-785r-")),
  );
  tmps.push(dir);
  const stateDir = path.join(dir, "state");
  const cwd = path.join(dir, "north");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  writeRecord(stateDir, {
    id: "coder",
    persona: "planner",
    runtime,
    workspace: "north",
    cwd,
    session: { backend: "den-pty", id: "s-1" },
    sessionName: "acme-north:coder",
    startedAt: "2026-11-22T09:00:00.000Z",
  } as never);
  const logs: string[] = [];
  const server = http.createServer((req, res) => {
    void handleResumeReportRoutes(
      req,
      res,
      new URL(req.url!, "http://x").pathname,
      {
        stateDir: () => stateDir,
        env: () => ({ PATH: bin }),
        principal: () => principal as never,
        log: (l) => logs.push(l),
        now: () => new Date("2026-11-22T10:00:00.000Z"),
      },
    ).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const post = async (body: unknown, method = "POST") => {
    const r = await fetch(`http://127.0.0.1:${port}${RESUME_REPORT_PATH}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: r.status,
      body: (await r.json()) as Record<string, unknown>,
    };
  };
  const close = () => new Promise((r) => server.close(r));
  return { post, close, stateDir, cwd, logs };
}

describe("issue 785: POST /api/agents/self/resume-command", () => {
  it("an agent's report is kept on its record, newest by sequence", async () => {
    const t = await setup(agentOf("coder"));
    try {
      const a = await t.post({
        argv: ["codex", "resume", "s-9"],
        cwd: t.cwd,
        seq: 2,
      });
      expect(a).toEqual({
        status: 200,
        body: { ok: true, kept: true, seq: 2 },
      });
      expect(readRecord(t.stateDir, "coder")?.resumeReport).toEqual({
        argv: ["codex", "resume", "s-9"],
        cwd: t.cwd,
        seq: 2,
        at: "2026-11-22T10:00:00.000Z",
      });
      // An older or equal one is ignored; the newest stays.
      for (const seq of [1, 2]) {
        const old = await t.post({
          argv: ["codex", "resume", "old"],
          cwd: t.cwd,
          seq,
        });
        expect(old).toEqual({
          status: 200,
          body: { ok: true, kept: false, seq: 2 },
        });
      }
      expect(readRecord(t.stateDir, "coder")?.resumeReport?.argv).toEqual([
        "codex",
        "resume",
        "s-9",
      ]);
      const newer = await t.post({
        argv: ["codex", "resume", "s-10"],
        cwd: t.cwd,
        seq: 3,
      });
      expect(newer.body).toMatchObject({ kept: true, seq: 3 });
    } finally {
      await t.close();
    }
  });

  it("a command that breaks a rule is refused (400), logged without its words, and not kept", async () => {
    const t = await setup(agentOf("coder"));
    try {
      const bad = await t.post({
        argv: ["codex", "resume", "--token=sk-secret'x"],
        cwd: t.cwd,
        seq: 1,
      });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ ok: false, code: "refused_command" });
      expect(String(bad.body.error)).toMatch(/apostrophe/);
      expect(readRecord(t.stateDir, "coder")?.resumeReport).toBeUndefined();
      expect(t.logs.join("\n")).toMatch(
        /coder.*resume command refused: a word has an apostrophe/,
      );
      expect(t.logs.join("\n")).not.toMatch(/sk-secret/);
    } finally {
      await t.close();
    }
  });

  it("only an agent's own token; POST only", async () => {
    const t = await setup(null);
    try {
      expect(
        (await t.post({ argv: ["codex"], cwd: t.cwd, seq: 1 })).status,
      ).toBe(403);
      expect((await t.post(undefined, "GET")).status).toBe(405);
    } finally {
      await t.close();
    }
  });

  it("an agent with no record here, or in another project: 404", async () => {
    for (const p of [agentOf("ghost"), agentOf("coder", "south")]) {
      const t = await setup(p);
      try {
        expect(
          (await t.post({ argv: ["codex"], cwd: t.cwd, seq: 1 })).status,
        ).toBe(404);
      } finally {
        await t.close();
      }
    }
  });

  it("a runtime that resumes by its own id (den-claude) has nothing to report: 400", async () => {
    const t = await setup(agentOf("coder"), "den-claude");
    try {
      const r = await t.post({ argv: ["claude"], cwd: t.cwd, seq: 1 });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: "not_reported" });
    } finally {
      await t.close();
    }
  });
});
