/**
 * Requests on a real server over a throwaway distribution:
 *
 * - A method other than GET, HEAD, POST, PUT, PATCH or DELETE (OPTIONS
 *   included: Den serves no cross-origin requests) answers 405 before any
 *   route, with no Access-Control header, credential or not; nothing runs.
 *   Every command the routes could start (the service's own commands,
 *   git, docker, aws, gh, tail, npx) is a shim that leaves a marker file.
 * - GET /api/manifest/validate?path= runs only for this server's own page
 *   or a token (it is checked as a change), reads only inside a project's
 *   repo (a symlink out of it counts as out), and an error never quotes
 *   the file.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let repos = "";
let marks = "";
let home = "";
let port = 0;
let server: ChildProcess;

const OUTSIDE_TEXT = "outside-file-text-4711";
const INSIDE_TEXT = "inside-broken-text-0815";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        agent: false,
        timeout: 15_000,
        setHost: false,
        headers: { host: `localhost:${port}`, ...headers },
      },
      (res) => {
        let out = "";
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: out,
          });
        // A stream that started: what came so far is enough.
        const t = setTimeout(() => {
          res.destroy();
          done();
        }, 3_000);
        res.on("data", (d: Buffer) => (out += d.toString()));
        res.on("end", () => {
          clearTimeout(t);
          done();
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end();
  });
}
const bearer = () => denAuth(home);
const marked = () => (fs.existsSync(marks) ? fs.readdirSync(marks).sort() : []);

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-methods-")));
  root = path.join(tmp, "dist");
  repos = path.join(tmp, "repos");
  marks = path.join(tmp, "marks");
  home = path.join(tmp, "home");
  fs.mkdirSync(marks, { recursive: true });
  const bin = path.join(tmp, "bin");
  for (const tool of ["git", "docker", "aws", "gh", "tail", "npx", "k6"])
    write(
      path.join(bin, tool),
      `#!/bin/sh\ntouch "${marks}/${tool}-$$"\nexit 0\n`,
      0o755,
    );
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north]",
      "focus: north",
      "workspaces:",
      "  north:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${path.join(repos, "shop")}`,
      "",
    ].join("\n"),
  );
  const mark = (n: string) => `touch ${marks}/cmd-${n}`;
  write(
    path.join(repos, "shop", ".den.yml"),
    [
      "name: shop",
      "services:",
      "  shop:",
      "    commands:",
      "      local:",
      `        up: "${mark("up")}"`,
      `        down: "${mark("down")}"`,
      `        restart: "${mark("restart")}"`,
      `        logs: "${mark("logs")}"`,
      "",
    ].join("\n"),
  );
  // A file outside every repo, and a link to it from inside one.
  write(
    path.join(tmp, "outside", "creds.txt"),
    `[default]\nkey = ${OUTSIDE_TEXT}\n`,
  );
  fs.symlinkSync(
    path.join(tmp, "outside", "creds.txt"),
    path.join(repos, "shop", "linked.yml"),
  );
  write(path.join(repos, "shop", "broken.yml"), `a: [\n${INSIDE_TEXT}: {\n`);

  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        // The shims first; the test run's own PATH after (its sentinel).
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: home,
        HOME: home,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    },
    { timeoutMs: 30_000 },
  );
  server = started.server;
  port = started.port;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const RUNNERS = [
  "/api/service/exec?repo=shop&service=shop&cmd=up&env=local",
  "/api/service/exec?repo=shop&service=shop&cmd=down&env=local",
  "/api/workspace/exec?ws=north&cmd=up&env=local",
  "/api/workspace/sync?ws=north",
  "/api/aws/login?env=local",
  "/api/run?pillar=smoke&env=local",
  "/api/service/logs?repo=shop&service=shop",
  "/api/service/taillog?repo=shop&service=shop",
  "/api/service/history?repo=shop&service=shop",
  "/api/logs/search?q=needle&targets=shop/shop",
];
const ODD = ["OPTIONS", "PROPFIND", "PURGE"];
const SHAPES: [string, () => Record<string, string>][] = [
  ["no headers", () => ({})],
  [
    "another site's preflight",
    () => ({
      origin: "https://elsewhere.example",
      "sec-fetch-site": "cross-site",
      "access-control-request-method": "GET",
      "access-control-request-headers": "x-a",
    }),
  ],
  ["the person's own bearer", () => bearer()],
];

describe("a method other than the six answers 405 before any route", () => {
  it("OPTIONS, PROPFIND and PURGE on every command route: 405, no CORS header, nothing runs", async () => {
    const wrong: string[] = [];
    for (const p of RUNNERS)
      for (const m of ODD)
        for (const [shape, h] of SHAPES) {
          const r = await call(m, p, h());
          if (r.status !== 405)
            wrong.push(`${m} ${p} (${shape}) → ${r.status}`);
          const cors = Object.keys(r.headers).filter((k) =>
            k.startsWith("access-control-"),
          );
          if (cors.length) wrong.push(`${m} ${p}: ${cors.join(",")}`);
        }
    // Anything started late has had time to leave its marker.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(wrong).toEqual([]);
    expect(marked()).toEqual([]);
  }, 180_000);

  it("a page, a read and a write route answer 405 to OPTIONS too", async () => {
    for (const p of ["/", "/api/health", "/api/settings"])
      expect([p, (await call("OPTIONS", p)).status]).toEqual([p, 405]);
  });

  it("the markers work: the service's up with the person's bearer leaves one", async () => {
    const r = await call(
      "GET",
      "/api/service/exec?repo=shop&service=shop&cmd=up&env=local",
      bearer(),
    );
    expect(r.status).toBe(200);
    const t0 = Date.now();
    while (!marked().includes("cmd-up") && Date.now() - t0 < 10_000)
      await new Promise((res) => setTimeout(res, 100));
    expect(marked()).toContain("cmd-up");
  }, 30_000);
});

describe("the MCP sync tool's POST", () => {
  it("POST /api/workspace/sync takes the person's bearer (the MCP tool's call), and refuses a bare one", async () => {
    const p = "/api/workspace/sync?ws=north";
    expect((await call("POST", p, bearer())).status).toBe(200);
    expect((await call("POST", p)).status).toBe(403);
    expect(
      (await call("POST", p, { origin: "https://elsewhere.example" })).status,
    ).toBe(403);
  }, 30_000);
});

describe("GET /api/manifest/validate?path=", () => {
  const v = (p: string, h: Record<string, string> = {}) =>
    call("GET", `/api/manifest/validate?path=${encodeURIComponent(p)}`, h);

  // This server's own page: same-origin, as the Local Dev page's fetch.
  const page = () => ({
    origin: `http://localhost:${port}`,
    "sec-fetch-site": "same-origin",
  });

  it("runs only for this server's page or a token: bare or from another site, 403, nothing quoted", async () => {
    for (const h of [
      {},
      { "sec-fetch-site": "cross-site" },
      { origin: "https://elsewhere.example" },
    ]) {
      for (const p of [
        path.join(repos, "shop"),
        path.join(tmp, "outside", "creds.txt"),
      ]) {
        const r = await v(p, h);
        expect([JSON.stringify(h), r.status]).toEqual([JSON.stringify(h), 403]);
        expect(r.body).not.toContain(OUTSIDE_TEXT);
      }
    }
  });

  it("a file outside every repo, a link out of one, or a path that isn't there: refused alike, nothing quoted", async () => {
    const answers: number[] = [];
    for (const p of [
      path.join(tmp, "outside", "creds.txt"),
      path.join(repos, "shop", "linked.yml"),
      path.join(tmp, "outside", "nothing-here.txt"),
      path.join(repos, "shop", "..", "..", "outside", "creds.txt"),
      "/etc/hosts",
    ]) {
      for (const h of [bearer(), page()]) {
        const r = await v(p, h);
        answers.push(r.status);
        expect(r.body).not.toContain(OUTSIDE_TEXT);
        expect(r.body).not.toContain("localhost");
      }
    }
    expect(answers).toEqual(Array(10).fill(403));
  });

  it("inside a repo it validates; a file that won't parse is named by line, its text never quoted", async () => {
    for (const h of [bearer(), page()]) {
      const ok = await v(path.join(repos, "shop"), h);
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ valid: true });
    }
    const bad = await v(path.join(repos, "shop", "broken.yml"), bearer());
    expect(bad.status).toBe(200);
    expect(JSON.parse(bad.body)).toMatchObject({ valid: false });
    expect(bad.body).not.toContain(INSIDE_TEXT);
  });
});
