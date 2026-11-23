/**
 * Issue 52 on a real server: the Coach's routes through the request guard.
 * GET /api/coach reads on loopback; Run now needs a person's signed-in
 * session (with CSRF), refuses while the Coach is off, and once it is on
 * saves a report that GET then returns. No agent here, so the report has
 * no rows; the breakdown itself is covered in tests/unit/coach.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { signedIn, type SignedIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];

let tmp = "";
let root = "";
let stateDir = "";
let base = "";
let server: ChildProcess;
let person: SignedIn;

function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body: unknown = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${p}`,
      {
        method,
        agent: false,
        timeout: 30_000,
        headers: {
          connection: "close",
          ...(method === "POST"
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => (buf += d.toString()));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(buf) as Record<string, unknown>;
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(method === "POST" ? payload : undefined);
  });
}

const setConfig = (extra: string[]) =>
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    ["environments: [local]", ...extra, ""].join("\n"),
  );

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-coach52-")));
  root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  setConfig([]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [...AGENT_KEYS, "DEN_HOME", "DEN_TEST_INSTALL"])
    delete env[k];
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        HOME: home,
        DEN_HOME: stateDir,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 40_000 },
  );
  base = `http://localhost:${s.port}`;
  server = s.server;
  person = await signedIn(stateDir, base);
}, 90_000);

afterAll(async () => {
  if (server) await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the Coach's routes on a real server", () => {
  it("GET says the Coach is off by default, with no report yet", async () => {
    const r = await call("GET", "/api/coach");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      settings: { enabled: false, window_days: 7 },
      report: null,
      running: false,
    });
  });

  it("Run now without a person's sign-in is refused by the guard", async () => {
    const r = await call("POST", "/api/coach/run", { origin: base });
    expect([401, 403]).toContain(r.status);
    expect(fs.existsSync(path.join(stateDir, "coach"))).toBe(false);
  });

  it("a person's Run now while the Coach is off is refused, saying how to turn it on", async () => {
    const r = await call("POST", "/api/coach/run", person.headers);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, code: "coach_off" });
  });

  it("turned on, a person's Run now saves a report that GET returns", async () => {
    setConfig([
      "agents:",
      "  coach:",
      "    enabled: true",
      "    window_days: 3",
    ]);
    const r = await call("POST", "/api/coach/run", person.headers);
    expect(r.status).toBe(200);
    const report = r.json.report as {
      window: { days: number };
      agents: unknown[];
    };
    expect(report.window.days).toBe(3);
    expect(report.agents).toEqual([]);
    const g = await call("GET", "/api/coach");
    expect(g.json.report).toEqual(r.json.report);
    expect(fs.existsSync(path.join(stateDir, "coach", "latest.json"))).toBe(
      true,
    );
  });

  it("a person's Dismiss keeps the reason; GET lists it as dismissed", async () => {
    const r = await call("POST", "/api/coach/dismiss", person.headers, {
      id: "polling:builder",
      reason: "It waits on CI by design.",
    });
    expect(r.status).toBe(200);
    const g = await call("GET", "/api/coach");
    expect(g.json.dismissed).toEqual([
      expect.objectContaining({
        id: "polling:builder",
        reason: "It waits on CI by design.",
        by: "person",
      }),
    ]);
  });

  it("Dismiss without a sign-in is refused by the guard", async () => {
    const r = await call(
      "POST",
      "/api/coach/dismiss",
      { origin: base },
      {
        id: "denials:builder",
        reason: "x",
      },
    );
    expect([401, 403]).toContain(r.status);
  });

  it("issue 110: Apply's held persona_update waits; on the person's Allow it sets subagent_model and keeps the file's other keys", async () => {
    const dir = path.join(stateDir, "personas");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "copy-checker.md");
    fs.writeFileSync(
      file,
      [
        "---",
        "name: copy-checker",
        "role: reviewer",
        "category: marketing",
        "description: Checks copy.",
        "runtime: den-claude",
        "model_version: latest",
        "permission_mode: ask",
        "persona_version: v3",
        "tools: Read, Grep",
        "---",
        "",
        "Read the changed copy.",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const before = fs.readFileSync(file, "utf-8");
    // The finding's proposal (findings.ts applyOf), as Apply asks it.
    const asked = await call("POST", "/api/approvals", person.headers, {
      action: "persona_update",
      args: { id: "copy-checker", subagentModel: "sonnet" },
    });
    expect(asked.status).toBe(202);
    const id = String(asked.json.id);
    expect(asked.json.state).toBe("pending");
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    const allowed = await call(
      "POST",
      `/api/approvals/${id}/decide`,
      { ...person.headers, "x-den-approve-key": person.approveKey },
      { decision: "allow" },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.json.state).toBe("done");
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toMatch(/^subagent_model: sonnet$/m);
    expect(after).toMatch(/^persona_version: v3$/m);
    expect(after).toMatch(/^tools: Read, Grep$/m);
  });

  it("issue 110 slice 2: Apply asks from the stored finding, waits, follows its held write, and blocks a second Apply and Dismiss", async () => {
    const dir = path.join(stateDir, "personas");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opus-user.md");
    fs.writeFileSync(
      file,
      [
        "---",
        "name: opus-user",
        "role: sde",
        "category: engineering",
        "description: Builds.",
        "runtime: den-claude",
        "model_version: latest",
        "permission_mode: ask",
        "---",
        "",
        "Build it.",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const W = {
      from: "2026-11-15T12:00:00.000Z",
      to: "2026-11-22T12:00:00.000Z",
      days: 7,
    };
    const finding = {
      id: "subagent_opus:opus-agent",
      kind: "subagent_opus",
      agent: "opus-agent",
      workspace: "local",
      title: "opus-agent (local) ran 90% of its subagent calls on Opus.",
      evidence: { subagent_opus_pct: 90, subagent_calls: 100 },
      proposal: "Set its persona's subagent_model to Sonnet.",
      window: W,
      persona: "opus-user",
      apply: {
        action: "persona_update",
        args: { id: "opus-user", subagentModel: "sonnet" },
        change: "Set opus-user's subagent model to Sonnet.",
        reversible: "Set it back in opus-user's persona.",
      },
    };
    const latest = path.join(stateDir, "coach", "latest.json");
    const report = (
      fs.existsSync(latest)
        ? JSON.parse(fs.readFileSync(latest, "utf-8"))
        : { version: 1, ranAt: W.to, window: W, agents: [] }
    ) as Record<string, unknown>;
    fs.mkdirSync(path.dirname(latest), { recursive: true });
    fs.writeFileSync(
      latest,
      JSON.stringify({ ...report, findings: [finding] }),
      { mode: 0o600 },
    );
    const before = fs.readFileSync(file, "utf-8");
    // Without a person's sign-in: refused by the guard, nothing asked.
    const anon = await call("POST", "/api/coach/apply", {}, { id: finding.id });
    expect([401, 403]).toContain(anon.status);
    // The person's Apply: held, nothing changed yet.
    const asked = await call("POST", "/api/coach/apply", person.headers, {
      id: finding.id,
    });
    expect([asked.status, asked.json.state, asked.json.error]).toEqual([
      202,
      "waiting",
      undefined,
    ]);
    const id = String(asked.json.approval);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    const waiting = await call("GET", "/api/coach", person.headers);
    const row = (waiting.json.findings as Record<string, unknown>[]).find(
      (f) => f.id === finding.id,
    );
    expect(row?.applied).toMatchObject({ state: "waiting", approval: id });
    // Waiting: no second Apply, no Dismiss.
    const again = await call("POST", "/api/coach/apply", person.headers, {
      id: finding.id,
    });
    expect([again.status, again.json.code]).toEqual([409, "apply_waiting"]);
    const dismissed = await call("POST", "/api/coach/dismiss", person.headers, {
      id: finding.id,
      reason: "not now",
    });
    expect(dismissed.json.code).toBe("apply_waiting");
    // The person's Allow: it runs, and the row says applied.
    const allowed = await call(
      "POST",
      `/api/approvals/${id}/decide`,
      { ...person.headers, "x-den-approve-key": person.approveKey },
      { decision: "allow" },
    );
    expect([allowed.status, allowed.json.state]).toEqual([200, "done"]);
    expect(fs.readFileSync(file, "utf-8")).toMatch(/^subagent_model: sonnet$/m);
    const done = await call("GET", "/api/coach", person.headers);
    const after = (done.json.findings as Record<string, unknown>[]).find(
      (f) => f.id === finding.id,
    );
    expect(after?.applied).toMatchObject({ state: "applied", approval: id });
  });
});
