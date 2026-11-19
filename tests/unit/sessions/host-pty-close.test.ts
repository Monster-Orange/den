/**
 * Issue 503, in process with a scripted PTY: an exited session's master is
 * closed after sessions.pty_close_seconds (0 by default), its record and
 * scrollback kept; a PTY that cannot open is a refusal with the reason, in
 * the host's log too; the host says how many PTY masters it holds.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  connectHost,
  HostError,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import {
  SessionHost,
  type SessionHostOptions,
} from "../../../src/shared/sessions/host.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { scriptedFactory, type ScriptedPty } from "./helpers/fake-pty.js";

const tmps: string[] = [];
const hosts: SessionHost[] = [];
const clients: HostClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of hosts.splice(0)) await h.close();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

async function rig(
  o: Partial<SessionHostOptions> = {},
): Promise<{ c: HostClient; made: ScriptedPty[]; logs: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-503-"));
  tmps.push(dir);
  const { factory, made } = scriptedFactory();
  const logs: string[] = [];
  const h = new SessionHost({
    stateDir: dir,
    pty: () => ({ available: true, factory }),
    launchdSession: null,
    flushMs: 0,
    log: (l) => logs.push(l),
    ...o,
  });
  hosts.push(h);
  expect(await h.listen()).toBe("listening");
  const c = await connectHost(sessionPaths(dir).socket);
  clients.push(c);
  return { c, made, logs };
}

const spec = (name: string) => ({
  name,
  cwd: os.tmpdir(),
  argv: ["/bin/sh", "-c", "exit"],
  env: { PATH: "/usr/bin:/bin" },
  cols: 80,
  rows: 24,
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("issue 503: an exited session closes its PTY master", () => {
  it("closes it as soon as the process exits (default 0 s), keeps it listed and its scrollback", async () => {
    const { c, made } = await rig();
    const info = await c.start(spec("acme-north:shell"));
    made[0].emit("bye\r\n");
    made[0].exit(0);
    await tick(150);
    expect(made[0].closed).toBe(1);
    const [listed] = await c.list();
    expect(listed).toMatchObject({ ref: info.ref, exited: true, exitCode: 0 });
    expect((await c.scrollback(info.ref.id, 1 << 20)).toString()).toBe(
      "bye\r\n",
    );
    // An attach to the exited session still replays it.
    let replay = "";
    const att = c.attach(info.ref.id, {
      onData: (d) => (replay += d.toString()),
    });
    await att.ready;
    expect(replay).toBe("bye\r\n");
  });

  it("waits the close delay when one is set", async () => {
    const { c, made } = await rig({ ptyCloseMs: 400 });
    await c.start(spec("acme-north:shell"));
    made[0].exit(0);
    await tick(200);
    expect(made[0].closed).toBe(0);
    await tick(500);
    expect(made[0].closed).toBe(1);
  });

  it("a running session's PTY is never closed", async () => {
    const { c, made } = await rig();
    await c.start(spec("acme-north:shell"));
    await tick(150);
    expect(made[0].closed).toBe(0);
  });
});

describe("issue 503: a PTY that cannot open", () => {
  it("is a refusal with the reason, and the host logs it", async () => {
    const { c, logs } = await rig({
      pty: () => ({
        available: true,
        factory: () => {
          throw new Error("posix_openpt failed: no PTY left");
        },
      }),
    });
    const err = await c.start(spec("acme-north:shell")).catch((e) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).code).toBe("spawn");
    expect((err as HostError).message).toMatch(
      /posix_openpt failed: no PTY left/,
    );
    expect(
      logs.some(
        (l) =>
          /acme-north:shell/.test(l) &&
          /could not open a PTY/.test(l) &&
          /posix_openpt failed: no PTY left/.test(l),
      ),
    ).toBe(true);
    expect(await c.list()).toEqual([]);
  });
});

describe("issue 503: the host's open PTY count", () => {
  it("answers how many PTY masters it holds", async () => {
    const { c } = await rig({ openPtys: () => 7 });
    expect(await c.ptys()).toEqual({ open: 7 });
  });

  it("null when it cannot count them here", async () => {
    const { c } = await rig({ openPtys: () => null });
    expect(await c.ptys()).toEqual({ open: null });
  });
});
