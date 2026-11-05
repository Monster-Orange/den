/**
 * `<cli> web up|down|restart` never act on another distribution's server.
 *
 * Several distributions can run a Den web server on one machine. One with
 * its port set to where another distribution's server already ran got
 * "OK ... web is already running" and stopped; `web down` would have
 * SIGTERMed the other server, which looks like ours by its command line
 * when both use the same linked engine.
 *
 * Real bin/den in a throwaway distribution, against a stand-in server: a
 * child node process run from ANOTHER distribution's directory whose
 * command line names this engine's server entry point (as a linked
 * engine's server does), answering /api/health and the UI page the way
 * Den does, and /api/server-info with a root that is not ours.
 */
import { afterAll, afterEach, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startSlowGitServer } from "../server/helpers/slow-git-server.js";

const ENGINE = path.resolve(__dirname, "../../..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "den-web-foreign-"));

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A distribution at tmpBase/<name>. */
function makeRoot(name: string): string {
  const root = path.join(tmpBase, name);
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  return root;
}

const FAKE = path.join(tmpBase, "fake-server.cjs");
write(
  FAKE,
  `const http = require("http");
const info = JSON.parse(process.env.FAKE_INFO);
const s = http.createServer((req, res) => {
  if (req.url === "/api/server-info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ pid: process.pid, ...info }));
  }
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end("[]");
  }
  if (req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end('<html><head><meta name="den-ui" content="1"></head></html>');
  }
  res.writeHead(404);
  res.end();
});
s.listen(0, "127.0.0.1", () => console.log("PORT " + s.address().port));
`,
);

interface Fake {
  child: ChildProcess;
  port: number;
}
const fakes: Fake[] = [];

/** Start the stand-in, run from `cwd`, answering server-info with `info`. */
async function startFake(cwd: string, info: object): Promise<Fake> {
  const child = spawn(
    process.execPath,
    // The extra argument puts this engine's server entry point on the
    // command line, as a server run from a linked engine has it.
    [FAKE, path.join(ENGINE, "src/ui/server/index.ts")],
    {
      cwd,
      env: { ...process.env, FAKE_INFO: JSON.stringify(info) },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /PORT (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (c) => reject(new Error(`fake server exited ${c}`)));
  });
  const fake = { child, port };
  fakes.push(fake);
  return fake;
}

function alive(f: Fake): boolean {
  return f.child.exitCode === null && f.child.signalCode === null;
}

/** `bin/den web <args>` in `root`, no TTY; output with colour off. */
function den(
  root: string,
  args: string[],
): { out: string; status: number | null } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), ["web", ...args], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(root, "home"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 90_000,
  });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

afterEach(() => {
  for (const f of fakes.splice(0)) if (alive(f)) f.child.kill("SIGKILL");
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const OTHER = makeRoot("other-dist");

describe("web up/down/restart against another distribution's server", () => {
  it("up refuses a server that serves another root: exit 1, never OK", async () => {
    const root = makeRoot("ours-up");
    const fake = await startFake(OTHER, {
      version: "0.2.3",
      root: OTHER,
      product: "acme-ops",
    });
    const { out, status } = den(root, [
      "up",
      "--no-open",
      "--port",
      `${fake.port}`,
    ]);
    expect(out).toContain(
      `port ${fake.port} is in use by acme-ops at ${OTHER}`,
    );
    expect(out).toMatch(/pick another port/);
    expect(out).not.toMatch(/already running/);
    expect(out).not.toMatch(/\bOK\b/);
    expect(status).toBe(1);
    expect(alive(fake)).toBe(true);
  }, 120_000);

  it("up refuses an older server with no root: 'another server (Den <version>)'", async () => {
    const root = makeRoot("ours-legacy");
    const fake = await startFake(OTHER, { version: "0.2.3" });
    const { out, status } = den(root, [
      "up",
      "--no-open",
      "--port",
      `${fake.port}`,
    ]);
    expect(out).toContain(
      `port ${fake.port} is in use by another server (Den 0.2.3)`,
    );
    expect(out).not.toMatch(/already running/);
    expect(status).toBe(1);
  }, 120_000);

  it("down never signals another distribution's server", async () => {
    const root = makeRoot("ours-down");
    const fake = await startFake(OTHER, {
      version: "0.2.3",
      root: OTHER,
      product: "acme-ops",
    });
    const { out, status } = den(root, ["down", "--port", `${fake.port}`]);
    // Give a SIGTERM, had one been sent, time to land.
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(fake)).toBe(true);
    expect(out).toContain(
      `port ${fake.port} is in use by acme-ops at ${OTHER}`,
    );
    expect(out).not.toMatch(/\bOK\b/);
    expect(status).toBe(1);
  }, 120_000);

  it("restart refuses too, leaving the other server running", async () => {
    const root = makeRoot("ours-restart");
    const fake = await startFake(OTHER, { version: "0.2.3" });
    const { out, status } = den(root, [
      "restart",
      "--no-open",
      "--port",
      `${fake.port}`,
    ]);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(fake)).toBe(true);
    expect(out).toContain(`is in use by another server (Den 0.2.3)`);
    expect(status).toBe(1);
  }, 120_000);

  it("a server that reports OUR root is still 'already running'", async () => {
    const root = makeRoot("ours-same");
    const fake = await startFake(root, {
      version: "0.2.6",
      root,
      product: "den",
    });
    const { out, status } = den(root, [
      "up",
      "--no-open",
      "--port",
      `${fake.port}`,
    ]);
    expect(out).toMatch(/OK Den web is already running at http:\/\//);
    expect(status).toBe(0);
  }, 120_000);

  it("an older server with no root, run from OUR root, is still ours", async () => {
    const root = makeRoot("ours-legacy-same");
    const fake = await startFake(root, { version: "0.2.5" });
    const { out, status } = den(root, [
      "up",
      "--no-open",
      "--port",
      `${fake.port}`,
    ]);
    expect(out).toMatch(/OK Den web is already running at http:\/\//);
    expect(status).toBe(0);
  }, 120_000);
});

describe("the real server names its root and product", () => {
  it("server-info reports them; web up from that root is 'already running', from another it refuses", async () => {
    const root = makeRoot("real");
    const tmp = path.join(tmpBase, "real-tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
    try {
      const info = JSON.parse((await srv.timed("/api/server-info")).body) as {
        root?: string;
        product?: string;
      };
      expect(info.root).toBe(root);
      expect(info.product).toBe("den");

      const same = den(root, ["up", "--no-open", "--port", `${srv.port}`]);
      expect(same.out).toMatch(/already running/);
      expect(same.status).toBe(0);

      const other = makeRoot("real-other");
      const foreign = den(other, ["up", "--no-open", "--port", `${srv.port}`]);
      expect(foreign.out).toContain(
        `port ${srv.port} is in use by den at ${root}`,
      );
      expect(foreign.status).toBe(1);
    } finally {
      await srv.stop();
    }
  }, 120_000);
});
