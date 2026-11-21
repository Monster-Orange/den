/**
 * SEC-2a: `<cli> web login` waits (cmdWebLoginWait), against a stand-in
 * server on a free port that answers the two calls the CLI makes
 * (POST /api/web/logins, GET /api/web/logins/<id>) as a test says: no real
 * server, no clock. It checks:
 *  - the link on stdout, its nonce registered with the server (issue 819:
 *    no code to type; once someone has signed in, a signed-in browser
 *    approves the device the link opens);
 *  - used: "Signed in: <browser> (<address>) at <time>", exit 0;
 *  - pairing (issue 819): where to approve it, then who signed in;
 *  - denied (issue 819): "Denied", exit 1;
 *  - expired: "Expired: nobody used the link", exit 1;
 *  - `--no-wait`: the link alone, nothing asked of the server;
 *  - no server: the link alone, and a note that it doesn't wait.
 * The real server's side is issue-819-device-approval.integration.test.ts.
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
// Issue 819: whether the stand-in says nobody has signed in yet.
let firstRun = false;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wwait-")));
  seen = [];
  firstRun = false;
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
        return res.end(
          JSON.stringify({ ok: true, id: "w".repeat(32), firstRun }),
        );
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
      // Sign-in: the person's own terminal.
      person: { tty: true, line: () => [process.pid, 1] },
      // D80: the install's address the link is on.
      webUrl: () => ({ url: "https://den.acme.example.com", confirmed: true }),
    },
    { pollMs: 1 },
  );
  return { code, out, err };
}

describe("web login waits", () => {
  it("prints the link, registers its nonce, and on use says who signed in", async () => {
    const port = await standIn();
    let polls = 0;
    answer = () =>
      ++polls < 3
        ? { state: "waiting" }
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
    // Issue 819: no code to type; where a set-up install approves it.
    expect(r.err).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
    expect(r.err).toMatch(/Settings › Access/);
    expect(signed).toBe("Signed in: Safari on macOS (100.64.0.7) at 10:42");
    // Registered with the CLI's bearer: the link's nonce and expiry.
    const reg = JSON.parse(seen[0].body) as Record<string, unknown>;
    expect([seen[0].method, seen[0].path, seen[0].auth]).toEqual([
      "POST",
      "/api/web/logins",
      true,
    ]);
    // Issue 819: a confirmation code is registered, printed on first run only.
    expect(reg.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(typeof reg.expiresAt).toBe("number");
    expect(link.includes(String(reg.nonce))).toBe(true);
    expect(
      seen
        .slice(1)
        .every((s) => s.path === `/api/web/logins/${"w".repeat(32)}`),
    ).toBe(true);
  });

  it("issue 819: first run: prints the code it registered, for a browser on another computer to type", async () => {
    const port = await standIn();
    firstRun = true;
    answer = () => ({
      state: "used",
      device: "Safari on macOS",
      usedAt: new Date(2026, 10, 6, 10, 42).toISOString(),
    });
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(0);
    const reg = JSON.parse(seen[0].body) as Record<string, unknown>;
    expect(r.err).toContain(
      `Opened on another computer, it asks for this code: ${String(reg.code)}`,
    );
  });

  it("issue 819: opened once set up: prints the code that device's screen shows, to type in a signed-in browser", async () => {
    const port = await standIn();
    let polls = 0;
    answer = () =>
      ++polls < 3
        ? {
            state: "pairing",
            device: "Safari on macOS",
            client: "100.64.0.7",
            code: "K7Q-42M",
          }
        : { state: "denied" };
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(1);
    expect(
      r.err.match(
        /Its screen shows the code K7Q-42M: type it in a browser that is signed in, at Settings › Access\./g,
      ),
    ).toHaveLength(1);
  });

  it("nobody uses it: Expired, exit 1", async () => {
    const port = await standIn();
    answer = () => ({ state: "expired" });
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Expired: nobody used the link\n$/);
    expect(r.out).not.toMatch(/Signed in/);
  });

  it("issue 819: opened once the install is set up: says where to approve it, then who signed in", async () => {
    const port = await standIn();
    let polls = 0;
    answer = () =>
      ++polls < 3
        ? { state: "pairing", device: "Safari on macOS", client: "100.64.0.7" }
        : {
            state: "used",
            device: "Safari on macOS",
            client: "100.64.0.7",
            usedAt: new Date(2026, 10, 6, 10, 42).toISOString(),
          };
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(0);
    expect(
      r.err.match(
        /opened in Safari on macOS \(100\.64\.0\.7\)\. Approve it in a browser that is signed in: Settings › Access\./g,
      ),
    ).toHaveLength(1);
    expect(r.out.trim().split("\n")[1]).toBe(
      "Signed in: Safari on macOS (100.64.0.7) at 10:42",
    );
  });

  it("issue 819: denied in a signed-in browser: Denied, exit 1", async () => {
    const port = await standIn();
    answer = () => ({ state: "denied" });
    const r = await login(["--port", String(port)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Denied in a signed-in browser/);
    expect(r.out).not.toMatch(/Signed in/);
  });

  it("a server from before issue 819: too many wrong codes on the page: Refused, exit 1", async () => {
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
    expect(r.err).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
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
    expect(r.err).toMatch(/doesn't wait \(as --no-wait\)/);
  });
});
