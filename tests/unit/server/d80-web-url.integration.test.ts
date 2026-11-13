/**
 * D80 (Ward: "edge has nothing to do with it .. why any fallback?"): this
 * install's address, web.url, is the one people are given. A real server
 * and the real CLI on this machine, in two throwaway distributions:
 *
 * - web.url set: the start banner, `web login`'s link, `web claim-link`'s
 *   link and `web up --json`'s url all start with it; none says localhost;
 *   doctor's Address row is ok.
 * - web.url unset (and nothing to take it from): the banner says "address
 *   not set", no link is printed, nothing says localhost, and doctor fails
 *   with the fix.
 *
 * And the one-time migration: an install with an edge route and no web.url
 * takes the route's address once, unconfirmed, for doctor to show.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { spawnServer, stopServer } from "../../child-servers.js";
import {
  checkWebUrl,
  migrateWebUrl,
  readWebUrl,
  setWebUrl,
} from "../../../src/shared/web-url.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const ADDRESS = "https://den.acme.example.com";

let tmp = "";

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

interface Install {
  dist: string;
  home: string;
  port: number;
  server?: ChildProcess;
  out: string;
}

function env(i: Install): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEN_ROOT: i.dist,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_EDGE_DIR: path.join(i.home, "edge-state"),
    DEN_HOME: path.join(i.home, ".den"),
    HOME: i.home,
    DEN_NO_OPEN: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PORT: String(i.port),
    CI: "1",
  };
}

async function install(name: string, userYml: string): Promise<Install> {
  const dist = path.join(tmp, name);
  const home = path.join(tmp, `${name}-home`);
  fs.mkdirSync(home, { recursive: true });
  write(path.join(dist, "den.yml"), "product:\n  name: den\n");
  write(path.join(dist, "config", "den.yml"), "environments: [local]\n");
  if (userYml) write(path.join(dist, "config", "local", "user.yml"), userYml);
  const i: Install = { dist, home, port: await freePort(), out: "" };
  i.server = spawnServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    { cwd: dist, env: env(i), stdio: ["ignore", "pipe", "pipe"] },
  );
  i.server.stdout!.on("data", (d: Buffer) => (i.out += d.toString()));
  i.server.stderr!.on("data", (d: Buffer) => (i.out += d.toString()));
  const deadline = Date.now() + 40_000;
  while (!/Web UI\s+→/.test(i.out)) {
    if (Date.now() > deadline)
      throw new Error(`${name}: no banner:\n${i.out.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return i;
}

function cli(i: Install, args: string[]) {
  const r = spawnSync(
    TSX,
    [path.join(ENGINE, "src", "ui", "cli", "index.ts"), ...args],
    { cwd: i.dist, encoding: "utf-8", timeout: 60_000, env: env(i) },
  );
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const bannerLine = (i: Install) =>
  i.out.split("\n").find((l) => /Web UI\s+→/.test(l)) ?? "";

let set: Install;
let unset: Install;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-d80-")));
  [set, unset] = await Promise.all([
    install("with-url", `web:\n  url: ${ADDRESS}\n`),
    install("no-url", ""),
  ]);
}, 90_000);

afterAll(async () => {
  for (const i of [set, unset]) if (i?.server) await stopServer(i.server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("D80: web.url set", () => {
  it("the banner names it, and not localhost", () => {
    expect(bannerLine(set)).toMatch(
      new RegExp(`Web UI\\s+→\\s+${ADDRESS.replace(/\./g, "\\.")}\\s*$`),
    );
    expect(bannerLine(set)).not.toMatch(/localhost/);
  });

  it("web login's and web claim-link's links start with it", () => {
    const login = cli(set, ["web", "login", "--no-wait"]);
    expect(login.code).toBe(0);
    expect(login.out.trim().startsWith(`${ADDRESS}/auth?c=`)).toBe(true);
    const claim = cli(set, ["web", "claim-link"]);
    expect(claim.code).toBe(0);
    expect(claim.out.trim().startsWith(`${ADDRESS}/auth?claim=`)).toBe(true);
    expect(`${login.out}${claim.out}`).not.toMatch(/localhost/);
  }, 90_000);

  it("web up --json's url is it; doctor's Address row is ok", () => {
    const up = cli(set, ["web", "up", "--no-open", "--json"]);
    const j = JSON.parse(up.out) as { url: unknown };
    expect(j.url).toBe(ADDRESS);
    const doc = cli(set, ["doctor", "--json"]);
    const checks = (JSON.parse(doc.out) as { checks: { id: string }[] }).checks;
    expect(checks.find((c) => c.id === "address")).toMatchObject({
      status: "ok",
      detail: ADDRESS,
    });
  }, 120_000);
});

describe("D80: web.url unset", () => {
  it("the banner says so, never localhost", () => {
    expect(bannerLine(unset)).toMatch(
      /Web UI\s+→\s+address not set: run `den web url <address>`/,
    );
    expect(bannerLine(unset)).not.toMatch(/localhost/);
  });

  it("no sign-in link: each says how to set it", () => {
    for (const args of [
      ["web", "login", "--no-wait"],
      ["web", "claim-link"],
    ]) {
      const r = cli(unset, args);
      expect([args.join(" "), r.code, r.out]).toEqual([args.join(" "), 1, ""]);
      expect(r.err).toMatch(/address not set: run `den web url <address>`/);
      expect(r.err).not.toMatch(/localhost/);
    }
  }, 90_000);

  it("doctor fails, with the fix; web up --json has no url", () => {
    const doc = cli(unset, ["doctor", "--json"]);
    const j = JSON.parse(doc.out) as {
      ok: boolean;
      checks: { id: string; status: string; detail: string }[];
    };
    expect(j.ok).toBe(false);
    expect(j.checks.find((c) => c.id === "address")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/not set: run `den web url <address>`/),
    });
    expect(doc.code).toBe(1);
    const up = cli(unset, ["web", "up", "--no-open", "--json"]);
    const u = JSON.parse(up.out) as { url: unknown; address?: string };
    expect(u.url).toBeNull();
    expect(u.address).toMatch(/address not set/);
    expect(up.out).not.toMatch(/localhost/);
  }, 120_000);
});

describe("D80: the address itself", () => {
  const store = () => {
    let user: UserConfig = {};
    return {
      read: () => user,
      merge: (p: Partial<UserConfig>) => (user = { ...user, ...p }),
      get: () => user,
    };
  };

  it("is an http(s) origin: no path, query or user", () => {
    expect(checkWebUrl("https://a.example.com/")).toEqual({
      url: "https://a.example.com",
    });
    for (const bad of [
      "",
      "a.example.com",
      "ftp://a.example.com",
      "https://a.example.com/x",
      "https://a.example.com/?q",
      "https://u:p@a.example.com",
    ])
      expect(checkWebUrl(bad)).toHaveProperty("error");
  });

  it("a migration takes what the install had once, unconfirmed; setting it confirms it", () => {
    const s = store();
    const found = () => ({
      url: "https://old.example.com",
      from: "the edge route",
    });
    expect(migrateWebUrl(found, s.merge, s.read)).toEqual({
      url: "https://old.example.com",
      confirmed: false,
      from: "the edge route",
    });
    // Once: it is set now, so a second finding changes nothing.
    expect(
      migrateWebUrl(
        () => ({ url: "https://other.example.com", from: "x" }),
        s.merge,
        s.read,
      )?.url,
    ).toBe("https://old.example.com");
    setWebUrl("https://new.example.com", s.merge, s.read);
    expect(readWebUrl(s.read)).toEqual({
      url: "https://new.example.com",
      confirmed: true,
    });
    // Nothing to take: nothing set.
    const e = store();
    expect(migrateWebUrl(() => undefined, e.merge, e.read)).toBeNull();
    expect(e.get()).toEqual({});
  });
});
