/**
 * Issue 335's live check (gate/335.mjs), clauses 3 and 5, on a fake bed:
 * an agent in the server's project gets it and one in another project
 * doesn't (read from each one's agent-files/<id>/mcp.json); the headers
 * come back inside the agent's session and the harness finds the bearer
 * in none of the paths searched. Each clause skips only for what the bed
 * or the harness lacks, naming it, and teardown removes both stubs.
 * A fake ctx (no bed, no browser), in a child node: the gate file is ESM.
 * The bearer here is invented, and the check never holds it.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const GATE = path.join(ROOT, "gate", "335.mjs");

type Row = {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
};
type Out = {
  rows: Row[] | null;
  error: string | null;
  removed: string[];
  started: string[];
};

interface Opts {
  refSet?: boolean;
  noSecretSeen?: boolean;
  noWorkspace?: boolean;
  leakToB?: boolean;
  hit?: boolean;
  searchNothing?: boolean;
  /** ctx.transcriptPath: "file" (each stub has one), "none" (null), "missing" (no method). */
  transcript?: "file" | "none" | "missing";
  hitTranscript?: boolean;
  /** The harness reads nothing under Den's state folder (only the transcripts). */
  stateUnsearched?: boolean;
  refuse?: boolean;
}

function onBed(o: Opts = {}): Out {
  const js = `
    const g = await import(${JSON.stringify(GATE)});
    const o = ${JSON.stringify(o)};
    const records = new Map(); // id -> workspace
    const removed = [], started = [];
    const cfg = (ws) => {
      const s = { den: { type: "stdio" } };
      if (ws === "default" || o.leakToB)
        s["gate-mcp"] = { type: "http", url: "http://127.0.0.1:7898/mcp",
          headersHelper: "DEN_X=/bed/x /bed/bin/den-gate mcp headers gate-mcp" };
      return JSON.stringify({ mcpServers: s });
    };
    const ctx = {
      url: "http://bed.invalid",
      cli: () => ({ code: 0, err: "", out:
        "  mcp server  " + (o.refSet === false ? "⚠" : "✓") + "  default: gate-mcp http://127.0.0.1:7898/mcp" +
        (o.refSet === false ? ": secrets.refs.gate_mcp is not set, so its calls carry no bearer" : "") + "\\n" }),
      // As the bed's driver: Den's state files only under "state:"; the bed's own folder has none.
      readBed: async (rel) => {
        if (!rel.startsWith("state:")) return null;
        rel = rel.slice("state:".length);
        let m = /^agents\\/(.+)\\.json$/.exec(rel);
        if (m) return records.has(m[1]) ? JSON.stringify({ id: m[1], workspace: records.get(m[1]) }) : null;
        m = /^agent-files\\/(.+)\\/mcp\\.json$/.exec(rel);
        if (m) return records.has(m[1]) ? cfg(records.get(m[1])) : null;
        return null;
      },
      agent: async (id, opts) => {
        const ws = (!o.noWorkspace && opts?.workspace) || "default";
        const h = {
          id,
          ...(o.noWorkspace ? {} : { workspace: ws }),
          start() {
            if (o.refuse && ws !== "default") return { code: 1, all: "✗ agents.max_concurrent is 1" };
            records.set(id, ws); started.push(id + "@" + ws);
            return { code: 0, all: "started" };
          },
          running: async () => 10,
          stop: async () => ({ code: 0 }),
          remove: async () => { removed.push(id); records.delete(id); return { code: 0 }; },
        };
        h.sh = async () => ({ status: 0, out: '{"Authorization":"Bearer <redacted>"}', err: "" });
        return h;
      },
      goto: async () => {},
      shot: async () => {},
    };
    // The harness's answer: how many files it read under paths, and the paths that held the value.
    // A path in Den's state folder needs "state:"; without it (or with stateUnsearched) it reads nothing.
    const filesIn = (p) => {
      if (p.endsWith(".jsonl")) return 1;
      if (!p.startsWith("state:") || o.stateUnsearched) return 0;
      const rel = p.slice("state:".length);
      if (rel === "sessions" || rel === "logs") return 2;
      const m = /^(?:agent-files\\/|agents\\/)([^/]+?)(?:\\.json)?$/.exec(rel);
      return m && records.has(m[1]) ? 1 : 0;
    };
    if (!o.noSecretSeen) ctx.secretSeen = async (ref, paths) =>
      o.refSet === false ? { searched: 0, hits: [], error: "no test value for " + ref }
      : o.searchNothing ? { searched: 0, hits: [] }
      : { searched: paths.reduce((n, p) => n + filesIn(p), 0), hits: [
          ...(o.hit ? [paths[0] + "/mcp.json"] : []),
          ...(o.hitTranscript ? paths.filter((p) => p.endsWith(".jsonl")) : []),
        ] };
    // The stub's own transcript, outside the bed's folder; null: no record or no file yet.
    if (o.transcript !== "missing") ctx.transcriptPath = (id) =>
      o.transcript === "none" || !records.has(id) ? null : "/runtime/projects/bed/" + id + ".jsonl";
    const page = {
      locator: () => ({ waitFor: async () => {}, scrollIntoViewIfNeeded: async () => {} }),
      waitForSelector: async () => {},
      evaluate: async () => ({ none: false, error: null,
        servers: [{ name: "gate-mcp", text: "gate-mcp http://127.0.0.1:7898/mcp" }], text: "gate-mcp http://127.0.0.1:7898/mcp" }),
    };
    const out = { rows: null, error: null, removed, started };
    let state;
    const cells = [];
    try {
      state = await g.setup(ctx);
      for (const browser of g.matrix.browsers)
        cells.push({ cell: { browser, width: 1280 }, result: await g.run({ ...ctx, page, browser, width: 1280 }, state) });
    } catch (e) { out.error = String(e?.message ?? e); }
    finally { await g.teardown(ctx, state); }
    if (!out.error) out.rows = g.expect(cells);
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout);
}
const row = (o: Out, i: number) => o.rows?.[i];
const PROJECTS = 2; // "an agent in project A gets the server …"
const BEARER = 4; // "the bearer appears in no file, env or log"
const HEADER = 5; // "the agent's call carries the bearer header …"

describe("gate/335: an agent per project, and the bearer in no file or log", () => {
  it("passes on a bed with the server, a test bearer and the harness's pieces; removes both stubs", () => {
    const o = onBed();
    expect(o.error).toBeNull();
    expect(row(o, PROJECTS)).toMatchObject({ ok: true });
    expect(row(o, BEARER)).toMatchObject({ ok: true });
    expect(o.started.map((s) => s.split("@")[1])).toEqual([
      "default",
      "proj-gate",
    ]);
    expect(o.removed).toHaveLength(2);
  });

  it("fails when the other project's agent gets the server too", () => {
    expect(row(onBed({ leakToB: true }), PROJECTS)).toMatchObject({
      ok: false,
    });
  });

  it("fails when a searched path holds the bearer, naming the path", () => {
    const r = row(onBed({ hit: true }), BEARER);
    expect(r).toMatchObject({ ok: false });
    expect(r?.detail).toMatch(/the bearer is in state:agent-files\//);
  });

  it("reads each agent's record and MCP config from Den's state folder (state:)", () => {
    const r = row(onBed(), PROJECTS);
    expect(r).toMatchObject({ ok: true });
    expect(r?.detail).toMatch(
      /^A \(default\): gate-mcp .*; B \(proj-gate\): no gate-mcp/,
    );
  });

  it("fails when the state files it read were not searched (only the transcripts were)", () => {
    const r = row(onBed({ stateUnsearched: true }), BEARER);
    expect(r).toMatchObject({ ok: false });
    expect(r?.detail).toMatch(
      /searched 2 files, fewer than the 6 this check read or found/,
    );
  });

  it("searches each stub's transcript; a hit there fails, naming the path", () => {
    const r = row(onBed({ hitTranscript: true }), BEARER);
    expect(r).toMatchObject({ ok: false });
    expect(r?.detail).toMatch(
      /the bearer is in \/runtime\/projects\/bed\/gate335-a-\w+\.jsonl, \/runtime\/projects\/bed\/gate335-b-\w+\.jsonl/,
    );
  });

  it("a transcript the harness can't find is named in the detail, not passed over", () => {
    const r = row(onBed({ transcript: "none" }), BEARER);
    expect(r).toMatchObject({ ok: true });
    expect(r?.detail).toMatch(
      /transcript not found: gate335-a-\w+, gate335-b-\w+/,
    );
  });

  it("no ctx.transcriptPath says needs-harness-transcriptPath in the detail, and the clause still runs", () => {
    const r = row(onBed({ transcript: "missing" }), BEARER);
    expect(r).toMatchObject({ ok: true });
    expect(r?.skip).toBeUndefined();
    expect(r?.detail).toMatch(/needs-harness-transcriptPath/);
  });

  it("fails when the harness searched nothing", () => {
    const r = row(onBed({ searchNothing: true }), BEARER);
    expect(r).toMatchObject({ ok: false });
    expect(r?.detail).toMatch(/searched nothing/);
  });

  it("a refused start is the clause's FAIL, saying so; both stubs are still removed", () => {
    const o = onBed({ refuse: true });
    expect(row(o, PROJECTS)).toMatchObject({ ok: false });
    expect(row(o, PROJECTS)?.detail).toMatch(/refused to start/);
    expect(o.removed).toHaveLength(2);
  });

  it("the header clause skips as needs-issue-473 until that fix lands", () => {
    expect(row(onBed(), HEADER)).toMatchObject({
      ok: null,
      skip: "needs-issue-473",
    });
  });

  it("skips as needs-test-bearer only when the bed has no test value", () => {
    const o = onBed({ refSet: false });
    expect(row(o, BEARER)).toMatchObject({
      ok: null,
      skip: "needs-test-bearer",
    });
    expect(row(o, PROJECTS)).toMatchObject({ ok: true });
  });

  it("names the harness piece it lacks", () => {
    expect(row(onBed({ noSecretSeen: true }), BEARER)).toMatchObject({
      ok: null,
      skip: "needs-harness-secretSeen",
    });
    expect(row(onBed({ noWorkspace: true }), PROJECTS)).toMatchObject({
      ok: null,
      skip: "needs-harness-agent-workspace",
    });
  });

  it("never reads a process's environment", () => {
    const src = fs.readFileSync(GATE, "utf-8");
    // process.env, /proc/<pid>/environ, `ps e…`, `printenv`/`env` run in a session.
    expect(src).not.toMatch(
      /process\.env\b|\/proc\/|\/environ\b|\bps\s+-?e|\bprintenv\b|sh\(\s*[`'"]env\b/,
    );
  });
});
