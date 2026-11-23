/**
 * Issue 1182: `verify import` and `verify remove` go through the server.
 *
 *   POST /api/verify/import  { project, env, text }: keeps the verdict as a
 *                            run, audited as the person
 *   POST /api/verify/remove  { project, run }: removes an imported run
 *
 * Both refuse an agent, and the CLI sends its change there with the person
 * token. A refusal changes nothing; with no server listening the CLI
 * writes as before.
 *
 * Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { cmdVerify } from "../../../src/ui/cli/verify-command.js";
import type { PersonServer } from "../../../src/ui/cli/person-server.js";
import {
  readRunRecord,
  writeRunRecord,
} from "../../../src/shared/verify/records.js";
import {
  importRecord,
  parseGateVerdict,
  IMPORT_DEFAULTS,
} from "../../../src/shared/verify/imports.js";
import {
  handleVerifyRoutes,
  type VerifyServerDeps,
} from "../../../src/ui/server/verify-routes.js";
import {
  setPrincipal,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-1182-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const verdict = (tag: string) =>
  JSON.stringify({
    tag,
    sha: "e4f5a6b",
    startedAt: "2026-11-17T21:36:24Z",
    endedAt: "2026-11-17T21:39:56Z",
    clauses: [
      { issue: 7, clause: "a person signs in", verdict: "PASS", ms: 5 },
    ],
  });

function stateFor(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Every run record under the state dir, as text (nothing written?). */
function snap(stateDir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(`${p}\n${fs.readFileSync(p, "utf-8")}`);
    }
  };
  walk(stateDir);
  return out.join("\n---\n");
}

type Call = { method: string; path: string; body: unknown };
function fake(answer: { status: number; json: unknown } | null) {
  const calls: Call[] = [];
  const server: PersonServer = async (method, p, body) => {
    calls.push({ method, path: p, body });
    return answer;
  };
  return { server, calls };
}

async function cli(stateDir: string, server: PersonServer, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdVerify(args, {
    stateDir,
    env: {},
    server,
    verifyConfig: () => ({ environments: ["bed"] }),
    projectExists: (p) => p === "north",
    orgEnvironments: () => ["local", "staging"],
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err };
}

describe("issue 1182: the CLI's verify import and remove", () => {
  const file = path.join(tmp, "verdict.json");
  beforeAll(() => fs.writeFileSync(file, verdict("v9.9.9-dev.4")));

  it("import: the server keeps it (POST /api/verify/import); the CLI writes nothing", async () => {
    const st = stateFor("cli-import-yes");
    const yes = fake({
      status: 200,
      json: { ok: true, summary: "v9.9.9-dev.4 on bed: pass" },
    });
    const r = await cli(st, yes.server, [
      "import",
      file,
      "--env",
      "bed",
      "--project",
      "north",
    ]);
    expect(r.code).toBe(0);
    expect(yes.calls).toEqual([
      {
        method: "POST",
        path: "/api/verify/import",
        body: {
          project: "north",
          env: "bed",
          text: verdict("v9.9.9-dev.4"),
        },
      },
    ]);
    expect(snap(st)).toBe("");
    expect(r.out.join("\n")).toContain("v9.9.9-dev.4 on bed: pass");
  });

  it("import: a refusal is shown, exits non-zero and writes nothing", async () => {
    const st = stateFor("cli-import-no");
    const no = fake({
      status: 403,
      json: { ok: false, error: "only a person can do that" },
    });
    const r = await cli(st, no.server, [
      "import",
      file,
      "--env",
      "bed",
      "--project",
      "north",
    ]);
    expect(r.code).not.toBe(0);
    expect(snap(st)).toBe("");
    expect(r.err.join("\n")).toContain("only a person can do that");
  });

  it("import with no server: the CLI keeps it as before", async () => {
    const st = stateFor("cli-import-none");
    const r = await cli(st, fake(null).server, [
      "import",
      file,
      "--env",
      "bed",
      "--project",
      "north",
    ]);
    expect(r.code).toBe(0);
    expect(readRunRecord(st, "north", "v9.9.9-dev.4")?.source).toBe("import");
  });

  it("remove: the server removes it; a refusal leaves it; no server removes it locally", async () => {
    const st = stateFor("cli-remove");
    const v = parseGateVerdict(verdict("v9.9.9-dev.5"), IMPORT_DEFAULTS);
    if (!v.ok) throw new Error(v.error);
    writeRunRecord(st, importRecord("north", "bed", v.verdict));
    const before = snap(st);

    const yes = fake({ status: 200, json: { ok: true, summary: "Removed" } });
    const args = ["remove", "v9.9.9-dev.5", "--project", "north"];
    expect((await cli(st, yes.server, args)).code).toBe(0);
    expect(yes.calls).toEqual([
      {
        method: "POST",
        path: "/api/verify/remove",
        body: { project: "north", run: "v9.9.9-dev.5" },
      },
    ]);
    expect(snap(st)).toBe(before);

    const no = fake({
      status: 403,
      json: { ok: false, error: "only a person can do that" },
    });
    const r = await cli(st, no.server, args);
    expect(r.code).not.toBe(0);
    expect(snap(st)).toBe(before);

    expect((await cli(st, fake(null).server, args)).code).toBe(0);
    expect(readRunRecord(st, "north", "v9.9.9-dev.5")).toBeNull();
  });
});

describe("issue 1182: POST /api/verify/import and /api/verify/remove", () => {
  const st = stateFor("routes");
  const deps: VerifyServerDeps = {
    stateDir: () => st,
    projectExists: (p) => p === "north",
    focusedProject: () => "north",
    environments: () => ["local", "staging"],
    verifyConfig: () => ({ environments: ["bed"] }),
    repos: () => [],
  };
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const id = req.headers["x-test-agent"];
      const p: Principal =
        typeof id === "string"
          ? {
              kind: "agent",
              actor: `agent:${id}`,
              workspace: "north",
              grants: [],
              session: { name: `north:${id}` },
            }
          : { kind: "person-browser", session: "s1" };
      setPrincipal(req, p);
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      void handleVerifyRoutes(req, res, pathname, () => deps).then((done) => {
        if (!done) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const post = (
    p: string,
    body: unknown,
    agent?: string,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agent ? { "x-test-agent": agent } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });

  it("a person's session carrying an agent's claim is refused too, and nothing is kept", async () => {
    const claim = {
      "x-den-actor": "agent",
      "x-den-mcp-client": "jest",
      "x-den-mcp-agent": "agent:lead",
      "x-den-mcp-workspace": "north",
    };
    const v = parseGateVerdict(verdict("v9.9.9-dev.9"), IMPORT_DEFAULTS);
    if (!v.ok) throw new Error(v.error);
    writeRunRecord(st, importRecord("north", "bed", v.verdict));
    const before = snap(st);
    const imp = await post(
      "/api/verify/import",
      { project: "north", env: "bed", text: verdict("v9.9.9-dev.10") },
      undefined,
      claim,
    );
    expect(imp.status).toBe(403);
    const rm = await post(
      "/api/verify/remove",
      { project: "north", run: "v9.9.9-dev.9" },
      undefined,
      claim,
    );
    expect(rm.status).toBe(403);
    expect(snap(st)).toBe(before);
  });

  it("an agent is refused, and nothing is written", async () => {
    const before = snap(st);
    const r = await post(
      "/api/verify/import",
      { project: "north", env: "bed", text: verdict("v9.9.9-dev.6") },
      "scout",
    );
    expect(r.status).toBe(403);
    expect(snap(st)).toBe(before);
  });

  it("a person's import is kept; their remove removes it", async () => {
    const r = await post("/api/verify/import", {
      project: "north",
      env: "bed",
      text: verdict("v9.9.9-dev.7"),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; summary: string };
    expect(j.ok).toBe(true);
    expect(j.summary).toMatch(/v9\.9\.9-dev\.7 on bed/);
    expect(readRunRecord(st, "north", "v9.9.9-dev.7")?.source).toBe("import");

    const agentRm = await post(
      "/api/verify/remove",
      { project: "north", run: "v9.9.9-dev.7" },
      "scout",
    );
    expect(agentRm.status).toBe(403);
    expect(readRunRecord(st, "north", "v9.9.9-dev.7")).not.toBeNull();

    const rm = await post("/api/verify/remove", {
      project: "north",
      run: "v9.9.9-dev.7",
    });
    expect(rm.status).toBe(200);
    expect(readRunRecord(st, "north", "v9.9.9-dev.7")).toBeNull();
  });

  it("checks the import as the CLI does: an unknown environment or a bad file is refused", async () => {
    const before = snap(st);
    const bad1 = await post("/api/verify/import", {
      project: "north",
      env: "nowhere",
      text: verdict("v9.9.9-dev.8"),
    });
    expect(bad1.status).toBe(400);
    const bad2 = await post("/api/verify/import", {
      project: "north",
      env: "bed",
      text: "not json",
    });
    expect(bad2.status).toBe(400);
    const bad3 = await post("/api/verify/import", {
      project: "south",
      env: "bed",
      text: verdict("v9.9.9-dev.8"),
    });
    expect(bad3.status).toBe(400);
    expect(snap(st)).toBe(before);
  });
});
