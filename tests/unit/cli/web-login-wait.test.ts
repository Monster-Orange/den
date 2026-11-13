/**
 * SEC-2a: `<cli> web login` waits (cmdWebLoginWait), against a stand-in
 * server on a free port that answers the two calls the CLI makes
 * (POST /api/web/logins, GET /api/web/logins/<id>) as a test says: no real
 * server, no clock. It checks:
 *  - the link on stdout, the 8-character code on stderr, both registered
 *    with the server (the code is never in the link);
 *  - used: "Signed in: <browser> (<address>) at <time>", exit 0;
 *  - expired: "Expired: nobody used the link", exit 1;
 *  - `--no-wait`: the link alone, nothing asked of the server;
 *  - no server: the link alone, and a note that it doesn't wait.
 * The real server's side (the page asks for the code) is
 * sec2a-pair.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { cmdWebLoginWait } from "../../../src/ui/cli/web-command.js";

let tmp = "";
let stand: http.Server | null = null;
let seen: { method: string; path: string; body: string; auth: boolean }[] = [];
let answer: () => Record<string, unknown> = () => ({ state: "waiting" });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wwait-")));
  seen = [];
});
afterEach(async () => {
  if (stand)
    await new Promise<void>((r) => {
      stand!.closeAllConnections?.();
      stand!.close(() => r());
    });
  stand = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function standIn(): Promise<number> {
  stand = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body,
        auth: /^Bearer \S+$/.test(String(req.headers.authorization ?? "")),
      });
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "close",
      });
      if (req.method === "POST" && req.url === "/api/web/logins")
        return res.end(JSON.stringify({ ok: true, id: "w".repeat(32) }));
      res.end(JSON.stringify({ ok: true, ...answer() }));
    });
  });
  await new Promise<void>((r) => stand!.listen(0, "127.0.0.1", r));
  return (stand.address() as AddressInfo).port;
}

async function login(args: string[]) {
  let out = "";
  let err = "";
  const code = await cmdWebLoginWait(
    args,
    {
      out: (s) => (out += s),
      err: (s) => (err += s),
      stateDir: tmp,
      // D80: the install's address the link is on.
      webUrl: () => ({ url: "https://den.acme.example.com", confirmed: true }),
    },
    { pollMs: 1 },
  );
  return { code, out, err };
}

describe("web login waits", () => {
  it("prints the link and an 8-character code, registers both, and on use says who signed in", async () => {
    const port = await standIn();
    let polls = 0;
    answer = () =>
      ++polls < 3
        ? { state: "opened" }
        : {
            state: "used",
            device: "Safari on macOS",
            client: "100.64.0.7",
            usedAt: new Date(2026, 10, 6, 10, 42).toISOString(),
          };
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(0);
    const [link, signed] = r.out.trim().split("\n");
    expect(new URL(link).pathname).toBe("/auth");
    const code = /It asks for this code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(
      r.err,
    )?.[1];
    expect(!!code).toBe(true);
    expect(link.includes(code!)).toBe(false);
    expect(signed).toBe("Signed in: Safari on macOS (100.64.0.7) at 10:42");
    // Registered with the CLI's bearer: the link's nonce and the code.
    const reg = JSON.parse(seen[0].body) as Record<string, unknown>;
    expect([seen[0].method, seen[0].path, seen[0].auth]).toEqual([
      "POST",
      "/api/web/logins",
      true,
    ]);
    expect(reg.code).toBe(code);
    expect(link.includes(String(reg.nonce))).toBe(true);
    expect(
      seen
        .slice(1)
        .every((s) => s.path === `/api/web/logins/${"w".repeat(32)}`),
    ).toBe(true);
  });

  it("nobody uses it: Expired, exit 1", async () => {
    const port = await standIn();
    answer = () => ({ state: "expired" });
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Expired: nobody used the link\n$/);
    expect(r.out).not.toMatch(/Signed in/);
  });

  it("too many wrong codes on the page: Refused, exit 1", async () => {
    const port = await standIn();
    answer = () => ({ state: "refused" });
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Refused: too many wrong codes/);
  });

  it("--no-wait: the link alone, nothing asked of the server", async () => {
    const port = await standIn();
    const r = await login(["--no-wait", "--port", String(port)]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.err).not.toMatch(/code:/);
    expect(seen).toEqual([]);
  });

  it("no server running: the link alone, and a note that it doesn't wait", async () => {
    const port = await standIn();
    await new Promise<void>((r) => {
      stand!.closeAllConnections?.();
      stand!.close(() => r());
    });
    stand = null;
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(0);
    expect(new URL(r.out.trim()).pathname).toBe("/auth");
    expect(r.err).toMatch(/doesn't wait and the link asks for no code/);
  });
});
