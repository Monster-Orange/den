/**
 * AG-DROP: POST /api/sessions/<id>/uploads, through sendSessionHttp on a
 * real HTTP server with a stand-in session host. The file lands under
 * <uploads>/<session id>/ (0600 in a 0700 folder) and the answer is its
 * absolute path; past agents.uploads.max_bytes it is 413 naming the
 * setting and nothing is left; an unknown or ended session is refused.
 * The request checks (CSRF, sign-in, an agent's own session) are the
 * guard's, before this: its route class is shell-grade.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  sendSessionHttp,
  type SessionRouteDeps,
} from "../../../src/ui/server/session-routes.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import {
  agentRefusal,
  type AgentPrincipal,
} from "../../../src/ui/server/request-guard.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import type { SessionInfo } from "../../../src/shared/sessions/types.js";

let tmp = "";
let server: http.Server;
let base = "";
const max = 1000;
const sessions: SessionInfo[] = [
  {
    ref: { backend: "den-pty", id: "a1b2c3d4" },
    name: "acme-north:scout",
    pid: 1,
    startedAt: new Date().toISOString(),
  } as SessionInfo,
  {
    ref: { backend: "den-pty", id: "e5f6a7b8" },
    name: "acme-north:gone",
    pid: 2,
    startedAt: new Date().toISOString(),
    exited: true,
  } as SessionInfo,
];
const at = new Date(Date.UTC(2026, 10, 11, 9, 41, 7, 5));

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-sup-")));
  const deps: SessionRouteDeps = {
    stateDir: () => tmp,
    dist: () => "acme",
    activeWorkspaces: () => ["north"],
    workspaceExists: (ws) => ws === "north",
    connectExisting: async () =>
      ({
        list: async () => sessions,
        close: () => undefined,
      }) as never,
    uploadSettings: () => ({ maxBytes: max, keepDays: 7, dir: null }),
    now: () => at,
  };
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    void sendSessionHttp(req, res, u.pathname, deps);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (id: string, name: string | null, body: BodyInit) =>
  fetch(
    `${base}/api/sessions/${encodeURIComponent(id)}/uploads${name === null ? "" : `?name=${encodeURIComponent(name)}`}`,
    { method: "POST", body, headers: { "content-type": "image/png" } },
  );

describe("POST /api/sessions/<id>/uploads (AG-DROP)", () => {
  it("is shell-grade, and an agent's token reaches its own session's only", () => {
    expect(routeClass("POST", "/api/sessions/a1b2c3d4/uploads")).toBe(
      "shell-grade",
    );
    const agent: AgentPrincipal = {
      kind: "agent",
      actor: "agent:scout",
      workspace: "north",
      grants: [],
      session: { id: "a1b2c3d4", name: "acme-north:scout" },
    };
    expect(
      agentRefusal(
        agent,
        "POST",
        "/api/sessions/a1b2c3d4/uploads",
        "shell-grade",
      ),
    ).toBeNull();
    expect(
      agentRefusal(
        agent,
        "POST",
        "/api/sessions/e5f6a7b8/uploads",
        "shell-grade",
      ),
    ).toContain("its own session only");
  });

  it("writes the file under <state>/uploads/<session>/ (0600, folder 0700) and answers its path", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = await post("a1b2c3d4", "../Screen Shot.png", bytes);
    expect(r.status).toBe(200);
    const b = (await r.json()) as { ok: boolean; path: string; bytes: number };
    const want = path.join(
      tmp,
      "uploads",
      "a1b2c3d4",
      "20261111-094107-005-Screen Shot.png",
    );
    expect(b).toEqual({ ok: true, path: want, bytes: 7 });
    expect(new Uint8Array(fs.readFileSync(want))).toEqual(bytes);
    expect(fs.statSync(want).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(want)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(tmp, "uploads")).mode & 0o777).toBe(0o700);
    // The session's full name reaches the same session.
    const r2 = await post("acme-north:scout", "b.txt", "hi");
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { path: string }).path).toContain(
      `${path.sep}a1b2c3d4${path.sep}`,
    );
    const a = recentActions().filter((e) => e.verb === "upload");
    expect(a.at(-2)?.detail).toBe(
      "acme-north:scout: 20261111-094107-005-Screen Shot.png (7 bytes)",
    );
  });

  it("past max_bytes: 413 naming agents.uploads.max_bytes, and no file left (Content-Length, and a stream with none)", async () => {
    const r = await post("a1b2c3d4", "big.bin", new Uint8Array(max + 1));
    expect(r.status).toBe(413);
    const b = (await r.json()) as { error: string; code: string };
    expect(b.code).toBe("too_large");
    expect(b.error).toContain("agents.uploads.max_bytes");
    // No Content-Length: the stream is cut past the cap.
    const chunks = [new Uint8Array(600), new Uint8Array(600)];
    const stream = new ReadableStream({
      pull(c) {
        const x = chunks.shift();
        if (x) c.enqueue(x);
        else c.close();
      },
    });
    const r2 = await fetch(
      `${base}/api/sessions/a1b2c3d4/uploads?name=stream.bin`,
      { method: "POST", body: stream, duplex: "half" } as RequestInit,
    ).catch((e: Error) => e);
    if (!(r2 instanceof Error)) expect(r2.status).toBe(413);
    const left = fs
      .readdirSync(path.join(tmp, "uploads", "a1b2c3d4"))
      .filter((f) => /big|stream/.test(f));
    expect(left).toEqual([]);
    expect(
      recentActions()
        .filter((e) => e.verb === "upload" && e.outcome === "refused")
        .map((e) => e.reason),
    ).toContain("too_large");
  });

  it("an oversized Content-Length is refused before anything is read or made", async () => {
    sessions.push({
      ref: { backend: "den-pty", id: "d00dfeed" },
      name: "acme-north:early",
      pid: 4,
      startedAt: new Date().toISOString(),
    } as SessionInfo);
    const r = await post("d00dfeed", "big.bin", new Uint8Array(max * 3));
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toMatch(
      /^3 KB is over agents\.uploads\.max_bytes \(1 KB\)/,
    );
    expect(fs.existsSync(path.join(tmp, "uploads", "d00dfeed"))).toBe(false);
    // Refused before the body: audited all the same, naming the file.
    expect(
      recentActions().some(
        (e) =>
          e.verb === "upload" &&
          e.outcome === "refused" &&
          e.reason === "too_large" &&
          e.detail === "d00dfeed: big.bin",
      ),
    ).toBe(true);
  });

  it("refuses an unknown session (404), an ended one (409), and no name (400)", async () => {
    expect((await post("ffffffff", "x.png", "x")).status).toBe(404);
    expect((await post("e5f6a7b8", "x.png", "x")).status).toBe(409);
    expect((await post("a1b2c3d4", null, "x")).status).toBe(400);
    expect(fs.existsSync(path.join(tmp, "uploads", "e5f6a7b8"))).toBe(false);
    // Each refusal is audited with the code it sent.
    const reasons = recentActions()
      .filter((e) => e.verb === "upload" && e.outcome === "refused")
      .map((e) => e.reason);
    for (const code of ["not_found", "exited", "bad_request"])
      expect([code, reasons.includes(code)]).toEqual([code, true]);
  });

  it("never writes through a link in place of the session's folder", async () => {
    const elsewhere = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-sup-x-")),
    );
    sessions.push({
      ref: { backend: "den-pty", id: "c0ffee00" },
      name: "acme-north:linked",
      pid: 3,
      startedAt: new Date().toISOString(),
    } as SessionInfo);
    fs.mkdirSync(path.join(tmp, "uploads"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(tmp, "uploads", "c0ffee00"));
    const r = await post("c0ffee00", "x.png", "x");
    expect(r.status).toBe(500);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});
