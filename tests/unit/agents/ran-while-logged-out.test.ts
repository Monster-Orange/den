/**
 * Issue 163: "which agents ran while you were away" after a LOGOUT.
 *
 * Under Keep agents running after logout (mode always) the web server is a
 * LaunchDaemon: a logout never stops it, so the restart note
 * (noteRanWhileAway) never fires for a logout and login. The web server
 * watches who owns the console instead (/dev/console's owner: the person
 * while logged in, root at the login window, another uid after a user
 * switch), remembers which agents were running when the person left, and
 * on their return adds one bell note naming the agents that ran.
 *
 * No launchctl, no real logout: the console owner and the running agents
 * are injected. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CONSOLE_AWAY_FILE,
  consoleOwnerUid,
  stepConsole,
} from "../../../src/shared/console-away.js";
import { uiConsoleCheckSeconds } from "../../../src/shared/den-config.js";
import {
  consoleTick,
  noteRanWhileLoggedOut,
} from "../../../src/ui/server/agent-routes.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-logout-"));
  tmps.push(d);
  return d;
};

const ME = 501;
const ROOT = 0;
const T0 = Date.parse("2026-11-18T08:00:00Z");

describe("who owns the console", () => {
  it("the uid of /dev/console on macOS; null elsewhere or when it can't be read", () => {
    expect(
      consoleOwnerUid("darwin", (p) => {
        expect(p).toBe("/dev/console");
        return { uid: ME };
      }),
    ).toBe(ME);
    expect(consoleOwnerUid("linux", () => ({ uid: ME }))).toBeNull();
    expect(
      consoleOwnerUid("darwin", () => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });

  it("checked every ui.console_check_seconds: 30 by default, a positive number", () => {
    expect(uiConsoleCheckSeconds(() => ({}))).toBe(30);
    expect(
      uiConsoleCheckSeconds(() => ({ ui: { console_check_seconds: 5 } })),
    ).toBe(5);
    expect(
      uiConsoleCheckSeconds(() => ({ ui: { console_check_seconds: -1 } })),
    ).toBe(30);
  });
});

describe("leaving and coming back", () => {
  it("logout: remembers when and who was running; login: who kept running, started, ended", () => {
    const dir = tmp();
    // Logged in: nothing to remember.
    expect(
      stepConsole(dir, { me: ME, owner: ME, running: ["planner"], now: T0 }),
    ).toEqual({ left: false, back: null });
    expect(fs.existsSync(path.join(dir, CONSOLE_AWAY_FILE))).toBe(false);
    // Logout: the login window (root) owns the console.
    expect(
      stepConsole(dir, {
        me: ME,
        owner: ROOT,
        running: ["planner", "helper"],
        now: T0 + 1000,
      }),
    ).toEqual({ left: true, back: null });
    // Still away: once is enough.
    expect(
      stepConsole(dir, {
        me: ME,
        owner: ROOT,
        running: ["planner"],
        now: T0 + 60_000,
      }),
    ).toEqual({ left: false, back: null });
    // Back after 10 minutes: helper ended, writer started.
    expect(
      stepConsole(dir, {
        me: ME,
        owner: ME,
        running: ["planner", "writer"],
        now: T0 + 1000 + 10 * 60_000,
      }),
    ).toEqual({
      left: false,
      back: {
        awayMs: 10 * 60_000,
        kept: ["planner"],
        started: ["writer"],
        ended: ["helper"],
      },
    });
    expect(fs.existsSync(path.join(dir, CONSOLE_AWAY_FILE))).toBe(false);
  });

  it("a web server restart while away keeps what it remembered (a file in the state dir)", () => {
    const dir = tmp();
    stepConsole(dir, { me: ME, owner: ROOT, running: ["planner"], now: T0 });
    // A new process reads the same state dir.
    const r = stepConsole(dir, {
      me: ME,
      owner: ME,
      running: ["planner"],
      now: T0 + 5 * 60_000,
    });
    expect(r.back?.kept).toEqual(["planner"]);
  });

  it("an unreadable console changes nothing", () => {
    const dir = tmp();
    stepConsole(dir, { me: ME, owner: ROOT, running: ["planner"], now: T0 });
    expect(
      stepConsole(dir, { me: ME, owner: null, running: [], now: T0 + 1 }),
    ).toEqual({ left: false, back: null });
    expect(fs.existsSync(path.join(dir, CONSOLE_AWAY_FILE))).toBe(true);
  });
});

describe("the bell note on return", () => {
  const storeOf = () => {
    const added: unknown[] = [];
    return { added, store: { add: (n: unknown) => void added.push(n) } };
  };

  it("names the agents that ran, in the person's words, with a key in every language", () => {
    const { added, store } = storeOf();
    noteRanWhileLoggedOut(store as never, {
      awayMs: 12 * 60_000,
      kept: ["planner"],
      started: ["writer"],
      ended: ["helper"],
    });
    expect(added).toEqual([
      expect.objectContaining({
        kind: "service",
        subject: "record:agents-ran-while-logged-out",
        text: "While you were logged out (12 min), these agents ran: planner, writer",
        msg: {
          key: "bell.m.ranLoggedOut",
          vars: { min: 12, names: "planner, writer" },
        },
        link: "/agents",
      }),
    ]);
    // Nothing ran: no note.
    noteRanWhileLoggedOut(store as never, {
      awayMs: 60 * 60_000,
      kept: [],
      started: [],
      ended: ["helper"],
    });
    expect(added).toHaveLength(1);
  });

  it("each tick: a note only on return, and only after longer than ui.restart_wait_seconds", () => {
    const dir = tmp();
    const { added, store } = storeOf();
    let owner: number | null = ME;
    let now = T0;
    const tick = () =>
      consoleTick({
        stateDir: dir,
        me: ME,
        owner: () => owner,
        running: () => ["planner"],
        now: () => now,
        waitMs: 90_000,
        store: store as never,
      });
    tick();
    owner = ROOT;
    now += 1000;
    tick();
    // A quick user switch back (30 s): no note.
    owner = ME;
    now += 30_000;
    tick();
    expect(added).toHaveLength(0);
    // A real logout (20 min).
    owner = ROOT;
    now += 1000;
    tick();
    owner = ME;
    now += 20 * 60_000;
    tick();
    expect(added).toHaveLength(1);
    expect(added[0]).toEqual(
      expect.objectContaining({
        msg: {
          key: "bell.m.ranLoggedOut",
          vars: { min: 20, names: "planner" },
        },
      }),
    );
  });

  it("bell.m.ranLoggedOut is in en, es and ja with {min} and {names}", () => {
    const pub = path.resolve(__dirname, "../../../src/ui/server/public");
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = fs.readFileSync(path.join(pub, f), "utf-8");
      const m = /"bell\.m\.ranLoggedOut":\s*"([^"]+)"/.exec(src);
      expect(m && f).toBe(f);
      expect(m![1]).toContain("{min}");
      expect(m![1]).toContain("{names}");
    }
  });
});
