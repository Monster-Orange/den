/**
 * 0.4.46 services.restore_on_boot, on the real web server: Den starts with
 * a record (daemons.json) of a service that was up and whose process is
 * gone, as after the machine restarted. It runs that service's Up by
 * itself. A service a person stopped is not on the record, so it stays
 * down; with the setting off nothing runs.
 *
 * The demo distribution (helpers/agents-page-server.ts); each `up` only
 * touches a file. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await s?.stop();
  s = null;
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A Den whose last run left notes (north) up; blog was stopped. */
async function bootAfterRestart(userYml?: string) {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-rob-")),
  );
  dirs.push(tmp);
  const marks = {
    notes: path.join(tmp, "notes-up"),
    blog: path.join(tmp, "blog-up"),
  };
  fs.writeFileSync(
    path.join(tmp, "daemons.json"),
    JSON.stringify({
      denPid: 999_992,
      daemons: [
        {
          address: "notes",
          repoName: "notes",
          subsystem: "notes",
          repoPath: path.join(tmp, "repos", "notes"),
          logPath: path.join(tmp, "notes.log"),
          startedAt: "2026-11-13T08:00:00.000Z",
          workspaces: ["north"],
          // The process group from before the restart: gone now.
          pgid: 999_991,
          pgidStartedAt: "Thu Nov 13 08:00:00 2026",
        },
      ],
    }),
  );
  s = await startAgentsPageServer({
    root: tmp,
    up: { notes: `touch ${marks.notes}`, blog: `touch ${marks.blog}` },
    ...(userYml === undefined ? {} : { userYml }),
  });
  return marks;
}

async function waitFor(file: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fs.existsSync(file);
}

describe("0.4.46: services.restore_on_boot on the real server", () => {
  it("what was up comes back by itself; what a person stopped stays down", async () => {
    const marks = await bootAfterRestart();
    expect(await waitFor(marks.notes, 20_000)).toBe(true);
    expect(fs.existsSync(marks.blog)).toBe(false);
    const until = Date.now() + 10_000;
    while (
      !s!.log().includes("Restored after the restart") &&
      Date.now() < until
    )
      await new Promise((r) => setTimeout(r, 100));
    expect(s!.log()).toContain("Restored after the restart: north: notes");
  }, 60_000);

  it("services.restore_on_boot: false: nothing comes back", async () => {
    const marks = await bootAfterRestart(
      "services:\n  restore_on_boot: false\n",
    );
    expect(await waitFor(marks.notes, 4_000)).toBe(false);
  }, 60_000);
});
