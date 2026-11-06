/**
 * den-pty end to end with the real native module (AG-3a): bin/den starts
 * `sh -c 'echo hi; sleep 5'` in a throwaway distribution, which starts a
 * session host on demand in a temp state dir; `sessions attach` shows "hi"
 * and detaches on ctrl-]; `sessions kill` ends it; `sessions host --stop`
 * stops the host.
 *
 * Runs only when the PTY module loads here (it is an optionalDependency);
 * otherwise the suite is skipped.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { recordProcessGroup } from "../../../src/shared/process/process-group.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { ENGINE, makeDist, type Dist } from "./helpers/dist.js";

const pty = loadPty();
const maybe = pty.available ? describe : describe.skip;

let dist: Dist;
let hostPid = 0;

beforeAll(() => {
  if (pty.available) dist = makeDist("den-pty-it-");
});

afterAll(async () => {
  if (!dist) return;
  try {
    const c = await connectHost(sessionPaths(dist.home).socket);
    hostPid = c.hostPid;
    await c.shutdown();
    c.close();
  } catch {
    /* not running */
  }
  if (hostPid) {
    try {
      process.kill(hostPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  fs.rmSync(dist.tmp, { recursive: true, force: true });
}, 20_000);

maybe("den-pty with the native module", () => {
  it("starts, attaches (sees hi), detaches, kills, and stops the host", async () => {
    const started = dist.den([
      "sessions",
      "start",
      "-w",
      "north",
      "--name",
      "hi",
      "--",
      "sh",
      "-c",
      "echo hi; sleep 120",
    ]);
    expect(started.out).toMatch(/started acme-north:hi/);
    expect(started.code).toBe(0);
    const sock = sessionPaths(dist.home).socket;
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);

    const c = await connectHost(sock);
    hostPid = c.hostPid;
    // The host is no child of the CLI that started it: it leads its own
    // process group, so a web server's or terminal's group signal misses it.
    expect(hostPid).not.toBe(process.pid);
    expect(recordProcessGroup(hostPid)).toMatchObject({ pgid: hostPid });
    c.close();

    const attach = spawn(
      path.join(ENGINE, "bin", "den"),
      ["sessions", "attach", "hi"],
      {
        cwd: dist.root,
        env: dist.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    attach.stdout.on("data", (d: Buffer) => (out += d.toString()));
    attach.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const end = Date.now() + 20_000;
    while (!/hi\r?\n/.test(out) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatch(/hi\r?\n/);
    attach.stdin.write(Buffer.from([0x1d])); // ctrl-]
    const code = await new Promise<number | null>((r) =>
      attach.once("exit", r),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/detached/);

    const listed = dist.den(["sessions", "list", "-w", "north", "--json"]);
    expect(JSON.parse(listed.out)).toEqual([
      expect.objectContaining({ name: "acme-north:hi" }),
    ]);
    expect(JSON.parse(listed.out)[0].exited).toBeFalsy();

    expect(dist.den(["sessions", "kill", "hi"]).code).toBe(0);
    const until = Date.now() + 5_000;
    let after = JSON.parse(dist.den(["sessions", "list", "--json"]).out);
    while (!after[0]?.exited && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      after = JSON.parse(dist.den(["sessions", "list", "--json"]).out);
    }
    expect(after[0]).toMatchObject({ name: "acme-north:hi", exited: true });

    expect(dist.den(["sessions", "host", "--stop"]).code).toBe(0);
    expect(fs.existsSync(sock)).toBe(false);
  }, 90_000);
});
