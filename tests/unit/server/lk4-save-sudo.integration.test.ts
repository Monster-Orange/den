/**
 * LK-4 (WS-AG-UX spec, "save without editing YAML") on the real server:
 * with `secrets.provider: 1password` and no `secrets.refs.sudo`, the admin
 * password's vault status offers saving (`canSave`), and saving it
 * creates the item and writes `secrets.refs.sudo` to the person's user.yml.
 * After a restart the server loads it from the vault, so nobody is asked
 * again. A distribution's own ref still wins.
 *
 * No real vault and no real sudo: recording fakes of `op` (items kept in a
 * temp dir) and `sudo` (one right password) come first on PATH. The test
 * password is a test value and is never printed; a failure says whether it
 * leaked, not what it is.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { spawnServer, stopServer } from "../../child-servers.js";
import { denAuth } from "./helpers/den-auth.js";

const ENGINE = path.resolve(__dirname, "../../..");
const PW = "lk4-test-admin-pw";
let tmp = "";

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** The fakes: `op` keeps items as files; `sudo` knows one password. */
function writeFakes(bin: string, items: string): void {
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(items, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "op"),
    `#!${process.execPath}
// Fake 1Password CLI: items are files under $FAKE_OP_ITEMS
// (<vault>.<title>.item marks one; <vault>.<title>.<field> holds a value).
// A write comes as the item's JSON on stdin (op item edit / create -).
const fs = require("fs");
const path = require("path");
const dir = process.env.FAKE_OP_ITEMS;
const a = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), a[0] + " " + (a[1] || "") + "\\n");
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(a) + "\\n");
if (a[0] === "whoami") { console.log("tester"); process.exit(0); }
const opt = (k) => { const i = a.indexOf(k); return i < 0 ? "" : a[i + 1]; };
const vault = opt("--vault");
const title = a[2] === "-" ? "" : a[2];
const base = (t) => path.join(dir, vault + "." + t);
const notItem = (t) => { process.stderr.write('"' + t + '" isn\\'t an item\\n'); process.exit(1); };
if (a[1] === "get") {
  if (!fs.existsSync(base(title) + ".item")) notItem(title);
  const fields = fs.readdirSync(dir)
    .filter((f) => f.startsWith(vault + "." + title + ".") && !f.endsWith(".item"))
    .map((f) => ({ label: f.slice((vault + "." + title + ".").length),
                   value: fs.readFileSync(path.join(dir, f), "utf8") }));
  const label = opt("--fields").replace(/^label=/, "");
  if (label) {
    const f = fields.find((x) => x.label === label);
    if (!f) notItem(title);
    console.log(f.value);
  } else console.log(JSON.stringify({ id: title, title, fields }));
} else if (a[1] === "edit" || a[1] === "create") {
  const it = JSON.parse(fs.readFileSync(0, "utf8"));
  const t = a[1] === "edit" ? title : it.title;
  if (a[1] === "edit" && !fs.existsSync(base(t) + ".item")) notItem(t);
  fs.writeFileSync(base(t) + ".item", "");
  for (const f of it.fields || [])
    fs.writeFileSync(base(t) + "." + (f.label || f.id), f.value || "");
} else process.exit(2);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "sudo"),
    `#!/bin/sh
# Fake sudo: never passwordless; -S takes one right password.
case "$*" in
  *-S*) read pw; [ "$pw" = "${PW}" ] && exit 0; exit 1 ;;
esac
exit 1
`,
    { mode: 0o755 },
  );
}

interface Dist {
  root: string;
  stateDir: string;
  items: string;
  env: NodeJS.ProcessEnv;
}

function makeDist(name: string, refs?: Record<string, unknown>): Dist {
  const base = path.join(tmp, name);
  const root = path.join(base, "dist");
  const stateDir = path.join(base, "home", ".den");
  const bin = path.join(base, "fake-bin");
  const items = path.join(base, "op-items");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    yaml.stringify({
      environments: ["local"],
      secrets: { provider: "1password", ...(refs ? { refs } : {}) },
    }),
  );
  writeFakes(bin, items);
  return {
    root,
    stateDir,
    items,
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
      // The pinned sudo (0.4.8) is this fake, never the system's.
      DEN_SYSTEM_SUDO: path.join(bin, "sudo"),
      FAKE_OP_ITEMS: items,
      DEN_ROOT: root,
      DEN_ENGINE_ROOT: ENGINE,
      DEN_HOME: stateDir,
      HOME: path.join(base, "home"),
      DEN_NO_OPEN: "1",
      NO_COLOR: "1",
    },
  };
}

interface Running {
  port: number;
  child: ChildProcess;
  log: () => string;
}

async function start(d: Dist): Promise<Running> {
  const port = await freePort();
  let log = "";
  const child = spawnServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: d.root,
      env: { ...d.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (b: Buffer) => (log += b.toString()));
  child.stderr?.on("data", (b: Buffer) => (log += b.toString()));
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await call(port, "GET", "/api/server-info")).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
  return { port, child, log: () => log };
}

function call(
  port: number,
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://localhost:${port}${p}`,
      {
        method,
        agent: false,
        headers: {
          connection: "close",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (buf += c));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(buf) as Record<string, unknown>;
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json, text: buf });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const userYml = (d: Dist) => {
  try {
    return yaml.parse(
      fs.readFileSync(path.join(d.root, "config", "local", "user.yml"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
};

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-lk4-")));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("LK-4: saving the admin password with no secrets.refs.sudo", () => {
  let d: Dist;
  let s: Running | null = null;
  beforeAll(async () => {
    d = makeDist("no-ref");
    s = await start(d);
  }, 60_000);
  afterAll(async () => {
    if (s) await stopServer(s.child);
  });

  it("the status offers saving (canSave) without a not-configured dead end", async () => {
    const st = (await call(s!.port, "GET", "/api/sudo-password/vault-status"))
      .json;
    expect(st).toMatchObject({
      backend: "1password",
      label: "1Password",
      configured: false,
      canSave: true,
      backendAvailable: true,
      hasStored: false,
    });
  });

  it("a wrong password saves nothing", async () => {
    const r = await call(
      s!.port,
      "POST",
      "/api/sudo-password",
      denAuth(d.stateDir),
      { password: "not-it", saveToVault: true },
    );
    expect(r.status).toBe(401);
    expect(userYml(d).secrets).toBeUndefined();
    expect(fs.readdirSync(d.items).filter((f) => f !== "calls.log")).toEqual(
      [],
    );
  });

  it("saving creates the item and writes secrets.refs.sudo to user.yml; then it is configured and stored", async () => {
    const r = await call(
      s!.port,
      "POST",
      "/api/sudo-password",
      denAuth(d.stateDir),
      { password: PW, saveToVault: true },
    );
    expect([
      r.status,
      r.json.ok,
      r.json.savedToVault,
      r.json.refCreated,
    ]).toEqual([200, true, true, true]);
    expect(r.json.vaultError).toBeUndefined();
    expect((userYml(d).secrets as Record<string, unknown>)?.refs).toEqual({
      sudo: { item: "Den admin password", field: "password" },
    });
    // The fake vault holds it: the item was created (edit failed first).
    expect(
      fs.readFileSync(
        path.join(d.items, ".Den admin password.password"),
        "utf8",
      ),
    ).toBe(PW);
    const calls = fs.readFileSync(path.join(d.items, "calls.log"), "utf8");
    expect(calls).toMatch(/item get\nitem create\n/);
    // 0.4.26: the password went on op's stdin, never in its argv.
    expect(
      fs.readFileSync(path.join(d.items, "argv.log"), "utf8"),
    ).not.toContain(PW);
    const st = (await call(s!.port, "GET", "/api/sudo-password/vault-status"))
      .json;
    expect(st).toMatchObject({
      configured: true,
      canSave: true,
      hasStored: true,
    });
  });

  it("after a restart the server loads it from the vault: nobody is asked again", async () => {
    await stopServer(s!.child);
    s = await start(d);
    const before = (await call(s.port, "GET", "/api/sudo-password/status"))
      .json;
    expect(before.set).toBe(false);
    const r = await call(
      s.port,
      "POST",
      "/api/sudo-password/load-from-vault",
      denAuth(d.stateDir),
    );
    expect(r.json).toEqual({ ok: true });
    expect(
      (await call(s.port, "GET", "/api/sudo-password/status")).json.set,
    ).toBe(true);
    // The password never reached the server's output.
    expect(s.log().includes(PW)).toBe(false);
  }, 60_000);
});

describe("LK-4: a distribution's own ref still wins", () => {
  let d: Dist;
  let s: Running | null = null;
  beforeAll(async () => {
    d = makeDist("dist-ref", {
      sudo: { vault: "Team", item: "Dist Keys", field: "ADMIN_PWD" },
    });
    // The person's ref from an earlier save, and the distribution's item.
    fs.writeFileSync(
      path.join(d.root, "config", "local", "user.yml"),
      yaml.stringify({
        secrets: {
          refs: { sudo: { item: "Den admin password", field: "password" } },
        },
      }),
    );
    fs.writeFileSync(path.join(d.items, "Team.Dist Keys.item"), "");
    s = await start(d);
  }, 60_000);
  afterAll(async () => {
    if (s) await stopServer(s.child);
  });

  it("saving writes the distribution's item and leaves user.yml as it was", async () => {
    const before = fs.readFileSync(
      path.join(d.root, "config", "local", "user.yml"),
      "utf8",
    );
    const r = await call(
      s!.port,
      "POST",
      "/api/sudo-password",
      denAuth(d.stateDir),
      { password: PW, saveToVault: true },
    );
    expect([r.status, r.json.savedToVault, r.json.refCreated]).toEqual([
      200,
      true,
      undefined,
    ]);
    expect(
      fs.readFileSync(path.join(d.items, "Team.Dist Keys.ADMIN_PWD"), "utf8"),
    ).toBe(PW);
    expect(
      fs.existsSync(path.join(d.items, ".Den admin password.password")),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(d.root, "config", "local", "user.yml"), "utf8"),
    ).toBe(before);
  });
});
