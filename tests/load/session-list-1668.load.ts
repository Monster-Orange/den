import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { writeRecord } from "../../src/shared/agents/records.js";
import {
  startDenServer,
  stopServer,
  type StartedServer,
} from "../child-servers.js";
import { denAuth } from "../unit/server/helpers/den-auth.js";

const num = (name: string, dflt: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${name} must be a positive number (got "${raw}")`);
  return n;
};

const P = {
  agents: num("DEN_LOAD_AGENTS", 90),
  p95Ms: num("DEN_LOAD_P95_MS", 200),
  seconds: num("DEN_LOAD_SECONDS", 60),
  transcriptMb: num("DEN_LOAD_TRANSCRIPT_MB", 8),
  helpers: num("DEN_LOAD_HELPERS", 12),
  helperKb: num("DEN_LOAD_HELPER_KB", 16),
  pages: num("DEN_LOAD_PAGES", 3),
  tools: num("DEN_LOAD_TOOLS", 10),
  pageListMs: num("DEN_LOAD_PAGE_LIST_MS", 5000),
  toolInfoMs: num("DEN_LOAD_TOOL_INFO_MS", 1000),
  toolListMs: num("DEN_LOAD_TOOL_LIST_MS", 10000),
};

const ENGINE = path.resolve(__dirname, "../..");
const WS = "lab";
let tmp = "";
let stateDir = "";
let srv: StartedServer | null = null;
let auth: Record<string, string> = {};

const write = (file: string, body: string | Buffer): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

const token = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const toolId = (i: number, k: number) =>
  `toolu_01${String(i * 1000 + k).padStart(22, "0")}`;
const line = (o: unknown) => JSON.stringify(o) + "\n";

function writeTranscript(file: string, i: number): void {
  const filler = Buffer.from(
    Array.from({ length: 64 }, (_, k) =>
      line({
        type: "assistant",
        timestamp: "2026-11-01T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `step ${k} ` + "x".repeat(900) }],
        },
      }),
    ).join(""),
  );
  const fd = fs.openSync(file, "w");
  try {
    const bytes = P.transcriptMb * 1024 * 1024;
    const every = Math.max(
      1,
      Math.floor(bytes / filler.length / Math.max(1, P.helpers)),
    );
    let k = 0;
    for (let written = 0, n = 0; written < bytes; n++) {
      written += fs.writeSync(fd, filler);
      if (n % every === every - 1 && k < P.helpers) {
        const id = toolId(i, k++);
        fs.writeSync(
          fd,
          line({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id,
                  name: "Task",
                  input: { description: `helper ${k}` },
                },
              ],
            },
          }) +
            line({
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: id,
                    content: "done ".repeat(200),
                  },
                ],
              },
            }),
        );
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function seedAgent(home: string, i: number): void {
  const proj = path.join(home, ".claude", "projects", `-work-load-${i}`);
  const file = path.join(proj, `${token(i)}.jsonl`);
  fs.mkdirSync(proj, { recursive: true });
  writeTranscript(file, i);
  const sub = path.join(proj, token(i), "subagents");
  const step = line({
    type: "assistant",
    isSidechain: true,
    timestamp: "2026-11-01T10:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "y".repeat(400) }],
    },
  });
  const body =
    line({
      type: "user",
      isSidechain: true,
      timestamp: "2026-11-01T10:00:00.000Z",
      message: { role: "user", content: "go" },
    }) +
    step.repeat(Math.max(1, Math.floor((P.helperKb * 1024) / step.length)));
  for (let k = 0; k < P.helpers; k++) {
    const id = `a${String(i).padStart(4, "0")}c0ffee${String(k).padStart(4, "0")}`;
    write(
      path.join(sub, `agent-${id}.meta.json`),
      JSON.stringify({
        agentType: "Explore",
        description: `helper ${k}`,
        toolUseId: toolId(i, k),
        finished: true,
      }),
    );
    write(path.join(sub, `agent-${id}.jsonl`), body);
  }
  const cwd = path.join(tmp, "work", `load-${i}`);
  fs.mkdirSync(cwd, { recursive: true });
  writeRecord(stateDir, {
    id: `load-${String(i).padStart(3, "0")}`,
    persona: "builder",
    runtime: "den-claude",
    workspace: WS,
    cwd,
    session: { backend: "den-pty", id: `gone-load-${i}` },
    sessionName: `acme-${WS}:load-${i}`,
    startedAt: "2026-11-01T09:59:00.000Z",
    resumeToken: token(i),
  });
}

function distribution(root: string): void {
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\ngithub_org: acme\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    `active: [${WS}]\nfocus: ${WS}\nworkspaces:\n  ${WS}:\n    services: []\n`,
  );
}

function timed(port: number, p: string): Promise<number> {
  const started = performance.now();
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: p,
        headers: auth,
        agent: false,
        timeout: 30_000,
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve(
            res.statusCode === 200
              ? performance.now() - started
              : Number.POSITIVE_INFINITY,
          ),
        );
      },
    );
    req.on("error", () => resolve(Number.POSITIVE_INFINITY));
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return (
    s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ??
    Number.POSITIVE_INFINITY
  );
}

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-load-1668-")),
  );
  const root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(tmp, "state");
  distribution(root);
  for (let i = 0; i < P.agents; i++) seedAgent(home, i);
  srv = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        DEN_ROOT: root,
        DEN_HOME: stateDir,
        DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
        DEN_NO_OPEN: "1",
      },
    },
    { timeoutMs: 120_000 },
  );
  auth = denAuth(stateDir);
}, 600_000);

afterAll(async () => {
  if (srv) await stopServer(srv.server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}, 120_000);

describe(`the web server under ${P.agents} agents with helpers, ${P.pages} pages and ${P.tools} tools polling`, () => {
  it(`answers /api/server-info and /api/sessions with p95 under ${P.p95Ms} ms`, async () => {
    const port = srv!.port;
    const first = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        http
          .get(
            {
              host: "127.0.0.1",
              port,
              path: "/api/sessions",
              headers: auth,
              agent: false,
            },
            (res) => {
              let body = "";
              res.on("data", (d: Buffer) => (body += d.toString()));
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, body }),
              );
            },
          )
          .on("error", reject);
      },
    );
    expect(first.status).toBe(200);
    const listed =
      (
        JSON.parse(first.body) as {
          sessions?: { kind?: string; helpers?: unknown }[];
        }
      ).sessions ?? [];
    expect(listed.filter((s) => s.helpers).length).toBe(P.agents);

    const info: number[] = [];
    const list: number[] = [];
    const end = performance.now() + P.seconds * 1000;
    const loop = async (
      route: string,
      every: number,
      into: number[],
      offset: number,
    ) => {
      await sleep(offset);
      while (performance.now() < end) {
        const t0 = performance.now();
        into.push(await timed(port, route));
        await sleep(Math.max(0, every - (performance.now() - t0)));
      }
    };
    const clients: Promise<void>[] = [];
    for (let c = 0; c < P.pages; c++)
      clients.push(
        loop("/api/sessions", P.pageListMs, list, (c * P.pageListMs) / P.pages),
      );
    for (let c = 0; c < P.tools; c++) {
      clients.push(
        loop(
          "/api/server-info",
          P.toolInfoMs,
          info,
          (c * P.toolInfoMs) / P.tools,
        ),
      );
      clients.push(
        loop("/api/sessions", P.toolListMs, list, (c * P.toolListMs) / P.tools),
      );
    }
    await Promise.all(clients);

    const got = {
      serverInfo: {
        n: info.length,
        p95: Math.round(p95(info)),
        max: Math.round(Math.max(...info)),
      },
      sessions: {
        n: list.length,
        p95: Math.round(p95(list)),
        max: Math.round(Math.max(...list)),
      },
    };
    process.stdout.write(`load-1668 ${JSON.stringify({ params: P, got })}\n`);
    expect(got.serverInfo.p95).toBeLessThan(P.p95Ms);
    expect(got.sessions.p95).toBeLessThan(P.p95Ms);
  }, 900_000);
});
