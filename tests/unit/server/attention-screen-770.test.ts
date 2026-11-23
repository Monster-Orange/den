/**
 * Issue 770, slice 1 (Codex): Den reads a hookless agent's screen with its
 * runtime's rule set (src/shared/agents/detect) and shows Working, Blocked
 * (needs you) or Idle. Attention is the one place that reads it; the
 * notification service only hands it the screen tail.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention, SETTLE_MS } from "../../../src/ui/server/attention";
import {
  LIVE_SCREEN_RULES,
  screenOf,
  type Screen,
} from "../../../src/shared/agents/detect/live";

const SCREENS = path.join(process.cwd(), "tests", "fixtures", "agent-screens");

/** A recorded screen as a PTY sends it: each line ends CR LF. */
function fixture(runtime: string, name: string): string {
  const j = path.join(SCREENS, runtime, `${name}.json`);
  const title = fs.existsSync(j)
    ? (JSON.parse(fs.readFileSync(j, "utf8")) as { oscTitle?: string }).oscTitle
    : undefined;
  const text = fs
    .readFileSync(path.join(SCREENS, runtime, `${name}.txt`), "utf8")
    .replace(/\r?\n/g, "\r\n");
  // The title a .json beside it gives, as the agent sets it (OSC 0).
  return title ? `\x1b]0;${title}\x07${text}` : text;
}

let dir = "";
let clock = 1_000_000;
const tails = new Map<string, { rules: string; screen: Screen } | null>();
const marks: Record<string, string | null> = {};

function mk(extra: { hooked?: (id: string) => boolean } = {}) {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async (id) => marks[id] ?? null,
    nameOf: (id) => (id === "cx-1" ? "Coder" : id),
    now: () => clock,
    screenTail: async (id) => tails.get(id) ?? null,
    ...extra,
  });
  return { store, a };
}

function show(agent: string, runtime: string, name: string): void {
  tails.set(agent, {
    rules: runtime,
    screen: screenOf(fixture(runtime, name)),
  });
}

const AG = [{ agent: "cx-1", workspace: "web" }];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-att770-"));
  clock = 1_000_000;
  tails.clear();
  for (const k of Object.keys(marks)) delete marks[k];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 770: the screen's status reaches Den", () => {
  it("Codex is switched on; Gemini and Grok wait for their own slices", () => {
    expect(LIVE_SCREEN_RULES.has("codex")).toBe(true);
  });

  it("screenOf draws the raw tail and reads the latest OSC title", () => {
    const raw = `\x1b]0;old\x07\x1b[2J\x1b[Hhello\x1b[K\r\nworld\x1b]2;web\x07`;
    expect(screenOf(raw)).toEqual({ text: "hello\nworld\n", oscTitle: "web" });
  });

  it("Codex working is Working, and it waits on nothing", async () => {
    const { a, store } = mk();
    show("cx-1", "codex", "working");
    await a.screens(AG);
    expect(a.statusOf("cx-1")).toBe("working");
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it("Codex on an approval is Blocked: a 'needs your permission' wait", async () => {
    const { a, store } = mk();
    show("cx-1", "codex", "blocked-approval");
    await a.screens(AG);
    expect(a.statusOf("cx-1")).toBe("blocked");
    expect([...a.waitingNow()]).toEqual([["cx-1", "permission"]]);
    expect(store.list()[0]).toMatchObject({
      kind: "waiting",
      subject: "agent:cx-1",
      text: "Coder needs your permission",
    });
    // The same screen again is the same wait, not a second row.
    await a.screens(AG);
    expect(store.list()).toHaveLength(1);
  });

  it("Codex at an empty prompt is Idle", async () => {
    const { a } = mk();
    show("cx-1", "codex", "idle-prompt");
    await a.screens(AG);
    expect(a.statusOf("cx-1")).toBe("idle");
  });

  it("the approval answered (working again) ends the wait and its row", async () => {
    const { a, store } = mk();
    show("cx-1", "codex", "blocked-approval");
    await a.screens(AG);
    show("cx-1", "codex", "working");
    clock += SETTLE_MS + 1;
    await a.screens(AG);
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it("a screen-made wait is the screen's to end: output moving doesn't", async () => {
    const { a } = mk();
    marks["cx-1"] = "m1";
    show("cx-1", "codex", "blocked-approval");
    await a.screens(AG);
    await a.check();
    marks["cx-1"] = "m2"; // the dialog's cursor blinking
    clock += SETTLE_MS + 1;
    await a.check();
    expect(a.waitingNow().size).toBe(1);
  });

  it("a bell's wait ends when the screen shows it working again", async () => {
    const { a } = mk();
    await a.bells([
      {
        agent: "cx-1",
        workspace: "web",
        bellAt: new Date(clock).toISOString(),
      },
    ]);
    expect(a.waitingNow().size).toBe(1);
    show("cx-1", "codex", "working");
    clock += SETTLE_MS + 1;
    await a.screens(AG);
    expect(a.waitingNow().size).toBe(0);
  });

  it("a screen no rule matches keeps today's behaviour: the bell's wait stays, no status", async () => {
    const { a } = mk();
    await a.bells([
      {
        agent: "cx-1",
        workspace: "web",
        bellAt: new Date(clock).toISOString(),
      },
    ]);
    tails.set("cx-1", { rules: "codex", screen: { text: "" } });
    clock += SETTLE_MS + 1;
    await a.screens(AG);
    expect(a.statusOf("cx-1")).toBeUndefined();
    expect(a.waitingNow().size).toBe(1);
  });

  it("a transcript viewer on screen (skip_state_update) leaves the status as it was", async () => {
    const { a } = mk();
    show("cx-1", "codex", "working");
    await a.screens(AG);
    tails.set("cx-1", {
      rules: "codex",
      screen: {
        text: "› old question\n• old answer\n↑/↓ to scroll · pgup/pgdn to page · home/end to jump · q to quit · esc to edit prev\n",
      },
    });
    await a.screens(AG);
    expect(a.statusOf("cx-1")).toBe("working");
  });

  it("an agent with Den's hooks is never read from the screen", async () => {
    const { a } = mk({ hooked: (id) => id === "cx-1" });
    show("cx-1", "codex", "blocked-approval");
    await a.screens(AG);
    expect(a.statusOf("cx-1")).toBeUndefined();
    expect(a.waitingNow().size).toBe(0);
  });

  it("no screen (no session, the host not answering) changes nothing", async () => {
    const { a } = mk();
    show("cx-1", "codex", "working");
    await a.screens(AG);
    tails.set("cx-1", null);
    await a.screens(AG);
    expect(a.statusOf("cx-1")).toBe("working");
  });

  it("gone: its status goes too", async () => {
    const { a } = mk();
    show("cx-1", "codex", "working");
    await a.screens(AG);
    a.gone("cx-1");
    expect(a.statusOf("cx-1")).toBeUndefined();
  });
});
