/**
 * The read-only previews write and load nothing:
 *   - `<cli> service install --plan` prints the plist, label, paths and whose
 *     server is on the port; it never writes ~/Library/LaunchAgents or calls
 *     launchctl, and exits 1 when the port is another distribution's.
 *   - `<cli> mcp connect <client> --dry-run` writes no client config and runs
 *     no client CLI, and refuses another distribution's server with exit 1.
 *
 * Real bin/den in throwaway distributions, with a temp HOME and shims for
 * launchctl, plutil and the agent CLIs that record every call.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let foreign: http.Server;
let foreignPort = 0;
let freePort = 0;
const OTHER_ROOT = "/srv/acme-other";
const SHIMMED = ["launchctl", "plutil", "claude", "codex", "cursor", "code"];

const shimDir = () => path.join(tmp, "shim");
const callLog = () => path.join(tmp, "calls.log");
const calls = (): string[] =>
  fs.existsSync(callLog())
    ? fs.readFileSync(callLog(), "utf-8").split("\n").filter(Boolean)
    : [];

function makeRoot(name: string, port: number): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    `environments: [local]\nweb:\n  port: ${port}\n  service:\n    label: local.acme.web\n`,
  );
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "den"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  return root;
}

/** Every file under `dir` with its size and mtime: a write shows up. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[`${p}/`] = "dir";
        walk(p);
      } else {
        const st = fs.statSync(p);
        out[p] = `${st.size}:${st.mtimeMs}`;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function den(
  root: string,
  home: string,
  args: string[],
): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(ENGINE, "bin", "den"), args, {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_HOME: path.join(root, "state"),
        HOME: home,
        // The shims first: a launchctl or agent CLI call is recorded, never
        // made for real.
        PATH: `${shimDir()}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ out, code }));
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-read-only-"));
  fs.mkdirSync(shimDir());
  for (const name of SHIMMED)
    fs.writeFileSync(
      path.join(shimDir(), name),
      `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(callLog())}\n`,
      { mode: 0o755 },
    );
  foreign = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        pid: 1,
        version: "0.2.6",
        root: OTHER_ROOT,
        product: "acme-ops",
      }),
    );
  });
  await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
  foreignPort = (foreign.address() as AddressInfo).port;
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  freePort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
});

afterAll(async () => {
  await new Promise<void>((r) => foreign.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("service install --plan", () => {
  it("a free port: prints the plan and the plist, exit 0, writes and loads nothing", async () => {
    const root = makeRoot("plan-free", freePort);
    const home = path.join(tmp, "home-free");
    fs.mkdirSync(home);
    const before = snapshot(home);
    const n = calls().length;
    const { out, code } = await den(root, home, [
      "service",
      "install",
      "--plan",
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/read-only: nothing is written or loaded/);
    expect(out).toMatch(/label: +local\.acme\.web/);
    expect(out).toContain(
      path.join(home, "Library", "LaunchAgents", "local.acme.web.plist"),
    );
    expect(out).toMatch(new RegExp(`port ${freePort}: free`));
    expect(out).toMatch(
      /<key>Label<\/key>\s*<string>local\.acme\.web<\/string>/,
    );
    expect(out).toContain(`<string>${root}</string>`);
    expect(calls().slice(n)).toEqual([]);
    expect(snapshot(home)).toEqual(before);
    expect(fs.existsSync(path.join(home, "Library", "LaunchAgents"))).toBe(
      false,
    );
  }, 60_000);

  it("a foreign server on the port: names it, exit 1, writes and loads nothing", async () => {
    const root = makeRoot("plan-foreign", foreignPort);
    const home = path.join(tmp, "home-foreign");
    fs.mkdirSync(home);
    const n = calls().length;
    const { out, code } = await den(root, home, [
      "service",
      "install",
      "--plan",
    ]);
    expect(out).toContain(
      `port ${foreignPort} is in use by acme-ops at ${OTHER_ROOT}; not this distribution's server`,
    );
    expect(code).toBe(1);
    expect(calls().slice(n)).toEqual([]);
    expect(snapshot(home)).toEqual({});
  }, 60_000);

  it("a typo'd flag refuses instead of installing", async () => {
    const root = makeRoot("plan-typo", freePort);
    const home = path.join(tmp, "home-typo");
    fs.mkdirSync(home);
    const n = calls().length;
    const { out, code } = await den(root, home, [
      "service",
      "install",
      "--paln",
    ]);
    expect(out).toMatch(/unknown argument --paln/);
    expect(code).toBe(1);
    expect(calls().slice(n)).toEqual([]);
    expect(snapshot(home)).toEqual({});
  }, 60_000);

  it("status names a foreign server on the port", async () => {
    const root = makeRoot("status-foreign", foreignPort);
    const home = path.join(tmp, "home-status");
    fs.mkdirSync(home);
    const { out } = await den(root, home, ["service", "status"]);
    expect(out).toContain(
      `port ${foreignPort} is in use by acme-ops at ${OTHER_ROOT}; not this distribution's server`,
    );
  }, 60_000);
});

describe("mcp connect --dry-run", () => {
  /** A HOME with each JSON-configured client's settings present. */
  function homeWithClients(name: string): string {
    const home = path.join(tmp, name);
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), "{}\n");
    return home;
  }

  it("writes no client config and runs no client CLI", async () => {
    const root = makeRoot("mcp-dry", freePort);
    const home = homeWithClients("home-mcp-dry");
    const before = snapshot(home);
    const n = calls().length;
    const { out, code } = await den(root, home, [
      "mcp",
      "connect",
      "claude-code",
      "codex",
      "cursor",
      "--dry-run",
      "--port",
      String(freePort),
    ]);
    expect(out).toMatch(/would (run|write)/);
    expect(out).not.toMatch(/\bwrote\b/);
    expect(code).toBe(0);
    expect(calls().slice(n)).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  }, 60_000);

  it("refuses another distribution's server with exit 1, writing nothing", async () => {
    const root = makeRoot("mcp-foreign", foreignPort);
    const home = homeWithClients("home-mcp-foreign");
    const before = snapshot(home);
    const n = calls().length;
    const { out, code } = await den(root, home, [
      "mcp",
      "connect",
      "claude-code",
      "cursor",
      "--dry-run",
      "--port",
      String(foreignPort),
    ]);
    expect(out).toContain(
      `port ${foreignPort} is in use by acme-ops at ${OTHER_ROOT}`,
    );
    expect(code).toBe(1);
    expect(calls().slice(n)).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  }, 60_000);
});
