/**
 * Issue 455 (follow-up, Vision): when nothing answers the install's
 * address, Den still gives it (D80: web.url is the address), and says so
 * plainly next to it: "Not reachable yet: nothing answers at {address}."
 * Only when Den knows its edge is down does it add "The edge isn't
 * running." and the next step; otherwise nothing more. Everywhere the CLI
 * hands the address out: `web up` / `web open` (upAddressLines) and the
 * sign-in link (`web login`).
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { cmdWebLogin } from "../../../src/ui/cli/web-command.js";
import { ensureWebSecret } from "../../../src/shared/web/web-secret.js";
import {
  DEN_IDENTITY_PATH,
  identityBody,
  identityKey,
} from "../../../src/shared/den-identity.js";
import {
  checkAddress,
  upAddressLines,
} from "../../../src/shared/edge/address-check.js";

let tmp = "";
const servers: http.Server[] = [];
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-455u-")));
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

function denStub(key: Buffer): Promise<number> {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === DEN_IDENTITY_PATH) {
      const b = identityBody(key, u.searchParams.get("c"));
      res.writeHead(b ? 200 : 400, { "content-type": "application/json" });
      return res.end(JSON.stringify(b ?? {}));
    }
    res.writeHead(200).end("den");
  });
  servers.push(s);
  return new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)),
  );
}

/** A port nothing listens on (bound, then let go). */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(() => r(null)));
  return p;
}

async function login(edgeDown: boolean | null) {
  const key = identityKey(ensureWebSecret(tmp));
  const denPort = await denStub(key);
  const wanted = `http://den.acme.localhost:${await freePort()}`;
  let out = "";
  let err = "";
  const code = await cmdWebLogin(["--port", String(denPort)], {
    out: (s) => (out += s),
    err: (s) => (err += s),
    stateDir: tmp,
    // Sign-in: the person's own terminal.
    person: { tty: true, line: () => [process.pid, 1] },
    webUrl: () => ({ url: wanted, confirmed: true }),
    addressDeps: { edgeDown: () => edgeDown },
  });
  return { code, out, err, wanted };
}

describe("nothing answers the install's address", () => {
  it("the sign-in link stays on it (D80), with the plain line, and the edge's next step when it is down", async () => {
    const r = await login(true);
    expect(r.code).toBe(0);
    expect(r.out.trim().startsWith(`${r.wanted}/auth?c=`)).toBe(true);
    expect(r.err).toContain(
      `Not reachable yet: nothing answers at ${r.wanted}.`,
    );
    expect(r.err).toMatch(
      /The edge isn't running\. Start it with: \S+ edge up/,
    );
  });

  it("the edge's state unknown or running: the plain line only", async () => {
    for (const down of [null, false]) {
      const r = await login(down);
      expect(r.err).toContain(
        `Not reachable yet: nothing answers at ${r.wanted}.`,
      );
      expect(r.err).not.toContain("The edge isn't running");
    }
  });

  it("web up / web open print the same lines next to the address", async () => {
    const key = identityKey(ensureWebSecret(tmp));
    const denPort = await denStub(key);
    const wanted = `http://den.acme.localhost:${await freePort()}`;
    const s = await checkAddress({
      webPort: denPort,
      wanted,
      key,
      settings: { timeoutMs: 2000, retries: 0, cacheMs: 0 },
    });
    const w = { lang: "en" as const, title: "Den", cli: "den" };
    expect(upAddressLines(s, w, true)).toEqual([
      `Not reachable yet: nothing answers at ${wanted}.`,
      "The edge isn't running. Start it with: den edge up",
    ]);
    expect(upAddressLines(s, w, null)).toEqual([
      `Not reachable yet: nothing answers at ${wanted}.`,
    ]);
    // es and ja have the line too.
    for (const lang of ["es", "ja"] as const) {
      const l = upAddressLines(s, { ...w, lang }, true);
      expect([lang, l.length, l[0].includes(wanted)]).toEqual([lang, 2, true]);
    }
  });

  it("the address answers as Den, or something else answers: no such line", async () => {
    const key = identityKey(ensureWebSecret(tmp));
    const denPort = await denStub(key);
    const s = await checkAddress({
      webPort: denPort,
      wanted: `http://localhost:${denPort}`,
      key,
      settings: { timeoutMs: 2000, retries: 0, cacheMs: 0 },
    });
    expect(
      upAddressLines(s, { lang: "en", title: "Den", cli: "den" }, true),
    ).toEqual([]);
  });
});
