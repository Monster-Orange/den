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

const tmps: string[] = [];
const hosts: SessionHost[] = [];
const clients: HostClient[] = [];

async function setup(): Promise<{ c: HostClient; made: ScriptedPty[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-host-1634-"));
  tmps.push(dir);
  const { factory, made } = scriptedFactory();
  const h = new SessionHost({
    stateDir: dir,
    pty: () => ({ available: true, factory }),
    flushMs: 0,
    log: () => undefined,
  });
  hosts.push(h);
  expect(await h.listen()).toBe("listening");
  const c = await connectHost(sessionPaths(dir).socket);
  clients.push(c);
  return { c, made };
}

const spec = (name: string) => ({
  name,
  cwd: os.tmpdir(),
  argv: ["sh", "-c", "true"],
  env: { PATH: "/usr/bin:/bin" },
  cols: 80,
  rows: 24,
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of hosts.splice(0)) await h.close();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("issue 1634: a project's cap on its running agents", () => {
  const agents = (project: string, projectLimit?: number) => ({
    limit: 10,
    pool: "agents" as const,
    project,
    ...(projectLimit !== undefined ? { projectLimit } : {}),
  });

  it("a project at its cap is refused while another project starts one", async () => {
    const { c } = await setup();
    await c.start(spec("north:a"), agents("north", 2));
    await c.start(spec("north:b"), agents("north", 2));
    const refused = c.start(spec("north:c"), agents("north", 2));
    await expect(refused).rejects.toMatchObject({ code: "cap" });
    await expect(refused).rejects.toThrow(
      /^2 agents are running in project north and its cap is 2 \(agents\.max_per_project\)$/,
    );
    await expect(
      c.start(spec("south:a"), agents("south", 2)),
    ).resolves.toMatchObject({ name: "south:a" });
  });

  it("an agent that exits frees its project's place", async () => {
    const { c, made } = await setup();
    await c.start(spec("north:a"), agents("north", 1));
    await expect(
      c.start(spec("north:b"), agents("north", 1)),
    ).rejects.toMatchObject({ code: "cap" });
    made[0].exit(0);
    await expect(
      (async () => {
        for (let i = 0; i < 100; i++) {
          try {
            return await c.start(spec("north:b"), agents("north", 1));
          } catch (e) {
            if ((e as { code?: string }).code !== "cap") throw e;
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        throw new Error("still at its cap");
      })(),
    ).resolves.toMatchObject({ name: "north:b" });
  });

  it("no project limit: only the machine cap applies", async () => {
    const { c } = await setup();
    for (const n of ["a", "b", "c"])
      await c.start(spec(`north:${n}`), { ...agents("north"), limit: 3 });
    await expect(
      c.start(spec("north:d"), { ...agents("north"), limit: 3 }),
    ).rejects.toThrow(/^3 agents are running and agents\.max_concurrent is 3$/);
  });

  it("plain sessions never count against a project's cap", async () => {
    const { c } = await setup();
    await c.start(spec("north:sh"), { limit: 10, pool: "sessions" });
    await expect(
      c.start(spec("north:a"), agents("north", 1)),
    ).resolves.toMatchObject({ name: "north:a" });
  });

  it("a bad project limit is refused by its name", async () => {
    const { c } = await setup();
    for (const projectLimit of [-1, 1.5, "2"])
      await expect(
        c.start(spec("north:a"), {
          ...agents("north"),
          projectLimit: projectLimit as number,
        }),
      ).rejects.toMatchObject({ code: "bad-request" });
    await expect(
      c.start(spec("north:a"), {
        ...agents("north"),
        projectLimit: -1,
      }),
    ).rejects.toThrow(/projectLimit/);
  });
});
