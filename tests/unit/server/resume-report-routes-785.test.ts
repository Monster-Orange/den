/**
 * Issue 785: an agent reports the conversation to resume with its own
 * token (POST /api/agents/self/resume-command { conversation, cwd, seq }):
 * only an id, held to a strict pattern, the newest kept, a refused one
 * logged by its reason and never kept. Its startup command can't change.
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
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(cwd);
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
  const kept = () => readRecord(stateDir, "coder")?.resumeReport;
  return { post, close, cwd, logs, kept };
}

describe("issue 785: POST /api/agents/self/resume-command", () => {
  it("an agent's conversation id is kept on its record, newest by sequence", async () => {
    const t = await setup(agentOf("coder"));
    try {
      const a = await t.post({ conversation: "s-9", cwd: t.cwd, seq: 2 });
      expect(a).toEqual({
        status: 200,
        body: { ok: true, kept: true, seq: 2 },
      });
      expect(t.kept()).toEqual({
        conversation: "s-9",
        cwd: t.cwd,
        seq: 2,
        at: "2026-11-22T10:00:00.000Z",
      });
      // An older or equal one is ignored; the newest stays.
      for (const seq of [1, 2]) {
        const old = await t.post({ conversation: "old", cwd: t.cwd, seq });
        expect(old).toEqual({
          status: 200,
          body: { ok: true, kept: false, seq: 2 },
        });
      }
      expect(t.kept()?.conversation).toBe("s-9");
      const newer = await t.post({ conversation: "s-10", cwd: t.cwd, seq: 3 });
      expect(newer.body).toMatchObject({ kept: true, seq: 3 });
    } finally {
      await t.close();
    }
  });

  it("a whole command, or extra words, in place of an id: refused, never kept", async () => {
    const t = await setup(agentOf("coder"));
    try {
      // A command of its own (the old shape): an unknown field.
      const cmd = await t.post({
        argv: ["bash", "-c", "id"],
        conversation: "s-1",
        cwd: t.cwd,
        seq: 1,
      });
      expect(cmd.status).toBe(400);
      expect(cmd.body).toMatchObject({ code: "unknown_field" });
      // Words in the id: a flag, a second argument, a shell.
      for (const conversation of [
        "--dangerously-bypass-approvals-and-sandbox",
        "s-1 --yolo",
        "bash -c id",
        ["s-1", "--yolo"],
      ]) {
        const r = await t.post({ conversation, cwd: t.cwd, seq: 1 });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: "refused_report" });
      }
      expect(t.kept()).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it("a space, quote, slash or control character in the id: refused and logged by its reason, never its words", async () => {
    const t = await setup(agentOf("coder"));
    try {
      for (const conversation of [
        "a b",
        "sk-secret'x",
        'a"b',
        "a/b",
        "a\nb",
        "a\u001b",
      ]) {
        const r = await t.post({ conversation, cwd: t.cwd, seq: 1 });
        expect(r.status).toBe(400);
        expect(String(r.body.error)).toMatch(/conversation id must be/);
      }
      expect(t.kept()).toBeUndefined();
      expect(t.logs.join("\n")).toMatch(
        /agent coder: resume report refused: its conversation id must be/,
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
        (await t.post({ conversation: "s", cwd: t.cwd, seq: 1 })).status,
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
          (await t.post({ conversation: "s", cwd: t.cwd, seq: 1 })).status,
        ).toBe(404);
      } finally {
        await t.close();
      }
    }
  });

  it("a runtime with no resume template (den-claude, grok): nothing to report, 400", async () => {
    for (const runtime of ["den-claude", "grok"]) {
      const t = await setup(agentOf("coder"), runtime);
      try {
        const r = await t.post({ conversation: "s", cwd: t.cwd, seq: 1 });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: "not_reported" });
      } finally {
        await t.close();
      }
    }
  });
});
