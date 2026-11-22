/**
 * Issue 565: `<cli> report`, the Report button from a shell, for the
 * person and for agents. The same routes as the page: the person's preview
 * and send (/api/report/preview, /api/report/send); an agent asks the
 * held write `report` (POST /api/approvals), which waits for the person's
 * Allow on a public destination. Each destination is shown with the
 * page's visibility label. The Den version and the page go with it; a
 * screenshot is a PNG file. A fake web server: nothing is sent anywhere.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cmdFeedback,
  type FeedbackIo,
} from "../../../src/ui/cli/feedback-command.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-report-cli-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function fake(
  o: {
    tty?: boolean;
    answers?: string[];
    env?: Record<string, string>;
    approvals?: Record<string, unknown>[];
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const answers = [...(o.answers ?? [])];
  const states = [
    ...(o.approvals ?? [{ id: "AbCdEfGhIjKlMnOp", state: "pending" }]),
  ];
  const io: FeedbackIo = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: o.env ?? {},
    tty: o.tty ?? true,
    ask: async () => answers.shift() ?? "",
    sleep: async () => undefined,
    waitMs: 10,
    api: async (method, p, body) => {
      calls.push({ method, path: p, body: body as Record<string, unknown> });
      if (p === "/api/report")
        return {
          status: 200,
          data: {
            ok: true,
            repos: [
              { repo: "acme-eng/engine", visibility: "public" },
              { repo: "acme-eng/inside", visibility: "private" },
            ],
          },
        };
      if (p === "/api/report/preview")
        return {
          status: 200,
          data: { ok: true, title: "t", body: "the body", repo: "x" },
        };
      if (p === "/api/report/send")
        return {
          status: 200,
          data: {
            ok: true,
            url: "https://github.com/acme-eng/engine/issues/42",
          },
        };
      if (p === "/api/report/drafts")
        return {
          status: 200,
          data: { ok: true, draft: { id: "0123456789abcdef" } },
        };
      if (p === "/api/approvals" && method === "POST")
        return { status: 202, data: states.shift() ?? {} };
      if (p.startsWith("/api/approvals/"))
        return { status: 200, data: states.shift() ?? { state: "pending" } };
      return { status: 404, data: { ok: false } };
    },
  };
  return {
    io,
    out: () => out.join(""),
    err: () => err.join(""),
    calls,
    sent: () => calls.filter((c) => c.path === "/api/report/send"),
    asked: () => calls.filter((c) => c.path === "/api/approvals"),
  };
}

const AGENT = { DEN_ACTOR_TOKEN: "x" };

describe("issue 565: <cli> report", () => {
  it("shows each destination with the page's visibility label", async () => {
    const f = fake({ answers: ["y"] });
    expect(await cmdFeedback(["--title", "Blank"], f.io)).toBe(0);
    expect(f.out()).toContain("To: acme-eng/engine (Public repository");
    expect(f.out()).toMatch(/visible to everyone/);
    const g = fake({ answers: ["y"] });
    await cmdFeedback(["--title", "Blank", "--repo", "acme-eng/inside"], g.io);
    expect(g.out()).toContain("To: acme-eng/inside (Private repository");
  });

  it("the person's report carries the Den version, the page and a PNG screenshot", async () => {
    const shot = path.join(dir, "s.png");
    fs.writeFileSync(shot, PNG);
    const f = fake({ answers: ["y"] });
    expect(
      await cmdFeedback(
        ["--title", "Blank", "--page", "/agents", "--screenshot", shot],
        f.io,
      ),
    ).toBe(0);
    expect(f.sent()[0]!.body).toMatchObject({
      sections: { Den: true, Page: true },
      client: { Page: "/agents" },
      shot: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    // Not a PNG: nothing is sent.
    const txt = path.join(dir, "n.txt");
    fs.writeFileSync(txt, "text");
    const g = fake({ answers: ["y"] });
    expect(
      await cmdFeedback(["--title", "Blank", "--screenshot", txt], g.io),
    ).toBe(2);
    expect(g.sent()).toHaveLength(0);
  });

  it("an agent asks the held write, never the person's send; it says it waits for the Allow", async () => {
    const f = fake({ env: AGENT, tty: false });
    expect(
      await cmdFeedback(
        ["--title", "Blank", "--page", "/agents", "--description", "x"],
        f.io,
      ),
    ).toBe(0);
    expect(f.sent()).toEqual([]);
    expect(f.asked()[0]!.body).toEqual({
      action: "report",
      args: {
        kind: "bug",
        title: "Blank",
        description: "x",
        page: "/agents",
        repo: "acme-eng/engine",
      },
    });
    expect(f.out()).toMatch(/Waiting for the person's Allow in Den/);
    expect(f.out()).toContain("AbCdEfGhIjKlMnOp");
  });

  it("an agent's report the policy allowed is filed, with its link", async () => {
    const f = fake({
      env: AGENT,
      tty: false,
      approvals: [
        { id: "AbCdEfGhIjKlMnOp", state: "pending" },
        {
          id: "AbCdEfGhIjKlMnOp",
          state: "done",
          result: {
            ok: true,
            url: "https://github.com/acme-eng/inside/issues/9",
          },
        },
      ],
    });
    expect(
      await cmdFeedback(
        ["--title", "Blank", "--repo", "acme-eng/inside"],
        f.io,
      ),
    ).toBe(0);
    expect(f.out()).toContain(
      "✓ Filed: https://github.com/acme-eng/inside/issues/9",
    );
  });

  it("an agent's denied report says nothing was sent", async () => {
    const f = fake({
      env: AGENT,
      tty: false,
      approvals: [
        { id: "AbCdEfGhIjKlMnOp", state: "pending" },
        { id: "AbCdEfGhIjKlMnOp", state: "denied" },
      ],
    });
    expect(await cmdFeedback(["--title", "Blank"], f.io)).toBe(1);
    expect(f.err()).toMatch(/denied.*nothing was sent/);
  });

  it("an agent's screenshot is kept as its own draft first; the ask names it", async () => {
    const shot = path.join(dir, "a.png");
    fs.writeFileSync(shot, PNG);
    const f = fake({ env: AGENT, tty: false });
    await cmdFeedback(["--title", "Blank", "--screenshot", shot], f.io);
    expect(
      f.calls.find((c) => c.path === "/api/report/drafts")?.body?.shot,
    ).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect((f.asked()[0]!.body!.args as Record<string, unknown>).draftId).toBe(
      "0123456789abcdef",
    );
  });
});
