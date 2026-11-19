/**
 * Issue 455, after 0.4.68 (a live check against the approved mock v3): no
 * address is shown before it is checked. Each case runs the real bin/den in
 * a throwaway distribution, and `den web up` starts the real server there.
 * A stand-in on a free port plays port 80 (edge.http_port points at it, and
 * web.url is the edge address on it, as the migration takes it from the
 * edge route). Real port 80 is never bound. `docker`, `lsof` and the vendor
 * CLIs are shims: nothing real runs underneath.
 *
 * - doctor's Address row gives the checked address (Den's own port), and
 *   says the edge address isn't checked yet. It never gives the unchecked
 *   one as the address.
 * - The server's start line in web.log ("Web UI → …") does the same.
 * - doctor names a container the way the Edge card does ("Docker container").
 * - `den web up` says why, once, and returns. That holds when another
 *   server answers, and when something holds the port and never answers.
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
// The browser's origin Den gives: the address that was checked.
// eslint-disable-next-line no-restricted-syntax -- the address under test
const LOCAL = "http://localhost";

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

type Stand = "other" | "silent" | "none";

interface Install {
  tmp: string;
  root: string;
  env: NodeJS.ProcessEnv;
  webPort: number;
  edgePort: number;
  wanted: string;
  close: () => Promise<void>;
  pids: number[];
}

/** A distribution whose edge port is held by `stand`. */
async function install(stand: Stand): Promise<Install> {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `den-455-${stand}-`)),
  );
  const root = path.join(tmp, "den");
  const shim = path.join(tmp, "shim");
  const edgePort = await freePort();
  const webPort = await freePort();
  let server: net.Server | null = null;
  // The silent stand-in's open sockets: close() waits for them otherwise.
  const held = new Set<net.Socket>();
  if (stand === "other") {
    // Another server: answers every request, as nginx, with a 404.
    server = http.createServer((_q, s) => {
      s.writeHead(404, { Server: "nginx/1.27.3" });
      s.end("not found");
    });
  } else if (stand === "silent") {
    // Holds the port and never answers (a proxy with no route for it).
    server = net.createServer((sock) => held.add(sock));
  }
  // On the wildcard, the way Docker publishes a port.
  if (server) await new Promise<void>((r) => server.listen(edgePort, r));
  const wanted = `http://den.acme.localhost:${edgePort}`;
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      `  http_port: ${edgePort}`,
      "  tls: none",
      `  state_dir: ${path.join(tmp, "edge")}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "user.yml"),
    [
      "web:",
      `  port: ${webPort}`,
      `  url: ${wanted}`,
      "  url_confirmed: false",
      "  url_from: the edge route",
      // The probe's limits are Settings: short here, so a silent port
      // costs a second, not fifteen.
      "  address_check_timeout_seconds: 1",
      "  address_check_retries: 0",
      "",
    ].join("\n"),
  );
  // `docker ps --filter publish=<port>` names the stand-in as a container;
  // every other docker call (the edge's own container) finds nothing.
  write(
    path.join(shim, "docker"),
    stand === "other"
      ? `#!/bin/sh\nif [ "$1" = ps ]; then printf 'web-proxy-1\\tnginx:1.27.3\\t<no value>\\n'; exit 0; fi\nexit 1\n`
      : "#!/bin/sh\nexit 1\n",
    0o755,
  );
  for (const tool of ["lsof", "gh", "op", "sudo", "launchctl", "security"])
    write(path.join(shim, tool), "#!/bin/sh\nexit 1\n", 0o755);
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(tmp, "home"),
    PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    TMPDIR: os.tmpdir(),
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_HOME: path.join(tmp, "home", ".den"),
    DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
    DEN_EDGE_DIR: path.join(tmp, "edge-state"),
    DEN_NO_OPEN: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    CI: "1",
  };
  return {
    tmp,
    root,
    env,
    webPort,
    edgePort,
    wanted,
    pids: [],
    close: () =>
      new Promise<void>((r) => {
        for (const sock of held) sock.destroy();
        if (server) server.close(() => r());
        else r();
      }),
  };
}

/**
 * The real CLI, without blocking this process: the stand-in answers from
 * here, and a blocked event loop would make it a port that never answers.
 */
function den(
  i: Install,
  args: string[],
): Promise<{ code: number | null; out: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const c = spawn(path.join(ENGINE, "bin", "den"), args, {
      cwd: i.root,
      env: i.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const kill = setTimeout(() => c.kill("SIGKILL"), 120_000);
    c.on("close", (code) => {
      clearTimeout(kill);
      const pid = /web started \(pid (\d+)\)/.exec(out)?.[1];
      if (pid) i.pids.push(Number(pid));
      resolve({ code, out, ms: Date.now() - t0 });
    });
  });
}

async function stop(i: Install | undefined): Promise<void> {
  if (!i) return;
  await den(i, ["web", "down"]);
  for (const pid of i.pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* stopped */
    }
  await i.close();
  fs.rmSync(i.tmp, { recursive: true, force: true });
}

const webLog = (i: Install) =>
  fs.readFileSync(
    path.join(i.env.DEN_HOME as string, "logs", "den", "web.log"),
    "utf-8",
  );

/** doctor's Address section: from its heading to the next blank line. */
function addressSection(out: string): string {
  const at = out.indexOf("doctor: Address");
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = out.slice(at);
  const end = rest.indexOf("\n\n", rest.indexOf("\n\n") + 2);
  return end > 0 ? rest.slice(0, end) : rest;
}

/** The start line's address, the last time the server started. */
async function startLine(i: Install): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const log = webLog(i);
    const last = log.slice(log.lastIndexOf("web start"));
    const line = last.split("\n").find((l) => /Web UI\s+→/.test(l));
    // The rest of the start: the line after it, when there is one.
    if (line && /Web UI\s+→[^\n]*\n[^\n]*\S/.test(last))
      return last.slice(last.indexOf(line));
    if (Date.now() > deadline) return line ?? "";
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("another server answers at the edge address (it holds the port)", () => {
  let i: Install;
  let up: Awaited<ReturnType<typeof den>>;
  beforeAll(async () => {
    i = await install("other");
    up = await den(i, ["web", "up", "--no-open"]);
  }, 150_000);
  afterAll(() => stop(i), 150_000);

  it("web up starts, says what holds the port once, and returns", () => {
    expect(up.code).toBe(0);
    expect(up.out).toMatch(/OK Den web started/);
    const held = up.out.match(/is held by nginx/g) ?? [];
    expect(held).toHaveLength(1);
    expect(up.out).toContain(
      `Den is at ${LOCAL}:${i.webPort} until port ${i.edgePort} is free.`,
    );
    expect(up.out).not.toContain(`Visit: ${i.wanted}`);
  });

  it("doctor's Address row gives the checked address, and says the edge one isn't checked yet", async () => {
    const d = await den(i, ["doctor"]);
    const sec = addressSection(d.out);
    const row = sec.split("\n").find((l) => /^\s+address\s/.test(l)) ?? "";
    expect(row).toContain(`${LOCAL}:${i.webPort}`);
    expect(row).not.toMatch(new RegExp(`address\\s+\\S+\\s+${i.wanted}`));
    expect(sec).not.toMatch(/confirm it with/);
    expect(sec).toContain(`The edge address ${i.wanted} isn't checked yet`);
  }, 90_000);

  it("doctor --json's address check is the checked address", async () => {
    const d = await den(i, ["doctor", "--json"]);
    const checks = (
      JSON.parse(d.out.slice(d.out.indexOf("{"))) as {
        checks: { id: string; detail: string; url?: string }[];
      }
    ).checks;
    const a = checks.find((c) => c.id === "address");
    expect(a?.url).toBe(`${LOCAL}:${i.webPort}`);
    expect(a?.detail.startsWith(`${LOCAL}:${i.webPort}`)).toBe(true);
  }, 90_000);

  it('doctor names the container as the Edge card does: "Docker container"', async () => {
    const d = await den(i, ["doctor"]);
    expect(d.out).toContain(
      `Port ${i.edgePort} is held by nginx (Docker container web-proxy-1).`,
    );
  }, 90_000);

  it("web.log's start line logs the checked address, and names the edge one as not checked yet", async () => {
    const at = await startLine(i);
    expect(at).toMatch(
      new RegExp(`Web UI\\s+→\\s+${LOCAL}:${i.webPort}\\s*\\n`),
    );
    expect(at).toContain(`The edge address ${i.wanted} isn't checked yet`);
    expect(webLog(i)).not.toMatch(
      new RegExp(`Web UI\\s+→\\s+${i.wanted.replace(/\./g, "\\.")}`),
    );
  }, 60_000);
});

describe("something holds the edge port and never answers", () => {
  let i: Install;
  beforeAll(async () => {
    i = await install("silent");
  }, 30_000);
  afterAll(() => stop(i), 150_000);

  it("web up says it isn't reachable yet, once, and returns", async () => {
    const up = await den(i, ["web", "up", "--no-open"]);
    expect(up.code).toBe(0);
    expect(up.out).toMatch(/OK Den web started/);
    const lines = up.out.match(/Not reachable yet: [^\n]*/g) ?? [];
    expect(lines).toEqual([
      `Not reachable yet: nothing answers at ${i.wanted}.`,
    ]);
    // It returns within the probe's limits (1 s, no retry, two targets).
    expect(up.ms).toBeLessThan(60_000);
  }, 150_000);

  it("doctor's Address row gives the checked address", async () => {
    const sec = addressSection((await den(i, ["doctor"])).out);
    const row = sec.split("\n").find((l) => /^\s+address\s/.test(l)) ?? "";
    expect(row).toContain(`${LOCAL}:${i.webPort}`);
    expect(sec).toContain(`The edge address ${i.wanted} isn't checked yet`);
  }, 90_000);
});

describe("nothing listens at the edge address", () => {
  let i: Install;
  beforeAll(async () => {
    i = await install("none");
  }, 30_000);
  afterAll(() => stop(i), 150_000);

  it("web up says it isn't reachable yet, once; doctor and web.log give the checked address", async () => {
    const up = await den(i, ["web", "up", "--no-open"]);
    expect(up.code).toBe(0);
    expect(up.out.match(/Not reachable yet: [^\n]*/g) ?? []).toHaveLength(1);
    const sec = addressSection((await den(i, ["doctor"])).out);
    const row = sec.split("\n").find((l) => /^\s+address\s/.test(l)) ?? "";
    expect(row).toContain(`${LOCAL}:${i.webPort}`);
    expect(sec).toContain(`The edge address ${i.wanted} isn't checked yet`);
    expect(await startLine(i)).toMatch(
      new RegExp(`Web UI\\s+→\\s+${LOCAL}:${i.webPort}\\s*\\n`),
    );
  }, 150_000);
});
