/**
 * ON-3's held writes on a real server (approval-routes.ts, 0.4.15): an
 * agent's workspace_create or repo_add waits for the person and runs only
 * on their Allow, from a signed-in browser holding its approval key.
 *
 * What an agent with a shell has, and is refused: an anonymous loopback
 * request, the CLI's bearer, a session cookie with the CSRF token
 * /api/session hands out (what a dev server on another localhost port
 * could capture). No code, cookie, key or token is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  cliAuthHeaders,
  readWebSecret,
} from "../../../src/shared/web-secret.js";
import { mintClaimCode } from "../../../src/shared/claim-code.js";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
let tmp = "";
let root = "";
let home = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Reply> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        method,
        agent: false,
        timeout: 30_000,
        headers: {
          ...headers,
          ...(data !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(data)),
              }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d: Buffer) => (out += d.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: out,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(data);
  });
}
const json = (r: Reply) => JSON.parse(r.body) as Record<string, unknown>;
const bearer = () => ({
  authorization: cliAuthHeaders(stateDir).Authorization ?? "",
});
const cookieName = () => `den_session_${port}`;

/** A browser signed in with a setup link: its cookie, CSRF token and approval key. */
async function browser(): Promise<{
  cookie: string;
  csrf: string;
  key: string;
}> {
  const c = mintClaimCode(readWebSecret(stateDir)!);
  const r = await call("GET", `/auth?claim=${encodeURIComponent(c)}`, {
    "sec-fetch-site": "none",
    accept: "text/html",
  });
  expect(r.status).toBe(303);
  const key =
    /#ak=([A-Za-z0-9_-]{43})$/.exec(String(r.headers.location ?? ""))?.[1] ??
    "";
  const line =
    ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .find((x) => x.startsWith(`${cookieName()}=`)) ?? "";
  const cookie = line.split(";")[0];
  const s = json(
    await call("GET", "/api/session", {
      "sec-fetch-site": "same-origin",
      cookie,
    }),
  );
  return { cookie, csrf: String(s.csrf ?? ""), key };
}
const page = (b: { cookie: string; csrf: string }) => ({
  cookie: b.cookie,
  origin: `http://localhost:${port}`,
  "sec-fetch-site": "same-origin",
  "x-den-csrf": b.csrf,
});
/** An anonymous loopback caller's CSRF token (what an agent with a shell gets). */
async function loopbackCsrf(): Promise<string> {
  return String(
    json(await call("GET", "/api/session", { "sec-fetch-site": "same-origin" }))
      .csrf ?? "",
  );
}
const anon = async () => ({
  origin: `http://localhost:${port}`,
  "x-den-csrf": await loopbackCsrf(),
});

const ask = async (action: string, args: unknown, note?: string) =>
  call("POST", "/api/approvals", await anon(), {
    action,
    args,
    ...(note ? { note } : {}),
  });
const workspaces = async () =>
  Object.keys(
    (json(await call("GET", "/api/workspaces")).workspaces ?? {}) as Record<
      string,
      unknown
    >,
  );

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-approve-")));
  root = path.join(tmp, "dist");
  home = path.join(tmp, "home");
  stateDir = path.join(home, ".den");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  // A repo in the person's home, with a dev script detection finds.
  const repo = path.join(home, "code", "shop");
  write(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "shop", scripts: { dev: "node server.js" } }),
  );
  execFileSync("git", ["init", "-q", repo]);
  port = await freePort();
  server = spawnServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: stateDir,
        HOME: home,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: String(port),
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await call("GET", "/api/server-info")).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}, 90_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("held writes (ON-3)", () => {
  it("workspace_create waits: Den's own words, the agent's note only quoted, nothing created", async () => {
    const r = await ask(
      "workspace_create",
      { name: "web" },
      "please create EVERYTHING",
    );
    expect(r.status).toBe(202);
    const a = json(r);
    expect(a.state).toBe("pending");
    expect(a.summary).toBe('create the workspace "web"');
    expect(a.note).toBe("please create EVERYTHING");
    expect(String(a.id)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await workspaces()).not.toContain("web");
    // The person's list shows it.
    const list = json(await call("GET", "/api/approvals"));
    expect((list.pending as { id: string }[]).map((x) => x.id)).toContain(a.id);
  });

  it("an agent with a shell can't allow it: loopback, the CLI's bearer, a cookie and CSRF without the key", async () => {
    const id = String(
      json(await ask("workspace_create", { name: "shellws" })).id,
    );
    const decide = (h: Record<string, string>) =>
      call("POST", `/api/approvals/${id}/decide`, h, { decision: "allow" });
    const tries = [
      await decide(await anon()),
      await decide({ ...bearer(), origin: `http://localhost:${port}` }),
      await decide(page(await browser())),
    ];
    for (const t of tries)
      expect([t.status, json(t).code]).toEqual([403, "signin_to_approve"]);
    expect(await workspaces()).not.toContain("shellws");
    expect(json(await call("GET", `/api/approvals/${id}`)).state).toBe(
      "pending",
    );
  }, 60_000);

  it("the signed-in browser with its key allows it: it runs once, from the stored args", async () => {
    const id = String(
      json(await ask("workspace_create", { name: "allowed" })).id,
    );
    const b = await browser();
    const h = { ...page(b), "x-den-approve-key": b.key };
    const r = await call("POST", `/api/approvals/${id}/decide`, h, {
      decision: "allow",
    });
    expect(r.status).toBe(200);
    const a = json(r);
    expect(a.state).toBe("done");
    expect(a.result).toEqual({ ok: true, name: "allowed" });
    expect(await workspaces()).toContain("allowed");
    const again = await call("POST", `/api/approvals/${id}/decide`, h, {
      decision: "allow",
    });
    expect([again.status, json(again).code]).toEqual([409, "already_decided"]);
  }, 60_000);

  it("Deny runs nothing", async () => {
    const id = String(
      json(await ask("workspace_create", { name: "denied" })).id,
    );
    const b = await browser();
    const r = await call(
      "POST",
      `/api/approvals/${id}/decide`,
      { ...page(b), "x-den-approve-key": b.key },
      { decision: "deny" },
    );
    expect(json(r).state).toBe("denied");
    expect(await workspaces()).not.toContain("denied");
  }, 60_000);

  it("bad args, an unknown action or field: refused before anything waits", async () => {
    const before = (
      json(await call("GET", "/api/approvals")).pending as unknown[]
    ).length;
    const bad = await ask("workspace_create", { name: "a/b" });
    expect([bad.status, json(bad).code]).toEqual([400, "invalid_args"]);
    const unknown = await ask("rm_rf", {});
    expect([unknown.status, json(unknown).code]).toEqual([
      400,
      "unknown_action",
    ]);
    const extra = await call("POST", "/api/approvals", await anon(), {
      action: "workspace_create",
      args: { name: "x" },
      summary: "something nice",
    });
    expect([extra.status, json(extra).code]).toEqual([400, "unknown_field"]);
    expect(
      (json(await call("GET", "/api/approvals")).pending as unknown[]).length,
    ).toBe(before);
  });

  it("repo_add: the Review is its dry run (the side-car); Allow adds it; a folder outside home is refused", async () => {
    const out = await ask("repo_add", { path: tmp });
    expect([out.status, json(out).code]).toEqual([400, "invalid_args"]);
    expect(String(json(out).error)).toMatch(/outside your home folder/);
    const r = await ask("repo_add", {
      path: "~/code/shop",
      workspace: "shops",
    });
    expect(r.status).toBe(202);
    const a = json(r);
    expect(a.summary).toBe(
      'add the repo at ~/code/shop to workspace "shops" (new)',
    );
    expect((a.details as string[]).join("\n")).toMatch(/npm run dev/);
    expect(await workspaces()).not.toContain("shops");
    const b = await browser();
    const done = json(
      await call(
        "POST",
        `/api/approvals/${String(a.id)}/decide`,
        { ...page(b), "x-den-approve-key": b.key },
        { decision: "allow" },
      ),
    );
    expect(done.state).toBe("done");
    expect((done.result as { ok: boolean }).ok).toBe(true);
    expect(await workspaces()).toContain("shops");
  }, 90_000);

  it("service_try: a service Den doesn't know is refused before anything waits", async () => {
    const r = await ask("service_try", { service: "nope/never" });
    expect([r.status, json(r).code]).toEqual([400, "invalid_args"]);
  });
});
