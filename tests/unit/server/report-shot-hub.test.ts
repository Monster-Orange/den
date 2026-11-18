/**
 * Issue 403: the one module that talks to Hub about a report's screenshot
 * (report-shot-hub.ts). A fake Hub (a local http server): never a real one.
 *
 *   preflight(target)  GET  <hub>/api/installs/self/reports/screenshots/preflight?target=<owner/name>
 *   upload(png, …)     POST <hub>/api/installs/self/reports/screenshots
 *
 * Both with the install's connection Bearer. Every answer that isn't the
 * happy one is a plain, non-fatal outcome. Invented names only.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  PREFLIGHT_PATH,
  UPLOAD_PATH,
  reportShotHub,
} from "../../../src/ui/server/report-shot-hub.js";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
const seen: Seen[] = [];
/** The fake Hub's next answer: [status, JSON body]. */
let answer: [number, unknown] = [200, {}];
let hang = false;
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      if (hang) return;
      res.writeHead(answer[0], { "content-type": "application/json" });
      res.end(JSON.stringify(answer[1]));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
});

beforeEach(() => {
  seen.length = 0;
  hang = false;
});

const TOKEN = "install-token-never-shown";
const client = (connected = true) =>
  reportShotHub({
    hub: async () => (connected ? { url: base, token: TOKEN } : null),
    timeoutMs: 1000,
  });

/** A PNG's first bytes, then some more. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not really pixels"),
]);

describe("issue 403: preflight", () => {
  it("GET …/screenshots/preflight?target=<owner/name> with the install's Bearer", async () => {
    answer = [200, { share: true, recipient: "Acme maintainers", why: null }];
    const r = await client().preflight("acme-eng/engine");
    expect(r).toEqual({ ok: true, share: true, recipient: "Acme maintainers" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${PREFLIGHT_PATH}?target=acme-eng%2Fengine`);
    expect(PREFLIGHT_PATH).toBe(
      "/api/installs/self/reports/screenshots/preflight",
    );
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("share false: text only, with Hub's why", async () => {
    answer = [200, { share: false, recipient: "Acme maintainers", why: "off" }];
    expect(await client().preflight("acme-eng/engine")).toEqual({
      ok: true,
      share: false,
      recipient: "Acme maintainers",
      why: "off",
    });
  });

  it("not connected: no call, a reason", async () => {
    const r = await client(false).preflight("acme-eng/engine");
    expect(r).toEqual({ ok: false, reason: "not-connected" });
    expect(seen).toHaveLength(0);
  });

  it("an error, a non-JSON answer or no answer: a reason, never a throw", async () => {
    answer = [500, { error: "boom" }];
    expect(await client().preflight("acme-eng/engine")).toMatchObject({
      ok: false,
    });
    answer = [200, { share: "yes" }];
    expect(await client().preflight("acme-eng/engine")).toMatchObject({
      ok: false,
    });
    hang = true;
    expect(await client().preflight("acme-eng/engine")).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("a target that isn't owner/name is refused before any call", async () => {
    expect(await client().preflight("not a repo")).toEqual({
      ok: false,
      reason: "bad-target",
    });
    expect(seen).toHaveLength(0);
  });
});

describe("issue 403: upload", () => {
  it("POST …/screenshots: the raw PNG, X-Den-Report, X-Den-Target, the Bearer; 201 is the record", async () => {
    answer = [
      201,
      {
        id: "shot_1",
        tool: "hub_report_screenshot shot_1",
        sha256: "ab".repeat(32),
        expires: "2026-12-17T00:00:00.000Z",
        recipient: "Acme maintainers",
      },
    ];
    const r = await client().upload(PNG, {
      draftId: "0123456789abcdef",
      targetRepo: "acme-eng/engine",
    });
    expect(r).toEqual({
      ok: true,
      id: "shot_1",
      tool: "hub_report_screenshot shot_1",
      sha256: "ab".repeat(32),
      expires: "2026-12-17T00:00:00.000Z",
      recipient: "Acme maintainers",
    });
    expect(UPLOAD_PATH).toBe("/api/installs/self/reports/screenshots");
    const s = seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe(UPLOAD_PATH);
    expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.headers["content-type"]).toBe("image/png");
    expect(s.headers["x-den-report"]).toBe("0123456789abcdef");
    expect(s.headers["x-den-target"]).toBe("acme-eng/engine");
    expect(s.body.equals(PNG)).toBe(true);
  });

  it.each([
    [403, { why: "off" }, "off"],
    [403, { why: "not-maintained" }, "not-maintained"],
    [403, { why: "not-a-person" }, "not-a-person"],
    [403, {}, "refused"],
    [409, {}, "conflict"],
    [413, {}, "too-big"],
    [415, {}, "not-png"],
    [429, {}, "limit"],
    [500, {}, "unreachable"],
    [400, {}, "refused"],
  ])(
    "%i %j: a plain outcome (%s), never a throw",
    async (status, body, why) => {
      answer = [status, body];
      const r = await client().upload(PNG, {
        draftId: "0123456789abcdef",
        targetRepo: "acme-eng/engine",
      });
      expect(r).toEqual({ ok: false, why, status });
    },
  );

  it("201 without the record's fields: refused", async () => {
    answer = [201, { id: "shot_1" }];
    expect(
      await client().upload(PNG, {
        draftId: "0123456789abcdef",
        targetRepo: "acme-eng/engine",
      }),
    ).toMatchObject({ ok: false, why: "refused" });
  });

  it("not connected, or no answer: a plain outcome", async () => {
    expect(
      await client(false).upload(PNG, {
        draftId: "0123456789abcdef",
        targetRepo: "acme-eng/engine",
      }),
    ).toEqual({ ok: false, why: "not-connected" });
    hang = true;
    expect(
      await client().upload(PNG, {
        draftId: "0123456789abcdef",
        targetRepo: "acme-eng/engine",
      }),
    ).toEqual({ ok: false, why: "unreachable" });
  });

  it("over 6 MB, or not a PNG: never sent", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    expect(
      await client().upload(big, {
        draftId: "0123456789abcdef",
        targetRepo: "acme-eng/engine",
      }),
    ).toEqual({ ok: false, why: "too-big" });
    expect(
      await client().upload(Buffer.from("GIF89a"), {
        draftId: "0123456789abcdef",
        targetRepo: "acme-eng/engine",
      }),
    ).toEqual({ ok: false, why: "not-png" });
    expect(seen).toHaveLength(0);
  });
});
