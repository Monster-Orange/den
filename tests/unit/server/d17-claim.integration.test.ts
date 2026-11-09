/**
 * D17 on a real server, with a fake GitHub on localhost (DEN_TEST_GITHUB_URL;
 * never github.com): a Den with no owner, claimed from the browser.
 *  - "This is my computer" (fix A): GET /attest on localhost only, a 303 to
 *    one of this server's own edge hosts with a short-lived, single-use,
 *    host-bound code in the fragment; never a session by itself.
 *  - web.allowed_github_org: a member of the org claims it with that proof
 *    and gets a session; a non-member, or a sign-in without the proof, is
 *    refused with the reason; a private membership the app can't read says
 *    so and names the fix.
 *  - web.owner_github: that login claims it from any browser; another is
 *    refused.
 *
 * A throwaway distribution (org acme, tls none: den.acme.localhost). No
 * code, token or cookie is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { cliAuthHeaders } from "../../../src/shared/web-secret.js";
import { spawnServer, stopServer } from "../../child-servers.js";
import { startFakeGithub, type FakeGithub } from "./helpers/fake-github.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const EDGE = "den.acme.localhost";
const OWNER = { id: 4242, login: "octo-owner" };
const OTHER = { id: 777, login: "someone-else" };
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let gh: FakeGithub;
/** Every cookie and link this suite saw: none may reach the server's log. */
const secrets: string[] = [];

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        setHost: false,
        headers: {
          host: `localhost:${port}`,
          connection: "close",
          ...headers,
          ...(body !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
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
    req.end(body);
  });
}
const json = (r: Reply) => JSON.parse(r.body) as Record<string, unknown>;
const cookieOf = (r: Reply) => {
  const line =
    ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith(`den_session_${port}=`)) ?? "";
  const pair = line.split(";")[0];
  if (pair) secrets.push(pair.split("=")[1] ?? "");
  return pair;
};
/** The edge, for a browser it can't place (no X-Forwarded-For). */
const edge = (extra: Record<string, string> = {}) => ({
  host: EDGE,
  origin: `http://${EDGE}`,
  "sec-fetch-site": "same-origin",
  ...extra,
});
const bearer = () => ({
  authorization: cliAuthHeaders(stateDir).Authorization ?? "",
});
/** Poll `p` (the server's view of a flow) until it isn't pending. */
async function settle(
  p: string,
  headers: Record<string, string>,
): Promise<Reply> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const r = await call("GET", p, headers);
    if (r.status !== 200 || json(r).state !== "pending") return r;
    if (Date.now() > deadline) throw new Error(`still pending: ${p}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
const lastCode = () => gh.codes[gh.codes.length - 1].userCode;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  gh = await startFakeGithub({ interval: 0 });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-d17-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  tls: none",
      "web:",
      "  allowed_github_org: acme-co",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    "web:\n  github_client_id: Iv23liAcmeTest\n",
  );
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
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: String(port),
        DEN_TEST_GITHUB_URL: gh.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await call("GET", "/api/server-info")).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  await gh.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const userYml = () => path.join(tmp, "dist", "config", "local", "user.yml");
const RET = `http://${EDGE}/settings`;

/** "This is my computer": the code /attest hands back in the fragment. */
async function attest(ret = RET): Promise<string> {
  const r = await call("GET", `/attest?return=${encodeURIComponent(ret)}`, {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
  });
  expect(r.status).toBe(303);
  const loc = String(r.headers.location);
  const m = /#den-attest=([^&]+)$/.exec(loc);
  if (!m) throw new Error(`no code in the redirect (${loc.length} chars)`);
  secrets.push(decodeURIComponent(m[1]));
  return decodeURIComponent(m[1]);
}

/** Start a GitHub sign-in from the edge, approve it as `who`, settle it. */
async function signin(
  who: { id: number; login: string },
  body: Record<string, unknown> = {},
): Promise<{ start: Reply; done?: Reply }> {
  const start = await call(
    "POST",
    "/api/github/signin",
    edge(),
    JSON.stringify(body),
  );
  if (start.status !== 200) return { start };
  gh.approve(lastCode(), who);
  const done = await settle(
    `/api/github/signin/${String(json(start).id)}`,
    edge(),
  );
  return { start, done };
}

describe("This is my computer (/attest)", () => {
  it("on localhost: a 303 to its own edge URL, the code in the fragment, no cookie", async () => {
    const r = await call("GET", `/attest?return=${encodeURIComponent(RET)}`, {
      "sec-fetch-site": "cross-site",
    });
    expect(r.status).toBe(303);
    const loc = String(r.headers.location);
    expect(loc.startsWith(`${RET}#den-attest=a1.`)).toBe(true);
    expect(loc.includes("?")).toBe(false);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("through the edge (another machine, or this one): refused, no code", async () => {
    const r = await call("GET", `/attest?return=${encodeURIComponent(RET)}`, {
      host: EDGE,
      "sec-fetch-site": "none",
      accept: "text/html",
    });
    expect(r.status).not.toBe(303);
    expect(r.body).not.toContain("den-attest=");
  });

  it.each([
    "http://evil.example/settings",
    `http://${EDGE}.evil.example/`,
    `http://user:pw@${EDGE}/`,
    "javascript:alert(1)",
    "",
  ])(
    "a return that isn't one of its own edge hosts (%s): 400, no code",
    async (ret) => {
      const r = await call("GET", `/attest?return=${encodeURIComponent(ret)}`, {
        accept: "text/html",
      });
      expect(r.status).toBe(400);
      expect(String(r.headers.location ?? "")).toBe("");
    },
  );
});

describe("web.allowed_github_org, no owner yet", () => {
  it("the signed-out edge page leads with Connect your GitHub account, and This is my computer", async () => {
    const r = await call("GET", "/settings", {
      host: EDGE,
      "sec-fetch-site": "none",
      accept: "text/html",
    });
    expect(r.status).toBe(401);
    expect(r.body).toContain('"state":"claim"');
    expect(r.body).toContain('"org":"acme-co"');
    expect(r.body).toContain(`"attest":"http://localhost:${port}/attest"`);
  });

  it("a sign-in without the proof is refused with the reason, and asks GitHub nothing", async () => {
    const before = gh.requests.length;
    const r = await call("POST", "/api/github/signin", edge(), "{}");
    expect([r.status, json(r).code]).toEqual([409, "claim_here"]);
    expect(String(json(r).error)).toContain("choose This is my computer");
    expect(gh.requests.length).toBe(before);
  });

  it("a code that isn't one, or another host's, is refused", async () => {
    const bad = await call(
      "POST",
      "/api/github/signin",
      edge(),
      JSON.stringify({ attest: "a1.nope" }),
    );
    expect([bad.status, json(bad).code]).toEqual([403, "attest_failed"]);
    // Minted for another edge host of this server? There is one; a code
    // for it fails on a different Host.
    const code = await attest();
    const other = await call(
      "POST",
      "/api/github/signin",
      {
        ...edge(),
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
      },
      JSON.stringify({ attest: code }),
    );
    expect(other.status).toBe(403);
  });

  it("with the proof, a non-member is refused by name; the code works once", async () => {
    gh.orgs["acme-co"] = { [OWNER.login]: "private" };
    const code = await attest();
    const { done } = await signin(OTHER, { attest: code });
    expect(json(done!)).toMatchObject({ state: "refused" });
    expect(String(json(done!).error)).toBe(
      "@someone-else isn't a member of the acme-co GitHub org (web.allowed_github_org), so it can't own this Den.",
    );
    expect(cookieOf(done!)).toBe("");
    const again = await call(
      "POST",
      "/api/github/signin",
      edge(),
      JSON.stringify({ attest: code }),
    );
    expect([again.status, json(again).code]).toEqual([403, "attest_failed"]);
  });

  it("a private membership the app can't read: refused, saying so and naming the fix", async () => {
    gh.membershipReadable = false;
    try {
      const { done } = await signin(OWNER, { attest: await attest() });
      expect(json(done!)).toMatchObject({ state: "refused" });
      const e = String(json(done!).error);
      expect(e).toContain("the membership is private");
      expect(e).toContain("web.owner_github: octo-owner");
    } finally {
      gh.membershipReadable = true;
    }
  });

  it("with the proof, a member claims it: a session, and the owner is linked", async () => {
    const { done } = await signin(OWNER, { attest: await attest() });
    expect(json(done!)).toMatchObject({ state: "ok", login: "octo-owner" });
    expect(cookieOf(done!)).toMatch(new RegExp(`^den_session_${port}=`));
    const o = json(await call("GET", "/api/web/owner", bearer()));
    expect(o).toMatchObject({
      owner: { id: "github:4242", login: "octo-owner" },
    });
    expect(serverOut).toContain(
      "owner linked: @octo-owner (member of acme-co)",
    );
    // Now the owner signs in from anywhere, no proof needed.
    const again = await signin(OWNER);
    expect(json(again.done!)).toMatchObject({ state: "ok" });
  });
});

describe("web.owner_github, no owner yet", () => {
  it("that login claims it from any browser; another is refused with the reason", async () => {
    const h = bearer();
    expect(json(await call("POST", "/api/web/owner/unlink", h, "{}"))).toEqual({
      ok: true,
      was: "octo-owner",
    });
    fs.writeFileSync(
      userYml(),
      "web:\n  github_client_id: Iv23liAcmeTest\n  owner_github: someone-else\n",
    );
    const no = await signin(OWNER);
    expect(json(no.done!)).toMatchObject({ state: "refused" });
    expect(String(json(no.done!).error)).toContain(
      "From another computer, only @someone-else (web.owner_github) can.",
    );
    const yes = await signin(OTHER);
    expect(json(yes.done!)).toMatchObject({
      state: "ok",
      login: "someone-else",
    });
    expect(cookieOf(yes.done!)).toMatch(new RegExp(`^den_session_${port}=`));
    expect(json(await call("GET", "/api/web/owner", h))).toMatchObject({
      owner: { login: "someone-else" },
    });
  });
});

describe("secrets", () => {
  it("no code, token or cookie reaches the server's output", () => {
    for (const t of gh.tokens) expect(serverOut.includes(t)).toBe(false);
    for (const s of secrets.filter(Boolean))
      expect(serverOut.includes(s)).toBe(false);
  });
});
