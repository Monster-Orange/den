import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function runGate(agents: Record<string, unknown[]>) {
  const js = `
    const g = await import("./gate/340.mjs");
    const agents = ${JSON.stringify(agents)};
    const ctx = {
      api: async (p) => (p === "/api/workspaces" ? { workspaces: Object.fromEntries(Object.keys(agents).map((w) => [w, {}])) } : null),
      cli: (args) => {
        if (args[0] === "doctor") return { code: 0, out: JSON.stringify({ checks: [{ id: "web", status: "ok", detail: "up" }] }), err: "" };
        const w = args.indexOf("-w");
        if (w < 0) return { code: 2, out: "", err: "✗ agents list needs -w <project>" };
        return { code: 0, out: JSON.stringify(agents[args[w + 1]] ?? []), err: "" };
      },
    };
    let out;
    try {
      const r = await g.run(ctx, await g.setup(ctx));
      out = { result: r, rows: g.expect(r) };
    } catch (e) { out = { error: String(e?.message ?? e) }; }
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    error?: string;
    result?: { projects: number; agents: number };
    rows?: Row[];
  };
}

describe("gate/340.mjs reads each project's agents (agents list needs -w)", () => {
  it("two projects' agents with account labels: the label row passes, with every agent counted", () => {
    const r = runGate({
      north: [{ agent: "a1", signIn: "Work" }],
      south: [{ agent: "b1", signIn: "Personal" }, { agent: "b2" }],
    });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ projects: 2, agents: 3 });
    expect(r.rows?.[0]).toMatchObject({
      ok: true,
      detail: "a1: Work, b1: Personal",
    });
  });

  it("an email as the label fails the label row", () => {
    const r = runGate({
      north: [{ agent: "a1", signIn: "someone@example.test" }],
    });
    expect(r.rows?.[0].ok).toBe(false);
  });

  it("no agent on a vendor account: the label row skips, saying how many were listed", () => {
    const r = runGate({ north: [{ agent: "a1" }] });
    expect(r.rows?.[0]).toMatchObject({
      ok: null,
      skip: "needs-always-on-service",
    });
    expect(r.rows?.[0].detail).toMatch(/^1 agents listed/);
  });
});
