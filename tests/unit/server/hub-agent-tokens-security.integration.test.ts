/** A real Den server and a stand-in Hub: an agent's Hub calls carry its own token, and no token reaches anything an agent can read. */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { actorTokenOf } from "../../../src/shared/actor-token.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

const ENGINE = path.resolve(__dirname, "../../..");
const INSTALL = "hubi_TESTONLY_scan50_install_Qv7rT2";
const BOUND = (n: number) => `hubi_TESTONLY_scan50_bound${n}_Lm4xW9`;

interface Seen {
  method: string;
  url: string;
  auth: string;
  agentId: string;
}

const hub = {
  url: "",
  server: null as http.Server | null,
  seen: [] as Seen[],
  bound: new Map<string, string>(),
};

let s: AgentsPageServer;
let tokenDir = "";
const A = { id: "ada", name: "Ada", token: "", pty: -1 };
const B = { id: "bea", name: "Bea", token: "", pty: -1 };

beforeAll(async () => {
  let n = 0;
  hub.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "");
      const deliveryFeed = (req.url ?? "").startsWith(
        "/api/installs/self/deliveries",
      );
      if (!deliveryFeed)
        hub.seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth,
          agentId: String(req.headers["x-den-agent-id"] ?? ""),
        });
      const json = (code: number, v: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      const bearer = auth.replace(/^Bearer /, "");
      const asBound = hub.bound.get(bearer);
      if (bearer !== INSTALL && !asBound)
        return json(401, { error: "unauthorized" });
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const p = new URL(req.url ?? "/", "http://x").pathname;
      if (p === "/connect/agent") {
        if (asBound) return json(403, { error: "install_token_required" });
        n += 1;
        const token = BOUND(n);
        hub.bound.set(token, String(body.agent_id));
        return json(200, {
          token,
          token_id: `00000000-0000-4000-8000-00000000005${n}`,
          agent: { id: body.agent_id, name: body.agent_name },
        });
      }
      if (p === "/mcp") {
        if (body.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        return json(200, {
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              : { tools: [], ok: true },
        });
      }
      if (p === "/api/notifications") return json(200, { notifications: [] });
      json(200, {});
    });
  });
  await new Promise<void>((r) =>
    hub.server!.listen(0, "127.0.0.1", () => {
      hub.url = `http://127.0.0.1:${(hub.server!.address() as AddressInfo).port}`;
      r();
    }),
  );
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hubtok50-"));
  const tokenFile = path.join(tokenDir, "hub-token");
  fs.writeFileSync(tokenFile, INSTALL, { mode: 0o600 });
  s = await startAgentsPageServer({
    userYml: `hub:\n  url: ${hub.url}\n  token: "file:${tokenFile}"\n`,
  });
  for (const ag of [A, B]) {
    const r = await fetch(`${s.base}/api/workspaces/north/agents`, {
      method: "POST",
      headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
      body: JSON.stringify({ persona: "planner", id: ag.id, name: ag.name }),
    });
    expect(r.status).toBe(200);
    ag.pty = s.made.length - 1;
    ag.token = actorTokenOf(s.made[ag.pty].opts.env) ?? "";
    expect(ag.token).toBeTruthy();
  }
  for (const ag of [A, B])
    expect((await asAgent(ag, "/hub/mcp")).status).toBe(200);
  expect([...hub.bound.values()].sort()).toEqual([A.id, B.id]);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  hub.server?.closeAllConnections();
  await new Promise<void>((r) =>
    hub.server ? hub.server.close(() => r()) : r(),
  );
  if (tokenDir) fs.rmSync(tokenDir, { recursive: true, force: true });
});

const boundOf = (id: string) =>
  [...hub.bound].find(([, a]) => a === id)?.[0] ?? "";

function asAgent(
  ag: { token: string },
  p: string,
  more: Record<string, string> = {},
) {
  return fetch(`${s.base}${p}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ag.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "s-50",
      ...more,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hub_search", arguments: { q: B.id, agent_id: B.id } },
    }),
  });
}

const namesB = (): Record<string, string> => ({
  "X-Den-Agent-Id": B.id,
  "X-Den-Agent": B.name,
  "X-Den-Session": `acme-north:${B.id}`,
  "X-Den-Workspace": "north",
  "X-Den-Scope": "north",
  "X-Den-Project": B.id,
  "X-Den-Repos": B.id,
  "x-den-actor": `agent:${B.id}`,
  "x-den-mcp-agent": `agent:${B.id}`,
  "x-den-mcp-session": `acme-north:${B.id}`,
  "x-den-mcp-workspace": "north",
});

describe("issue 50, clause 3: A's call through /hub carries A's own token, never B's", () => {
  const cases: [string, () => [string, Record<string, string>]][] = [
    ["X-Den-Agent-Id naming B", () => ["/hub/mcp", { "X-Den-Agent-Id": B.id }]],
    ["every X-Den-* header naming B", () => ["/hub/mcp", namesB()]],
    ["B's id in the path", () => [`/hub/api/artifacts/${B.id}`, {}]],
    [
      "B's id in the query",
      () => [`/hub/mcp?agent=${B.id}&agent_id=${B.id}&agentId=${B.id}`, {}],
    ],
    [
      "all of them at once",
      () => [
        `/hub/api/reports/${B.id}?agent=${B.id}&agent_id=${B.id}`,
        namesB(),
      ],
    ],
  ];
  it.each(cases)("%s", async (_what, make) => {
    const [p, headers] = make();
    const before = hub.seen.length;
    const r = await asAgent(A, p, headers);
    expect(r.status).toBeLessThan(500);
    const reached = hub.seen.slice(before);
    expect(reached).toHaveLength(1);
    expect(reached[0].auth).toBe(`Bearer ${boundOf(A.id)}`);
    expect(reached[0].auth).not.toContain(boundOf(B.id));
    expect(reached[0].agentId).toBe(A.id);
  });

  it("a caller that proves no agent never reaches Hub through the proxy; Den's own call for it carries the install token, never an agent's", async () => {
    const before = hub.seen.length;
    const tries: [string, Record<string, string>][] = [
      ["no token", {}],
      ["a person's token", denAuth(s.stateDir)],
      ["a made-up agent token", { authorization: "Bearer den_at_notreal" }],
      ["B's bound Hub token", { authorization: `Bearer ${boundOf(B.id)}` }],
    ];
    for (const [what, auth] of tries) {
      const r = await fetch(`${s.base}/hub/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...namesB(),
          ...auth,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect([what, r.status]).toEqual([what, expect.any(Number)]);
      expect([what, r.status >= 400 && r.status < 500]).toEqual([what, true]);
    }
    expect(hub.seen.slice(before)).toEqual([]);

    for (const auth of [{}, denAuth(s.stateDir)])
      for (const p of [
        "/api/hub",
        "/api/hub/link-suggestions",
        "/api/hub/names-check?name=north",
        "/api/workspaces/north/hub-project",
      ]) {
        const r = await fetch(`${s.base}${p}`, {
          headers: { ...auth, ...namesB() },
        });
        expect([p, r.status < 500]).toEqual([p, true]);
      }
    const reached = hub.seen.slice(before);
    expect(reached.length).toBeGreaterThan(0);
    for (const x of reached) expect(x.auth).toBe(`Bearer ${INSTALL}`);
  });
});

function needles(): [string, string][] {
  const tokens: [string, string][] = [
    ["the install token", INSTALL],
    ...[...hub.bound].map(([t, a]): [string, string] => [
      `${a}'s bound token`,
      t,
    ]),
  ];
  return tokens.flatMap(([what, t]): [string, string][] => [
    [what, t],
    [`${what} (base64)`, Buffer.from(t).toString("base64")],
    [`${what} (base64url)`, Buffer.from(t).toString("base64url")],
  ]);
}

function found(where: string, text: string): string[] {
  return needles()
    .filter(([, n]) => text.includes(n))
    .map(([what]) => `${what} in ${where}`);
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(f));
    else if (e.isFile()) out.push(f);
  }
  return out;
}

async function cliAs(ag: { pty: number }, args: string[]): Promise<string> {
  const env = {
    ...s.made[ag.pty].opts.env,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_ROOT: path.join(s.tmp, "dist"),
  };
  const p = spawn(
    process.execPath,
    [
      path.join(ENGINE, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(ENGINE, "src", "ui", "cli", "index.ts"),
      ...args,
    ],
    { env, cwd: s.made[ag.pty].opts.cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  p.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
  p.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
  const t = setTimeout(() => p.kill("SIGKILL"), 60_000);
  await new Promise((r) => p.on("close", r));
  clearTimeout(t);
  return out;
}

describe("issue 50, clause 4: no Hub token anywhere an agent can see", () => {
  it("a scan of the agent's env, files, MCP config, CLI output, /api answers and the server's log finds none", async () => {
    expect(hub.bound.size).toBe(2);
    const store = path.join(s.stateDir, "hub", "agents");
    expect(fs.readFileSync(path.join(store, `${A.id}.json`), "utf8")).toContain(
      boundOf(A.id),
    );
    const leaks: string[] = [];

    for (const ag of [A, B])
      leaks.push(
        ...found(`${ag.id}'s env`, JSON.stringify(s.made[ag.pty].opts.env)),
      );

    const args = s.made[A.pty].args;
    const mcpConfig = args[args.indexOf("--mcp-config") + 1];
    expect(mcpConfig).toBeTruthy();
    const files = filesUnder(s.tmp).filter(
      (f) => !f.startsWith(store + path.sep),
    );
    expect(files).toContain(fs.realpathSync(mcpConfig));
    for (const f of files) {
      let text = "";
      try {
        if (fs.statSync(f).size > 8 * 1024 * 1024) continue;
        text = fs.readFileSync(f, "latin1");
      } catch {
        continue;
      }
      leaks.push(...found(path.relative(s.tmp, f), text));
    }

    for (const cmd of [
      ["status"],
      ["hub", "link", "--suggested", "--json"],
      ["agents", "list", "-w", "north"],
      ["agents", "list", "-w", "north", "--json"],
    ]) {
      const out = await cliAs(A, cmd);
      if (cmd[0] === "agents") expect(out).toContain(A.id);
      leaks.push(...found(`\`${cmd.join(" ")}\``, out));
    }

    const gets = ROUTES.filter(
      (r) =>
        r.methods.includes("GET") &&
        r.cls === "readonly" &&
        r.path.startsWith("/api/") &&
        !r.path.includes("*") &&
        !r.path.includes("_den"),
    ).map((r) =>
      r.path
        .replace(":ws", "north")
        .replace(":id", A.id)
        .replace(":cli", "acme")
        .replace(/:[a-z]+/gi, "x"),
    );
    expect(gets).toEqual(expect.arrayContaining(["/api/sessions", "/api/hub"]));
    for (const p of gets) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      let text = "";
      try {
        const r = await fetch(`${s.base}${p}`, {
          headers: { authorization: `Bearer ${A.token}` },
          signal: ac.signal,
        });
        const reader = r.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          text += Buffer.from(value).toString("utf8");
        }
      } catch (e) {
        if (!ac.signal.aborted) throw e;
      } finally {
        clearTimeout(t);
      }
      leaks.push(...found(`GET ${p}`, text));
    }

    leaks.push(...found("the server's log", s.log()));

    expect(leaks).toEqual([]);
  }, 300_000);
});
