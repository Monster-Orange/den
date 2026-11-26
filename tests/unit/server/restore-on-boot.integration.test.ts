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

/** A record of a service `up` started, in `ws`, from before the restart. */
function was(tmp: string, address: string, ws: string, pgid: number) {
  return {
    address,
    repoName: address,
    subsystem: address,
    repoPath: path.join(tmp, "repos", address),
    logPath: path.join(tmp, `${address}.log`),
    startedAt: "2026-11-13T08:00:00.000Z",
    workspaces: [ws],
    // The process group from before the restart: gone now.
    pgid,
    pgidStartedAt: "Thu Nov 13 08:00:00 2026",
  };
}

/**
 * A Den whose last run left notes (north) up, and with `both`, blog (south)
 * too; otherwise a person stopped blog, so it's off the record. Each
 * service keeps running once up, as a real one does (issue 1225 checks that
 * it stays up), unless `blogFails`. The queue's gap, which is also the
 * settle time: 1 s. No wait for a container runtime: this test's HOME has
 * no runtime context.
 */
async function bootAfterRestart(
  o: { userYml?: string; both?: boolean; blogFails?: boolean } = {},
) {
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
        was(tmp, "notes", "north", 999_991),
        ...(o.both ? [was(tmp, "blog", "south", 999_990)] : []),
      ],
    }),
  );
  const stay = (mark: string) => `touch ${mark} && exec sleep 30`;
  s = await startAgentsPageServer({
    root: tmp,
    up: {
      notes: stay(marks.notes),
      blog: o.blogFails ? "exit 3" : stay(marks.blog),
    },
    userYml:
      o.userYml ??
      "agents:\n  resume:\n    gap_seconds: 1\nservices:\n  restore_wait_seconds: 0\n",
  });
  return marks;
}

/** The bell's item after the restore, once it's there. */
async function restoreBell(ms: number): Promise<{ text: string } | null> {
  const f = path.join(s!.stateDir, "notifications.json");
  const until = Date.now() + ms;
  for (;;) {
    try {
      const items = (
        JSON.parse(fs.readFileSync(f, "utf8")) as {
          items: { subject: string; text: string }[];
        }
      ).items;
      const it = items.find(
        (x) => x.subject === "record:den-services-restored",
      );
      if (it) return it;
    } catch {
      /* not written yet */
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
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
    expect(s!.log()).toContain("Restored after the restart: north:");
  }, 60_000);

  it("issue 1225: the bell says 2 came back", async () => {
    const marks = await bootAfterRestart({ both: true });
    expect(await waitFor(marks.blog, 20_000)).toBe(true);
    expect((await restoreBell(30_000))?.text).toBe(
      "Brought back 2 services after the restart.",
    );
  }, 60_000);

  it("issue 1225: one that fails is named with its reason in the bell; the other still comes back", async () => {
    const marks = await bootAfterRestart({ both: true, blogFails: true });
    expect(await waitFor(marks.notes, 20_000)).toBe(true);
    const bell = await restoreBell(40_000);
    expect(bell?.text).toMatch(
      /^Brought back 1 service after the restart\. Not brought back: blog \(/,
    );
  }, 90_000);

  it("services.restore_on_boot: false: nothing comes back", async () => {
    const marks = await bootAfterRestart({
      userYml: "services:\n  restore_on_boot: false\n",
    });
    expect(await waitFor(marks.notes, 4_000)).toBe(false);
  }, 60_000);
});
