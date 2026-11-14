/**
 * #71: Hub rotates an install's token (its Postgres cutover carries old
 * tokens as "legacy"). Den asks for a new one (whoami ?rotate=true) only
 * when Den keeps the token itself, writes it in place, and confirms it with
 * a second whoami. A token Den doesn't keep stays, and Settings and doctor
 * say to reconnect. A fake Hub on localhost, a temp token file.
 */
import { afterAll, afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  HubCallError,
  hubStatus,
  hubWhoami,
  readHubToken,
  type HubConfig,
  type HubTokenRotation,
} from "../../../src/shared/hub.js";
import { hubTokenRotation } from "../../../src/ui/server/hub-connect.js";
import { hubLines } from "../../../src/ui/cli/doctor-command.js";
import { hubHtml } from "../../../src/ui/server/public/settings-registry.js";

const OLD = "hubi_TESTONLYlegacy111";
const NEW = "hubt_TESTONLYrotated222";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-hubrot-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * A Hub that carries OLD as a legacy token. whoami ?rotate=true as OLD
 * offers NEW (pending); NEW's first use makes it current and ends OLD.
 */
interface FakeHub {
  url: string;
  seen: { path: string; auth: string }[];
  close: () => Promise<void>;
}
async function rotatingHub(
  opts: { refuseNew?: boolean } = {},
): Promise<FakeHub> {
  const seen: FakeHub["seen"] = [];
  let current = OLD;
  let pending: string | null = null;
  const s = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? "");
    seen.push({ path: req.url ?? "", auth });
    const send = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/connect/whoami") return void res.writeHead(404).end();
    const tok = auth.replace(/^Bearer /, "");
    if (pending && tok === pending && !opts.refuseNew) {
      current = pending;
      pending = null;
    }
    if (tok !== current) return send(401, { error: "unauthorized" });
    const legacy = current === OLD;
    if (legacy && u.searchParams.get("rotate") === "true") pending = NEW;
    send(200, {
      install: "north-box",
      login: "pat",
      token: legacy ? "legacy" : "current",
      ...(legacy && pending ? { rotated_token: pending } : {}),
    });
  });
  await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
  return {
    url: `http://localhost:${(s.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  };
}

const hubs: FakeHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});
const hub = async (o?: { refuseNew?: boolean }) => {
  const h = await rotatingHub(o);
  hubs.push(h);
  return h;
};

/** Den's own token file (Connect's), holding `tok`. */
function denFile(tok: string): string {
  const dir = fs.mkdtempSync(path.join(tmp, "st-"));
  const f = path.join(dir, "hub", "token");
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, `${tok}\n`, { mode: 0o600 });
  return f;
}
const cfgFor = (url: string, file: string): HubConfig => ({
  url,
  tokenRef: null,
  tokenSource: { kind: "file", path: file },
  tokenFrom: `hub.token (file ${file})`,
  mcpUrl: `${url}/mcp`,
  allowTools: true,
  inboxOnStop: "nudge",
  syncCheckSeconds: 30,
  namesCheckSeconds: 300,
  mcpRetrySeconds: 30,
  mcpRetryAttempts: 0,
  deliveryHeartbeatSeconds: 15,
  deliveryPollSeconds: 30,
});
const readFile = (f: string) => fs.readFileSync(f, "utf8").trim();

function rotation(
  file: string,
  over: Partial<HubTokenRotation> = {},
): { r: HubTokenRotation; rows: { detail: string; refused?: string }[] } {
  const rows: { detail: string; refused?: string }[] = [];
  const r = {
    ...hubTokenRotation({
      file,
      record: (detail, refused) =>
        rows.push({ detail, ...(refused ? { refused } : {}) }),
    }),
    ...over,
  };
  return { r, rows };
}

describe("#71 whoami: token kind and rotated_token", () => {
  it("rotate=true only when asked; rotated_token read only then, and only a header-safe one", async () => {
    const h = await hub();
    const plain = await hubWhoami(h.url, OLD);
    expect(plain).toMatchObject({ token: "legacy" });
    expect("rotatedToken" in plain).toBe(false);
    expect(h.seen.at(-1)!.path).toBe("/connect/whoami");
    const asked = await hubWhoami(h.url, OLD, { rotate: true });
    expect(h.seen.at(-1)!.path).toBe("/connect/whoami?rotate=true");
    expect(asked.rotatedToken).toBe(NEW);

    const odd = http.createServer((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "weird", rotated_token: "has space x" }));
    });
    await new Promise<void>((r) => odd.listen(0, "localhost", () => r()));
    const w = await hubWhoami(
      `http://localhost:${(odd.address() as AddressInfo).port}`,
      OLD,
      { rotate: true },
    );
    odd.closeAllConnections();
    odd.close();
    expect(w).toEqual({});
  });
});

describe("#71 hubStatus with rotation (the server's /api/hub)", () => {
  it("Den's own file: asks, writes the new token in place, confirms it, and says rotated", async () => {
    const h = await hub();
    const f = denFile(OLD);
    const { r, rows } = rotation(f);
    const cfg = cfgFor(h.url, f);
    const st = await hubStatus({ config: () => cfg, rotation: r });
    expect(st).toMatchObject({
      connected: true,
      state: "connected",
      rotated: true,
    });
    expect("legacy" in st).toBe(false);
    expect(readFile(f)).toBe(NEW);
    expect((fs.statSync(f).mode & 0o777).toString(8)).toBe("600");
    // The second whoami is the new token's first use, without rotate.
    expect(h.seen.map((x) => [x.path, x.auth])).toEqual([
      ["/connect/whoami?rotate=true", `Bearer ${OLD}`],
      ["/connect/whoami", `Bearer ${NEW}`],
    ]);
    expect(rows).toEqual([
      { detail: "Den stored the new token Hub rotated to, and Hub took it" },
    ]);
    // Next time: current, nothing to rotate, and the file is what's read.
    expect(await readHubToken(cfg)).toBe(NEW);
    const again = await hubStatus({ config: () => cfg, rotation: r });
    expect(again).toMatchObject({ connected: true });
    expect("rotated" in again || "legacy" in again).toBe(false);
    // Never a token in what the status says, or the audit's words.
    expect(JSON.stringify([st, again, rows])).not.toMatch(/TESTONLY/);
  });

  it("a token Den doesn't keep (a distribution's file): never asks, never writes; legacy, and Reconnect", async () => {
    const h = await hub();
    const theirs = denFile(OLD);
    const { r, rows } = rotation(path.join(tmp, "dens-own", "hub", "token"));
    const st = await hubStatus({
      config: () => cfgFor(h.url, theirs),
      rotation: r,
    });
    expect(st).toMatchObject({ connected: true, legacy: true });
    expect(h.seen.map((x) => x.path)).toEqual(["/connect/whoami"]);
    expect(readFile(theirs)).toBe(OLD);
    expect(rows).toEqual([]);

    const doc = hubLines(st, "Acme");
    expect(doc.check).toMatchObject({ status: "warn" });
    expect(doc.lines.join("\n")).toMatch(
      /connected .*older Hub token kept where Den can't replace it \(Settings › Agents › Hub: Reconnect\)/,
    );
    const html = hubHtml(st, null, (k: string) => `[${k}]`);
    expect(html).toContain("[hub.legacy]");
    expect(html).toContain('data-hub-action="connect">[hub.reconnect]');
  });

  it("without rotation (doctor, the CLI): only reports legacy", async () => {
    const h = await hub();
    const f = denFile(OLD);
    const st = await hubStatus({ config: () => cfgFor(h.url, f) });
    expect(st).toMatchObject({ connected: true, legacy: true });
    expect(h.seen.map((x) => x.path)).toEqual(["/connect/whoami"]);
    expect(readFile(f)).toBe(OLD);
  });

  it("Hub refuses the new token: the old one is written back, still legacy", async () => {
    const h = await hub({ refuseNew: true });
    const f = denFile(OLD);
    const { r, rows } = rotation(f);
    const st = await hubStatus({ config: () => cfgFor(h.url, f), rotation: r });
    expect(st).toMatchObject({ connected: true, legacy: true });
    expect(readFile(f)).toBe(OLD);
    expect(rows).toEqual([
      {
        detail:
          "Hub refused the new token it offered; Den put the old one back",
        refused: "rotated_refused",
      },
    ]);
  });

  it("the store can't take it: the old one stays, and the audit says why without the token", async () => {
    const h = await hub();
    const f = denFile(OLD);
    const { r, rows } = rotation(f, {
      write: async (_c, tok) => {
        throw new Error(`locked while writing ${tok}`);
      },
    });
    const st = await hubStatus({ config: () => cfgFor(h.url, f), rotation: r });
    expect(st).toMatchObject({ connected: true, legacy: true });
    expect(readFile(f)).toBe(OLD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refused: "store_failed" });
    expect(rows[0]!.detail).toContain("locked while writing [token]");
    expect(rows[0]!.detail).not.toMatch(/TESTONLY/);
  });

  it("two looks at once (Settings and the rail): one rotation, both connected", async () => {
    const h = await hub();
    const f = denFile(OLD);
    const { r } = rotation(f);
    const cfg = cfgFor(h.url, f);
    const both = await Promise.all([
      hubStatus({ config: () => cfg, rotation: r }),
      hubStatus({ config: () => cfg, rotation: r }),
    ]);
    expect(both.every((x) => x.configured && x.connected)).toBe(true);
    expect(readFile(f)).toBe(NEW);
    expect(
      h.seen.filter(
        (x) => x.path.endsWith("rotate=true") && x.auth.includes(OLD),
      ),
    ).toHaveLength(1);
  });
});

describe("#71 two processes (Hub replaces a pending token when asked again)", () => {
  const T2 = "hubi_TESTONLYother.333333";
  const rejected = () =>
    new HubCallError("rejected", "Hub doesn't accept this install's token");

  it("a 401 on the old token: Den reads the store again and uses the newer one before saying Reconnect", async () => {
    const f = denFile(OLD);
    const { r } = rotation(f);
    // Another process rotated and wrote T2 after this read the file.
    let reads = 0;
    const st = await hubStatus({
      config: () => cfgFor("http://localhost:9", f),
      token: async () => (reads++ === 0 ? OLD : T2),
      whoami: async (_u, t) => {
        if (t === T2) return { login: "pat", token: "current" };
        throw rejected();
      },
      rotation: r,
    });
    expect(st).toMatchObject({ connected: true, state: "connected" });
    expect(reads).toBe(2);
  });

  it("this one's pending token refused because another process's newer one replaced it: Den keeps the newer one", async () => {
    const f = denFile(OLD);
    const { r, rows } = rotation(f);
    const st = await hubStatus({
      config: () => cfgFor("http://localhost:9", f),
      token: async () => readFile(f),
      whoami: async (_u, t, o) => {
        if (t === OLD && o?.rotate)
          return { token: "legacy", rotatedToken: NEW };
        if (t === NEW) {
          // Meanwhile the other process stored T2, and Hub took it.
          fs.writeFileSync(f, `${T2}\n`, { mode: 0o600 });
          throw rejected();
        }
        throw rejected();
      },
      rotation: r,
    });
    expect(readFile(f)).toBe(T2);
    expect(st).toMatchObject({ connected: true, legacy: true });
    expect(rows).toEqual([
      {
        detail:
          "Hub refused the new token it offered; another process stored a newer one, which Den keeps",
        refused: "rotated_refused",
      },
    ]);
  });

  it("no token field (Hub before its cutover): current, nothing said", async () => {
    const f = denFile(OLD);
    const st = await hubStatus({
      config: () => cfgFor("http://localhost:9", f),
      token: async () => OLD,
      whoami: async () => ({ login: "pat" }),
      rotation: rotation(f).r,
    });
    expect(st).toMatchObject({ connected: true });
    expect("legacy" in st || "rotated" in st).toBe(false);
  });
});
