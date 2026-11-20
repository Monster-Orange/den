/**
 * Issue 770: the screen rules feed the attention tracker. For an agent
 * whose runtime has no hooks (Codex, Gemini, Grok; Claude Code with its
 * hooks off), a Blocked screen marks it waiting on its person (as a
 * permission dialog), Working and Idle end that, and every list can say
 * Working or Idle. A hooked agent's hooks win over its screen. A viewer
 * on screen (skip) changes nothing; no rule matched keeps today's bell and
 * output signals. Recorded screens, a temp store, a fake clock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention, SETTLE_MS } from "../../../src/ui/server/attention";
import { screenStatus } from "../../../src/shared/agents/detect/index";

let dir = "";
let clock = 1_000_000;
const marks: Record<string, string | null> = {};
const hookedIds = new Set<string>();

const FIX = path.join(process.cwd(), "tests", "fixtures");
const shows = (rules: string, rel: string) =>
  screenStatus(rules, fs.readFileSync(path.join(FIX, rel), "utf-8"));

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async (id) => marks[id] ?? null,
    nameOf: (id) => id,
    now: () => clock,
    lookingMs: 10_000,
    hooked: (id) => hookedIds.has(id),
  });
  return { store, a };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-att770-"));
  clock = 1_000_000;
  for (const k of Object.keys(marks)) delete marks[k];
  hookedIds.clear();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 770: screen status in the attention tracker", () => {
  it("Codex blocked on an approval: waiting (permission), a waiting notification; working again clears it", async () => {
    const { store, a } = mk();
    marks.cx = "m1";
    await a.screens([
      {
        agent: "cx",
        workspace: "web",
        status: shows("codex", "agent-screens/codex/blocked-approval.raw"),
      },
    ]);
    expect([...a.waitingNow()]).toEqual([["cx", "permission"]]);
    expect(a.activityNow().get("cx")).toBe("blocked");
    expect(store.list()).toMatchObject([
      {
        kind: "waiting",
        subject: "agent:cx",
        text: "cx needs your permission",
      },
    ]);
    // Its output moving (the dialog redrawn) doesn't end it: the screen does.
    clock += SETTLE_MS * 2;
    marks.cx = "m2";
    await a.check();
    expect(a.waitingNow().size).toBe(1);
    await a.screens([
      {
        agent: "cx",
        workspace: "web",
        status: shows("codex", "agent-screens/codex/working.raw"),
      },
    ]);
    expect(a.waitingNow().size).toBe(0);
    expect(a.activityNow().get("cx")).toBe("working");
    expect(store.list()).toEqual([]);
  });

  it("Gemini and Grok: Working and Idle are listed, never a need", async () => {
    const { store, a } = mk();
    await a.screens([
      {
        agent: "gm",
        workspace: "web",
        status: shows("gemini", "agent-screens/gemini/working.raw"),
      },
      {
        agent: "gk",
        workspace: "web",
        status: shows("grok", "agent-screens/grok/idle.raw"),
      },
    ]);
    expect(a.activityNow().get("gm")).toBe("working");
    expect(a.activityNow().get("gk")).toBe("idle");
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("idle after a blocked screen (the dialog was answered no): the wait ends", async () => {
    const { a } = mk();
    await a.screens([
      {
        agent: "gk",
        workspace: "web",
        status: shows("grok", "agent-screens/grok/blocked-permission.raw"),
      },
    ]);
    expect(a.waitingNow().get("gk")).toBe("permission");
    await a.screens([
      {
        agent: "gk",
        workspace: "web",
        status: shows("grok", "agent-screens/grok/idle-no-title.raw"),
      },
    ]);
    expect(a.waitingNow().size).toBe(0);
  });

  it("3. Claude Code with hooks off: its screen rules decide", async () => {
    const { a } = mk();
    await a.screens([
      {
        agent: "cl",
        workspace: "web",
        status: shows("claude", "claude-code-screens/3-tool-dialog.raw"),
      },
    ]);
    expect(a.waitingNow().get("cl")).toBe("permission");
    await a.screens([
      {
        agent: "cl",
        workspace: "web",
        status: shows("claude", "agent-screens/claude/working.raw"),
      },
    ]);
    expect(a.waitingNow().size).toBe(0);
    expect(a.activityNow().get("cl")).toBe("working");
  });

  it("3. Claude Code with hooks on: the hooks win over the screen", async () => {
    const { a } = mk();
    hookedIds.add("cl");
    await a.event("cl", "web", {
      event: "waiting",
      why: "permission",
      what: "Bash",
      hooked: true,
    });
    // Its screen says working (it redraws): the hook's wait stays.
    await a.screens([
      {
        agent: "cl",
        workspace: "web",
        status: shows("claude", "agent-screens/claude/working.raw"),
      },
    ]);
    expect(a.waitingNow().get("cl")).toBe("permission");
    expect(a.activityNow().has("cl")).toBe(false);
    // And a blocked screen doesn't add a wait of its own.
    await a.event("cl", "web", { event: "finished" });
    await a.screens([
      {
        agent: "cl",
        workspace: "web",
        status: shows("claude", "claude-code-screens/3-tool-dialog.raw"),
      },
    ]);
    expect(a.waitingNow().size).toBe(0);
  });

  it("5. a transcript viewer on screen leaves the state as it was", async () => {
    const { a } = mk();
    await a.screens([
      {
        agent: "cx",
        workspace: "web",
        status: shows("codex", "agent-screens/codex/blocked-approval.raw"),
      },
    ]);
    const viewer = shows("codex", "agent-screens/codex/viewer-transcript.raw");
    expect(viewer?.skipStateUpdate).toBe(true);
    await a.screens([{ agent: "cx", workspace: "web", status: viewer }]);
    expect(a.waitingNow().get("cx")).toBe("permission");
    expect(a.activityNow().get("cx")).toBe("blocked");
  });

  it("6. no rule matched: today's behaviour (a bell's wait, cleared by output moving)", async () => {
    const { a } = mk();
    marks.cx = "m1";
    await a.bells([
      { agent: "cx", workspace: "web", bellAt: new Date(clock).toISOString() },
    ]);
    expect(a.waitingNow().get("cx")).toBe("input");
    await a.screens([{ agent: "cx", workspace: "web", status: null }]);
    expect(a.waitingNow().get("cx")).toBe("input");
    expect(a.activityNow().has("cx")).toBe(false);
    clock += SETTLE_MS + 1;
    marks.cx = "m2";
    await a.check();
    expect(a.waitingNow().size).toBe(0);
  });

  it("a bell at a turn's end, then an idle screen: the bell's update stays", async () => {
    const { store, a } = mk();
    await a.bells([
      { agent: "gm", workspace: "web", bellAt: new Date(clock).toISOString() },
    ]);
    const idle = shows("gemini", "agent-screens/gemini/idle-after-turn.raw");
    await a.screens([{ agent: "gm", workspace: "web", status: idle }]);
    expect(a.waitingNow().get("gm")).toBe("input");
    expect(store.list()).toHaveLength(1);
    // Working again (after the settle time): it went on, the update goes.
    clock += SETTLE_MS;
    const working = shows("gemini", "agent-screens/gemini/working.raw");
    await a.screens([{ agent: "gm", workspace: "web", status: working }]);
    expect(a.waitingNow().size).toBe(0);
  });

  it("an ask_human question is never ended by the screen", async () => {
    const { a } = mk();
    await a.event("cx", "web", {
      event: "waiting",
      why: "asked",
      text: "Which branch?",
    });
    await a.screens([
      {
        agent: "cx",
        workspace: "web",
        status: shows("codex", "agent-screens/codex/working.raw"),
      },
    ]);
    expect(a.waitingNow().get("cx")).toBe("asked");
  });

  it("a stopped agent's status goes with it", async () => {
    const { a } = mk();
    await a.screens([
      {
        agent: "gm",
        workspace: "web",
        status: shows("gemini", "agent-screens/gemini/working.raw"),
      },
    ]);
    a.gone("gm");
    expect(a.activityNow().has("gm")).toBe(false);
  });
});
