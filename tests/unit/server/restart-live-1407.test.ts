/**
 * After "Restart N agents at their next idle", the
 * status is live per agent (restarted, waiting and why, failed and why) and
 * clears when done; never a fixed line. A wait that runs out says so in
 * the bell, not only in the audit; a job found when the turn ends does too.
 * An agent restarted later takes its bell row with it.
 *
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  RestartLive,
  restartBellSubject,
} from "../../../src/ui/server/restart-live.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1407live-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const plan = [
  { id: "ana", workspace: "north", state: "now" as const },
  { id: "bo", workspace: "north", state: "turn" as const },
  {
    id: "cy",
    workspace: "south",
    state: "job" as const,
    job: { command: "npm run dev", minutes: 12 },
  },
];

function live(keepDoneMs = 1_000) {
  let now = 1_000_000;
  const store = new NotificationStore(tmp());
  const l = new RestartLive({ keepDoneMs, now: () => now, store });
  return { l, store, tick: (ms: number) => (now += ms) };
}
const states = (l: RestartLive) =>
  l.list().map((r) => [r.id, r.state] as const);

describe("issue 1407: the status is live per agent and clears", () => {
  it("each agent of the plan, in its own state", () => {
    const { l } = live();
    l.begin(plan);
    expect(states(l)).toEqual([
      ["ana", "now"],
      ["bo", "turn"],
      ["cy", "job"],
    ]);
    expect(l.list()[2].job).toEqual({ command: "npm run dev", minutes: 12 });
  });

  it("a restarted agent says so, then leaves the list; all done, the list is empty", () => {
    const { l, tick } = live(1_000);
    l.begin(plan.slice(0, 2));
    l.done({ id: "ana", workspace: "north", outcome: "restarted" });
    expect(states(l)).toEqual([
      ["ana", "restarted"],
      ["bo", "turn"],
    ]);
    tick(1_001);
    expect(states(l)).toEqual([["bo", "turn"]]);
    l.done({ id: "bo", workspace: "north", outcome: "restarted" });
    tick(1_001);
    expect(l.list()).toEqual([]);
  });

  it("a wait that runs out, a job found when the turn ends, a failure: each stays, with why", () => {
    const { l, tick } = live();
    l.begin(plan.slice(0, 2));
    l.done({ id: "ana", workspace: "north", outcome: "timedOut", minutes: 30 });
    l.done({
      id: "bo",
      workspace: "north",
      outcome: "job",
      job: { command: "gate run x", minutes: 4 },
    });
    tick(60_000);
    expect(l.list()).toEqual([
      expect.objectContaining({ id: "ana", state: "timedOut", minutes: 30 }),
      expect.objectContaining({
        id: "bo",
        state: "job",
        job: { command: "gate run x", minutes: 4 },
      }),
    ]);
    l.done({ id: "bo", workspace: "north", outcome: "failed", error: "x" });
    expect(l.list()[1]).toMatchObject({ state: "failed", error: "x" });
  });

  it("a failure's text is redacted, on one line and short; a job's command too", () => {
    const { l, store } = live();
    l.begin(plan.slice(0, 2));
    l.done({
      id: "ana",
      workspace: "north",
      outcome: "failed",
      error: `curl -H "Authorization: Bearer abcdEFGH12345678xyz" https://x.test\nsecond line\n${"y".repeat(400)}`,
    });
    l.done({
      id: "bo",
      workspace: "north",
      outcome: "job",
      job: {
        command: "deploy --token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        minutes: 2,
      },
    });
    const [a, b] = l.list();
    expect(a.error).not.toContain("abcdEFGH12345678xyz");
    expect(a.error).toContain("[REDACTED]");
    expect(a.error).not.toContain("second line");
    expect(a.error!.length).toBeLessThanOrEqual(200);
    expect(b.job!.command).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    for (const n of store.list())
      expect(`${n.text} ${JSON.stringify(n.msg)}`).not.toMatch(
        /abcdEFGH12345678xyz|ghp_abcdefghijklmnopqrstuvwxyz0123456789/,
      );
  });

  it("an outcome for an agent not in a run is ignored", () => {
    const { l } = live();
    l.done({ id: "zed", workspace: "north", outcome: "restarted" });
    expect(l.list()).toEqual([]);
  });

  it("a new run for the same agent replaces its row", () => {
    const { l } = live();
    l.begin(plan.slice(0, 1));
    l.done({ id: "ana", workspace: "north", outcome: "timedOut", minutes: 30 });
    l.begin([{ id: "ana", workspace: "north", state: "turn" }]);
    expect(states(l)).toEqual([["ana", "turn"]]);
  });
});

describe("issue 1407: the bell says what the page says, and clears with it", () => {
  const bell = (s: NotificationStore) =>
    s.list().filter((n) => n.subject.startsWith("record:restart-wait:"));

  it("a wait that runs out reaches the bell, with the agent and minutes", () => {
    const { l, store } = live();
    l.begin(plan.slice(0, 1));
    l.done({ id: "ana", workspace: "north", outcome: "timedOut", minutes: 30 });
    expect(bell(store)).toEqual([
      expect.objectContaining({
        subject: restartBellSubject("north", "ana"),
        kind: "service",
        link: "/agents",
        text: "ana was not restarted: still working after 30 min",
        msg: { key: "bell.m.rsTimedOut", vars: { id: "ana", min: 30 } },
      }),
    ]);
  });

  it("a job found when the turn ends, and a failure, reach the bell", () => {
    const { l, store } = live();
    l.begin(plan.slice(0, 2));
    l.done({
      id: "ana",
      workspace: "north",
      outcome: "job",
      job: { command: "npm run dev", minutes: 12 },
    });
    l.done({ id: "bo", workspace: "north", outcome: "failed", error: "x" });
    expect(
      bell(store)
        .map((n) => n.msg)
        .sort((a, b) => String(a?.vars?.id).localeCompare(String(b?.vars?.id))),
    ).toEqual([
      { key: "bell.m.rsJob", vars: { id: "ana", cmd: "npm run dev", min: 12 } },
      { key: "bell.m.rsFailed", vars: { id: "bo" } },
    ]);
  });

  it("restarted, the agent's bell row goes; one restarted at once makes none", () => {
    const { l, store } = live();
    l.begin(plan.slice(0, 2));
    l.done({ id: "ana", workspace: "north", outcome: "timedOut", minutes: 30 });
    l.done({ id: "bo", workspace: "north", outcome: "restarted" });
    expect(bell(store).map((n) => n.subject)).toEqual([
      restartBellSubject("north", "ana"),
    ]);
    l.done({ id: "ana", workspace: "north", outcome: "restarted" });
    expect(bell(store)).toEqual([]);
  });

  it("every new key is in en, es and ja", () => {
    const root = path.join(__dirname, "../../../src/ui/server/public");
    const keys = [
      "bell.m.rsTimedOut",
      "bell.m.rsJob",
      "bell.m.rsFailed",
      "rs.timedOut",
    ];
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = fs.readFileSync(path.join(root, f), "utf-8");
      for (const k of keys)
        expect({ f, k, has: src.includes(`"${k}"`) }).toEqual({
          f,
          k,
          has: true,
        });
    }
  });
});
