/**
 * FB (den#81): `<cli> feedback`, Report an issue from a shell. The same
 * routes as the page (/api/report/preview, /api/report/send): the preview
 * is printed, then y/N. Off a terminal it is refused unless --yes; an
 * agent is always refused (agents save drafts through MCP). F4 (no
 * GitHub), F5 (the same title open), F7 (the hour's limit).
 *
 * A fake web server and a fake terminal: nothing is sent anywhere.
 */
import { describe, expect, it } from "@jest/globals";
import {
  cmdFeedback,
  type FeedbackIo,
} from "../../../src/ui/cli/feedback-command.js";

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function fake(
  opts: {
    tty?: boolean;
    answers?: string[];
    env?: Record<string, string>;
    send?: [number, Record<string, unknown>][];
    info?: [number, Record<string, unknown>];
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const asked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const sends = [...(opts.send ?? [])];
  const io: FeedbackIo = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: opts.env ?? {},
    tty: opts.tty ?? true,
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
    api: async (method, path, body) => {
      calls.push({ method, path, body: body as Record<string, unknown> });
      if (path === "/api/report")
        return opts.info
          ? { status: opts.info[0], data: opts.info[1] }
          : {
              status: 200,
              data: { ok: true, repos: [{ repo: "acme-eng/engine" }] },
            };
      if (path === "/api/report/preview")
        return {
          status: 200,
          data: {
            ok: true,
            title: (body as { title: string }).title,
            body: "**Kind:** bug\n\nIt drops at <host-1>.",
            repo: "acme-eng/engine",
          },
        };
      if (path === "/api/report/send") {
        const [status, data] = sends.shift() ?? [
          200,
          {
            ok: true,
            url: "https://github.com/acme-eng/engine/issues/42",
            repo: "acme-eng/engine",
            added: false,
          },
        ];
        return { status, data };
      }
      return { status: 404, data: { ok: false } };
    },
  };
  return {
    io,
    out: () => out.join(""),
    err: () => err.join(""),
    calls,
    asked,
    sent: () => calls.filter((c) => c.path === "/api/report/send"),
  };
}

const ARGS = ["--title", "Pane drops", "--description", "It drops."];

describe("FB: <cli> feedback", () => {
  it("prints the server's preview, asks y/N, and sends it only on y", async () => {
    const f = fake({ answers: ["y"] });
    expect(await cmdFeedback(ARGS, f.io)).toBe(0);
    expect(f.out()).toContain("To: acme-eng/engine");
    expect(f.out()).toContain("It drops at <host-1>.");
    expect(f.asked).toEqual(["Send this to acme-eng/engine on GitHub? [y/N] "]);
    expect(f.sent()).toHaveLength(1);
    expect(f.sent()[0]!.body).toMatchObject({
      kind: "bug",
      title: "Pane drops",
      description: "It drops.",
      repo: "acme-eng/engine",
      redact: true,
    });
    expect(f.out()).toContain(
      "✓ Filed: https://github.com/acme-eng/engine/issues/42",
    );
  });

  it("anything but y sends nothing", async () => {
    for (const a of ["", "n", "no", "maybe"]) {
      const f = fake({ answers: [a] });
      expect(await cmdFeedback(ARGS, f.io)).toBe(1);
      expect(f.sent()).toHaveLength(0);
      expect(f.out()).toContain("Not sent.");
    }
  });

  it("asks for what isn't given on a terminal: kind, title, description", async () => {
    const f = fake({ answers: ["idea", "Dark bell", "Too bright.", "y"] });
    expect(await cmdFeedback([], f.io)).toBe(0);
    expect(f.sent()[0]!.body).toMatchObject({
      kind: "idea",
      title: "Dark bell",
      description: "Too bright.",
    });
  });

  it("off a terminal: refused without --yes; with --yes it sends without asking", async () => {
    const f = fake({ tty: false });
    expect(await cmdFeedback(ARGS, f.io)).toBe(2);
    expect(f.err()).toMatch(/needs a person at a terminal/);
    expect(f.calls).toHaveLength(0);
    const g = fake({ tty: false });
    expect(await cmdFeedback([...ARGS, "--yes"], g.io)).toBe(0);
    expect(g.asked).toEqual([]);
    expect(g.sent()).toHaveLength(1);
    // Off a terminal the title must be given.
    const h = fake({ tty: false });
    expect(await cmdFeedback(["--yes"], h.io)).toBe(2);
    expect(h.err()).toMatch(/--title/);
  });

  it("an agent is refused, even with --yes: its reports stay drafts for a person", async () => {
    const f = fake({ env: { DEN_ACTOR_TOKEN: "x" }, tty: false });
    expect(await cmdFeedback([...ARGS, "--yes"], f.io)).toBe(1);
    expect(f.err()).toMatch(/only a person sends a report/);
    expect(f.calls).toHaveLength(0);
  });

  it("--preview prints it and sends nothing", async () => {
    const f = fake({ tty: false });
    expect(await cmdFeedback([...ARGS, "--preview"], f.io)).toBe(0);
    expect(f.out()).toContain("It drops at <host-1>.");
    expect(f.sent()).toHaveLength(0);
  });

  it("the same title open (F5): add to it, file a new one, or cancel", async () => {
    const dup: [number, Record<string, unknown>] = [
      409,
      {
        ok: false,
        duplicate: {
          number: 7,
          title: "Pane drops",
          url: "https://github.com/acme-eng/engine/issues/7",
        },
      },
    ];
    const added: [number, Record<string, unknown>] = [
      200,
      {
        ok: true,
        url: "https://github.com/acme-eng/engine/issues/7#c",
        repo: "acme-eng/engine",
        added: true,
      },
    ];
    const f = fake({ answers: ["y", "a"], send: [dup, added] });
    expect(await cmdFeedback(ARGS, f.io)).toBe(0);
    expect(f.sent()[1]!.body).toMatchObject({ addTo: 7 });
    expect(f.out()).toContain("✓ Added to #7");
    const g = fake({ answers: ["y", "n"], send: [dup] });
    expect(await cmdFeedback(ARGS, g.io)).toBe(0);
    expect(g.sent()[1]!.body).toMatchObject({ fileNew: true });
    const h = fake({ answers: ["y", ""], send: [dup] });
    expect(await cmdFeedback(ARGS, h.io)).toBe(1);
    expect(h.sent()).toHaveLength(1);
    // --yes doesn't choose for the person: it says how to.
    const k = fake({ tty: false, send: [dup] });
    expect(await cmdFeedback([...ARGS, "--yes"], k.io)).toBe(1);
    expect(k.err()).toMatch(/--add-to 7.*--new/);
    // Given up front, no question.
    const m = fake({ answers: ["y"], send: [added] });
    expect(await cmdFeedback([...ARGS, "--add-to", "7"], m.io)).toBe(0);
    expect(m.sent()[0]!.body).toMatchObject({ addTo: 7 });
  });

  it("no GitHub sign-in (F4): nothing sent, says how, and gives the browser link", async () => {
    const f = fake({
      answers: ["y"],
      send: [
        [
          409,
          {
            ok: false,
            need: "github",
            error: "sending needs a GitHub sign-in: nothing was sent",
            newIssueUrl:
              "https://github.com/acme-eng/engine/issues/new?title=x",
          },
        ],
      ],
    });
    expect(await cmdFeedback(ARGS, f.io)).toBe(1);
    expect(f.err()).toContain("gh auth login");
    expect(f.err()).toContain(
      "https://github.com/acme-eng/engine/issues/new?title=x",
    );
  });

  it("over the hour's limit (F7), turned off, or the web app down: says so", async () => {
    const f = fake({
      answers: ["y"],
      send: [[429, { ok: false, error: "at most 5 reports an hour" }]],
    });
    expect(await cmdFeedback(ARGS, f.io)).toBe(1);
    expect(f.err()).toContain("at most 5 reports an hour");
    const off = fake({
      info: [404, { ok: false, error: "reports are turned off here" }],
    });
    expect(await cmdFeedback(ARGS, off.io)).toBe(1);
    expect(off.err()).toContain("reports are turned off here");
    const down = fake();
    down.io.api = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await cmdFeedback(ARGS, down.io)).toBe(1);
    expect(down.err()).toMatch(/web app is not running/);
  });

  it("--kind, --repo and --no-redact go to the server; a wrong kind or repo is refused", async () => {
    const f = fake({ answers: ["y"] });
    await cmdFeedback(
      [
        ...ARGS,
        "--kind",
        "question",
        "--repo",
        "acme-eng/engine",
        "--no-redact",
      ],
      f.io,
    );
    expect(f.sent()[0]!.body).toMatchObject({
      kind: "question",
      redact: false,
    });
    expect(await cmdFeedback([...ARGS, "--kind", "rant"], fake().io)).toBe(2);
    const r = fake();
    expect(await cmdFeedback([...ARGS, "--repo", "other/repo"], r.io)).toBe(2);
    expect(r.err()).toContain("acme-eng/engine");
  });
});
