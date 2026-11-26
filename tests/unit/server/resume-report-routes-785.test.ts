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
  resetResumeReportChecks,
  RESUME_REPORT_PATH,
} from "../../../src/ui/server/resume-report-routes.js";

const tmps: string[] = [];
afterEach(() => {
  resetResumeReportChecks();
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

async function setup(
  principal: unknown,
  runtime = "codex",
  o: { minSeconds?: number; now?: () => Date } = {},
) {
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
  const codexHome = path.join(dir, "codex");
  /** Codex's session file for thread `id` (a sub-agent's with `parent`). */
  const thread = (id: string, parent?: string) => {
    const day = path.join(codexHome, "sessions", "2026", "11", "22");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, `rollout-2026-11-22T10-00-00-${id}.jsonl`),
      JSON.stringify({
        timestamp: "2026-11-22T10:00:00.000Z",
        type: "session_meta",
        payload: {
          session_id: parent ?? id,
          id,
          ...(parent ? { parent_thread_id: parent } : {}),
          timestamp: "2026-11-22T10:00:00.000Z",
          cwd,
          originator: "codex_cli_rs",
          cli_version: "0.171.0",
          source: "cli",
        },
      }) + "\n",
    );
  };
  for (const id of ["s-1", "s-9", "s-10"]) thread(id);
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
        now: o.now ?? (() => new Date("2026-11-22T10:00:00.000Z")),
        // Codex's own session records: this test's, never this machine's.
        env: { CODEX_HOME: codexHome, HOME: dir },
        limits: () => ({
          firstLineMaxBytes: 1024 * 1024,
          minSeconds: o.minSeconds ?? 0,
        }),
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
  const url = `http://127.0.0.1:${port}`;
  return { post, close, cwd, logs, kept, stateDir, url, thread, codexHome };
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

describe("issue 785: the report's write is safe (security review)", () => {
  it("a person's change to the record while the body is held open survives", async () => {
    const t = await setup(agentOf("coder"));
    try {
      const url = new URL(t.url);
      const body = JSON.stringify({ conversation: "s-1", cwd: t.cwd, seq: 1 });
      const done = new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: url.hostname,
            port: url.port,
            path: RESUME_REPORT_PATH,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        // Half the body now; the person narrows the record; then the rest.
        req.write(body.slice(0, 10));
        setTimeout(() => {
          const rec = readRecord(t.stateDir, "coder")!;
          writeRecord(t.stateDir, { ...rec, grants: [] } as never);
          req.end(body.slice(10));
        }, 150);
      });
      expect(await done).toBe(200);
      const rec = readRecord(t.stateDir, "coder") as unknown as {
        grants?: string[];
        resumeReport?: { conversation: string };
      };
      expect(rec.grants).toEqual([]);
      expect(rec.resumeReport?.conversation).toBe("s-1");
    } finally {
      await t.close();
    }
  });

  it("an unknown field is logged without the agent's text; the reply names it cleaned and short", async () => {
    const t = await setup(agentOf("coder"));
    try {
      const key = `x\nagent planner: forged line ${"y".repeat(100)}`;
      const r = await t.post({
        conversation: "s",
        cwd: t.cwd,
        seq: 1,
        [key]: 1,
      });
      expect(r.status).toBe(400);
      expect(t.logs).toEqual([
        "agent coder: resume report refused: unknown field",
      ]);
      expect(String(r.body.error)).toMatch(
        /^[A-Za-z0-9_]{1,32}…?: unknown field/,
      );
      expect(String(r.body.error)).not.toMatch(/\n|forged line/);
    } finally {
      await t.close();
    }
  });

  it("a conversation another agent's record holds is refused", async () => {
    const t = await setup(agentOf("coder"));
    try {
      writeRecord(t.stateDir, {
        id: "other",
        persona: "planner",
        runtime: "codex",
        workspace: "north",
        cwd: t.cwd,
        session: { backend: "den-pty", id: "s-2" },
        sessionName: "acme-north:other",
        startedAt: "2026-11-22T09:00:00.000Z",
        resumeReport: { conversation: "theirs-1", cwd: t.cwd, seq: 4 },
      } as never);
      const r = await t.post({ conversation: "theirs-1", cwd: t.cwd, seq: 1 });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: "refused_report" });
      expect(String(r.body.error)).toMatch(/another agent's conversation/);
      expect(t.kept()).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});

describe("issue 785: an agent's read-only view can't report (issue 796)", () => {
  it("only a real agent token counts here, not a view of one", async () => {
    const { agentPrincipalOf, agentTokenPrincipalOf, setPrincipal } =
      await import("../../../src/ui/server/request-guard.js");
    const req = {} as http.IncomingMessage;
    setPrincipal(req, {
      kind: "person-browser",
      view: { agent: "agent:coder", workspace: "north" },
    } as never);
    expect(agentPrincipalOf(req)?.actor).toBe("agent:coder");
    expect(agentTokenPrincipalOf(req)).toBeNull();
    const tok = {} as http.IncomingMessage;
    setPrincipal(tok, agentOf("coder") as never);
    expect(agentTokenPrincipalOf(tok)?.actor).toBe("agent:coder");
  });
});

describe("issue 785: a Codex sub-agent's report never replaces its main thread's", () => {
  it("a thread Codex's own record names a sub-agent's: refused, the main thread's report kept", async () => {
    const t = await setup(agentOf("coder"));
    try {
      expect(
        (await t.post({ conversation: "s-9", cwd: t.cwd, seq: 1 })).body,
      ).toMatchObject({ kept: true });
      t.thread("child-1", "s-9");
      const r = await t.post({ conversation: "child-1", cwd: t.cwd, seq: 2 });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ ok: false, code: "not_main_thread" });
      expect(t.kept()?.conversation).toBe("s-9");
      expect(t.logs.join("\n")).not.toMatch(/child-1/);
    } finally {
      await t.close();
    }
  });

  it("a thread with no record of Codex's own: refused", async () => {
    const t = await setup(agentOf("coder"));
    try {
      const r = await t.post({ conversation: "nowhere", cwd: t.cwd, seq: 1 });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: "not_main_thread" });
      expect(t.kept()).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});

describe("issue 785: a report's check never stalls Den (security review)", () => {
  it("the same conversation again, with a higher sequence: kept without reading Codex's files", async () => {
    const t = await setup(agentOf("coder"));
    try {
      expect(
        (await t.post({ conversation: "s-9", cwd: t.cwd, seq: 1 })).body,
      ).toMatchObject({ kept: true });
      // Codex's store is gone: a check would refuse it. None runs.
      fs.rmSync(t.codexHome, { recursive: true, force: true });
      expect(
        (await t.post({ conversation: "s-9", cwd: t.cwd, seq: 2 })).body,
      ).toMatchObject({ kept: true, seq: 2 });
    } finally {
      await t.close();
    }
  });

  it("a new conversation sooner than agents.resume_report_min_seconds after the last check: 429", async () => {
    const t = await setup(agentOf("coder"), "codex", { minSeconds: 5 });
    try {
      expect(
        (await t.post({ conversation: "s-9", cwd: t.cwd, seq: 1 })).status,
      ).toBe(200);
      const r = await t.post({ conversation: "s-10", cwd: t.cwd, seq: 2 });
      expect(r.status).toBe(429);
      expect(r.body).toMatchObject({ code: "too_soon" });
      expect(t.kept()?.conversation).toBe("s-9");
    } finally {
      await t.close();
    }
  });

  it("other requests are answered while a report's check walks a large store", async () => {
    const t = await setup(agentOf("coder"));
    try {
      // Hundreds of day folders after the agent's creation, none of them
      // the thread's.
      for (let m = 11; m <= 12; m++)
        for (let d = 1; d <= 28; d++)
          for (const y of ["2026", "2027", "2028"])
            fs.mkdirSync(
              path.join(
                t.codexHome,
                "sessions",
                y,
                String(m).padStart(2, "0"),
                String(d).padStart(2, "0"),
              ),
              { recursive: true },
            );
      let ticks = 0;
      const timer = setInterval(() => ticks++, 0);
      const r = await t.post({ conversation: "nowhere", cwd: t.cwd, seq: 1 });
      clearInterval(timer);
      expect(r.status).toBe(400);
      // The event loop ran timers while the walk went on: it never blocked.
      expect(ticks).toBeGreaterThan(2);
    } finally {
      await t.close();
    }
  });

  it("a millisecond sequence more than a day ahead: refused", async () => {
    const t = await setup(agentOf("coder"));
    try {
      const ahead = Date.parse("2026-11-24T10:00:00.000Z");
      const r = await t.post({ conversation: "s-9", cwd: t.cwd, seq: ahead });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/more than a day ahead/);
      const soon = Date.parse("2026-11-22T10:05:00.000Z");
      expect(
        (await t.post({ conversation: "s-9", cwd: t.cwd, seq: soon })).status,
      ).toBe(200);
    } finally {
      await t.close();
    }
  });
});
