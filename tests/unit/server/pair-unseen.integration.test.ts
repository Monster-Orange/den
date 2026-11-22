/**
 * Issue 320, on a real server: a signed-out page's code request whose page
 * stopped asking has ended. Safari drops the keepalive DELETE its page sends
 * as it goes, and a closed tab may send nothing, so the server can't wait
 * to be told: a pending request it hasn't heard from for the unseen bound
 * (DEN_PAIR_UNSEEN_MS here, short; 15 s by default) is ended. Approving it
 * then says ended and allows nothing, and the page's own late poll gets
 * "gone" (so it makes a new code by itself).
 *
 * Also the page's other way out, for a browser that drops the DELETE:
 * POST /api/signin/code/<id>/withdraw, which `navigator.sendBeacon`
 * sends. It is guarded like the DELETE: an allowed Origin, no CSRF token,
 * the poll id as the proof.
 *
 * No code, cookie or poll id is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cliAuthHeaders } from "../../../src/shared/web-secret.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import { signedIn, type SignedIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const UNSEEN_MS = 1500;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess | null = null;

const base = () => `http://localhost:${port}`;
const page = (extra: Record<string, string> = {}) => ({
  origin: base(),
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  ...extra,
});
const bearer = () => ({
  authorization: cliAuthHeaders(stateDir).Authorization ?? "",
  "content-type": "application/json",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function askCode(): Promise<{ id: string; code: string }> {
  const r = await fetch(`${base()}/api/signin/code`, {
    method: "POST",
    headers: { ...page(), "content-type": "application/json" },
    body: "{}",
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { id: string; code: string };
}
const poll = (id: string) =>
  fetch(`${base()}/api/signin/code/${id}`, { headers: page() });
/** Issue 819: a person's signed-in browser approves (its key and all). */
let person: SignedIn | null = null;
const approve = (code: string) =>
  fetch(`${base()}/api/web/approve`, {
    method: "POST",
    headers: {
      ...person!.headers,
      "x-den-approve-key": person!.approveKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
const waiting = async () =>
  (
    (await (
      await fetch(`${base()}/api/web/waiting`, { headers: bearer() })
    ).json()) as { waiting: unknown[] }
  ).waiting;

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-pair-unseen-")),
  );
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  const started = await startDenServer(
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
        DEN_PAIR_UNSEEN_MS: String(UNSEEN_MS),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
  person = await signedIn(stateDir, base());
}, 60_000);

afterAll(async () => {
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 320: a code its page stopped asking for has ended", () => {
  it("unseen past the bound: approve answers 410 ended, nothing is allowed, and the page's late poll is gone with no cookie", async () => {
    const a = await askCode();
    await sleep(UNSEEN_MS + 300);
    const r = await approve(a.code);
    const b = (await r.json()) as { code?: string; error?: string };
    expect([r.status, b.code, b.error]).toEqual([
      410,
      "ended",
      "That request has ended: that computer closed its page or is already signed in. Nothing was allowed.",
    ]);
    expect(await waiting()).toEqual([]);
    const p = await poll(a.id);
    expect([
      p.status,
      ((await p.json()) as { state?: string }).state,
      p.headers.get("set-cookie"),
    ]).toEqual([404, "gone", null]);
  });

  it("a page that keeps polling keeps its code: approving it after the bound works", async () => {
    const a = await askCode();
    for (let i = 0; i < 4; i++) {
      await sleep(UNSEEN_MS / 2);
      expect(
        ((await (await poll(a.id)).json()) as { state?: string }).state,
      ).toBe("pending");
    }
    const r = await approve(a.code);
    expect(r.status).toBe(200);
  });
});

describe("issue 320: the page's beacon withdraw (POST …/withdraw)", () => {
  it("as sendBeacon sends it (text/plain, an allowed Origin, no CSRF): the request ends at once and approving it says ended", async () => {
    const a = await askCode();
    const w = await fetch(`${base()}/api/signin/code/${a.id}/withdraw`, {
      method: "POST",
      headers: page({ "content-type": "text/plain;charset=UTF-8" }),
      body: "",
    });
    expect([w.status, await w.json()]).toEqual([
      200,
      { ok: true, withdrawn: true },
    ]);
    const r = await approve(a.code);
    expect([r.status, ((await r.json()) as { code?: string }).code]).toEqual([
      410,
      "ended",
    ]);
  });

  it("another site's beacon is refused, and no Origin at all is refused: the request still waits", async () => {
    const a = await askCode();
    for (const origin of ["https://evil.example", undefined]) {
      const h: Record<string, string> = page({ "content-type": "text/plain" });
      if (origin) h.origin = origin;
      else delete h.origin;
      const w = await fetch(`${base()}/api/signin/code/${a.id}/withdraw`, {
        method: "POST",
        headers: h,
        body: "",
      });
      expect([String(origin), w.status]).toEqual([String(origin), 403]);
    }
    expect(
      ((await (await poll(a.id)).json()) as { state?: string }).state,
    ).toBe("pending");
  });

  it("an unknown poll id withdraws nothing", async () => {
    const w = await fetch(
      `${base()}/api/signin/code/${"x".repeat(32)}/withdraw`,
      { method: "POST", headers: page({ "content-type": "text/plain" }) },
    );
    expect([w.status, await w.json()]).toEqual([
      200,
      { ok: true, withdrawn: false },
    ]);
  });
});
