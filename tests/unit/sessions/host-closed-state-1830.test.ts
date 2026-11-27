import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../src/shared/sessions/host.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { scriptedFactory, type ScriptedPty } from "./helpers/fake-pty.js";
import { tempDirs } from "../../temp-dirs.js";

const tmp = tempDirs();
const clients: HostClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function closedWithOne(): Promise<{
  dir: string;
  pty: ScriptedPty;
}> {
  const dir = tmp("den-host-1830-");
  const { factory, made } = scriptedFactory();
  const h = new SessionHost({
    stateDir: dir,
    pty: () => ({ available: true, factory }),
    flushMs: 0,
    log: () => undefined,
  });
  expect(await h.listen()).toBe("listening");
  const c = await connectHost(sessionPaths(dir).socket);
  clients.push(c);
  await c.start({
    name: "north:a",
    cwd: os.tmpdir(),
    argv: ["sh"],
    env: { PATH: "/usr/bin:/bin" },
    cols: 80,
    rows: 24,
  });
  await h.close();
  return { dir, pty: made[0] };
}

describe("a closed session host and its state folder", () => {
  it("a session that ends after the host closed never brings back a state folder that was removed", async () => {
    const { dir, pty } = await closedWithOne();
    fs.rmSync(dir, { recursive: true, force: true });
    pty.exit(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("while the folder is still there, that session's end is still recorded", async () => {
    const { dir, pty } = await closedWithOne();
    pty.exit(0);
    await new Promise((r) => setTimeout(r, 300));
    const recs = fs
      .readdirSync(sessionPaths(dir).dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) =>
        JSON.parse(
          fs.readFileSync(path.join(sessionPaths(dir).dir, f), "utf-8"),
        ),
      );
    expect(recs.map((r) => r.exited)).toEqual([true]);
  });
});
