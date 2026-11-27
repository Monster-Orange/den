/**
 * 0.4.40 comment delivery: whether an agent can take a Hub comment now
 * (agentInputState), and typing one in (typeIntoAgent). A rig's scripted
 * PTY and a transcript written here; no real runtime runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentInputState,
  busyAgentIds,
  resolveAgentsDeps,
  sendFirstInstruction,
  typeIntoAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { typeMessage } from "../../../src/ui/server/agent-say.js";
import type { SessionInfo } from "../../../src/shared/sessions/types.js";
import { getRuntime, runtimeIds } from "../../../src/shared/agents/runtime.js";
import "../../../src/shared/agents/runtimes.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const ask = line({
  type: "user",
  timestamp: new Date().toISOString(),
  message: { role: "user", content: "plan the release" },
});
const answer = line({
  type: "assistant",
  timestamp: new Date().toISOString(),
  message: { role: "assistant", stop_reason: "end_turn", content: [] },
});

const askAt = (t: Date) =>
  line({
    type: "user",
    timestamp: t.toISOString(),
    message: { role: "user", content: "plan the release" },
  });

/**
 * Issue 607: a turn cut by a terminal host restart, as an install's
 * transcript ended: an answer that called two tools with no result after
 * them, then about ten metadata-only records.
 */
const cutAt = (t: Date) =>
  askAt(new Date(t.getTime() - 5_000)) +
  line({
    type: "assistant",
    timestamp: t.toISOString(),
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "Bash" },
        { type: "tool_use", id: "t2", name: "Read" },
      ],
    },
  }) +
  Array.from({ length: 10 }, (_, i) =>
    line(
      i % 2
        ? { type: "permission-mode", permissionMode: "default" }
        : { type: "cost-state", n: i },
    ),
  ).join("");

async function started(
  r: Rig,
  transcript: string | null | (() => string),
): Promise<void> {
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  await settle();
  if (transcript === null) return;
  write(r, typeof transcript === "function" ? transcript() : transcript);
}

/** Where agent planner's transcript is. */
function transcriptOf(r: Rig): string {
  const token = record(r, "planner").resumeToken as string;
  return path.join(
    r.dir,
    "claude-config",
    "projects",
    "-work",
    `${token}.jsonl`,
  );
}

/** Agent planner's transcript, as its runtime writes it. */
function write(r: Rig, body: string): void {
  const file = transcriptOf(r);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  r.deps.env = {
    ...r.deps.env,
    CLAUDE_CONFIG_DIR: path.join(r.dir, "claude-config"),
  };
}

/** The agent's live session's start, from its session host. */
async function sessionStart(r: Rig): Promise<number> {
  const d = resolveAgentsDeps(r.deps);
  const c = await d.connect();
  try {
    const id = (record(r, "planner").session as { id: string }).id;
    const s = (await c.list()).find((x) => x.ref.id === id);
    return Date.parse(s!.startedAt);
  } finally {
    c.close();
  }
}

/**
 * The runtime's permission dialog, as its screen ends while it waits for
 * its person (the first choice highlighted).
 */
const DIALOG =
  "Bash command\r\n\r\n  npm run build\r\n  Build it\r\n\r\n" +
  "Do you want to proceed?\r\n❯ 1. Yes\r\n" +
  "  2. Yes, and don't ask again for npm run build commands in /work\r\n" +
  "  3. No, and tell Claude what to do differently (esc)\r\n";

/** Its folder-trust question, as the screen ends with it. */
const TRUST =
  "Do you trust the files in this folder?\r\n\r\n/work\r\n\r\n" +
  "❯ 1. Yes, proceed\r\n  2. No, exit\r\n";

describe("agentInputState", () => {
  it("no such agent: missing", async () => {
    const r = await rig();
    expect(await agentInputState(resolveAgentsDeps(r.deps), "nobody")).toBe(
      "missing",
    );
  });

  it("its turn ended: idle; an approval waiting on it: busy", async () => {
    const r = await rig();
    await started(r, ask + answer);
    // Issue 664: at its input prompt.
    r.made[0].emit("> ");
    await settle();
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner")).toBe("idle");
    expect(await agentInputState(d, "planner", new Set(["planner"]))).toBe(
      "busy",
    );
  });

  it("mid-turn: busy", async () => {
    const r = await rig();
    // Issue 607: the prompt came after its session started, as it does.
    await started(r, () => askAt(new Date()));
    expect(await agentInputState(resolveAgentsDeps(r.deps), "planner")).toBe(
      "busy",
    );
  });

  it("stopped: stopped; no session host running: stopped, and none started", async () => {
    const r = await rig();
    await started(r, ask + answer);
    const d = resolveAgentsDeps(r.deps);
    let connects = 0;
    const none = {
      ...d,
      connectExisting: async () => null,
      connect: async () => {
        connects++;
        throw new Error("must not start a host");
      },
    };
    // Running by its record, but no host: stopped, and no host started.
    expect(await agentInputState(none, "planner")).toBe("stopped");
    expect(connects).toBe(0);
    expect(await agents(r, "stop", "planner", "-w", "north")).toBe(0);
    await settle();
    expect(await agentInputState(d, "planner")).toBe("stopped");
  });

  it("a turn Den can't read: quiet output is idle, output still coming is busy", async () => {
    const r = await rig();
    await started(r, null);
    r.made[0].emit("> ");
    await settle();
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner", new Set(), 200)).toBe("idle");
    const spin = setInterval(() => r.made[0].emit("."), 40);
    try {
      expect(await agentInputState(d, "planner", new Set(), 300)).toBe("busy");
    } finally {
      clearInterval(spin);
    }
  });
});

describe("issue 607: a turn cut by a terminal host restart", () => {
  it("cut before its live session started: idle, and no restart waits on it", async () => {
    const r = await rig();
    await started(r, null);
    r.made[0].emit("> ");
    const since = await sessionStart(r);
    write(r, cutAt(new Date(since - 60_000)));
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner")).toBe("idle");
    // The host-restart wait and the update check ask this.
    expect(await busyAgentIds(d, ["planner"])).toEqual([]);
  });

  it("the same tail written in its live session: busy, as before", async () => {
    const r = await rig();
    await started(r, null);
    const since = await sessionStart(r);
    write(r, cutAt(new Date(since + 1_000)));
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner")).toBe("busy");
    expect(await busyAgentIds(d, ["planner"])).toEqual(["planner"]);
  });

  it("no session start it can read: the agent record's start", async () => {
    const r = await rig();
    await started(r, null);
    r.made[0].emit("> ");
    const recAt = Date.parse(record(r, "planner").startedAt as string);
    // Both writes land in one tick of the file's clock (a
    // fast Linux box stamps mtimes by its timer tick), at the same size.
    const tick = new Date();
    write(r, cutAt(new Date(recAt - 60_000)));
    fs.utimesSync(transcriptOf(r), tick, tick);
    const d = resolveAgentsDeps(r.deps);
    // A session list whose entries carry no start.
    const blank = <C extends { list: () => Promise<SessionInfo[]> }>(c: C) =>
      Object.assign(Object.create(c) as C, {
        list: async () =>
          (await c.list()).map((s) => ({ ...s, startedAt: "" })),
      });
    const noStart = {
      ...d,
      connect: async () => blank(await d.connect()),
      connectExisting: async () => {
        const c = await d.connectExisting();
        return c ? blank(c) : c;
      },
    };
    expect(await agentInputState(noStart, "planner")).toBe("idle");
    write(r, cutAt(new Date(recAt + 60_000)));
    fs.utimesSync(transcriptOf(r), tick, tick);
    expect(await agentInputState(noStart, "planner")).toBe("busy");
  });
});

describe("typeIntoAgent", () => {
  it("types the comment into its session, then Enter", async () => {
    const r = await rig();
    await started(r, ask + answer);
    r.made[0].emit("> ");
    const ok = await typeIntoAgent(
      resolveAgentsDeps(r.deps),
      "planner",
      "from: Pat (your person · verified by Hub session)\nshorter heading",
    );
    expect(ok).toBe(true);
    await settle();
    const sent = Buffer.concat(r.made[0].writes).toString();
    expect(sent).toContain("shorter heading");
    expect(sent.endsWith("\r")).toBe(true);
  }, 30_000);

  it("two at once into one agent: one after the other, never mixed", async () => {
    const r = await rig();
    await started(r, ask + answer);
    r.made[0].emit("> ");
    const d = resolveAgentsDeps(r.deps);
    const one = "A".repeat(4000);
    const two = "B".repeat(4000);
    const oks = await Promise.all([
      typeIntoAgent(d, "planner", one),
      typeIntoAgent(d, "planner", two),
    ]);
    expect(oks).toEqual([true, true]);
    await settle();
    const sent = Buffer.concat(r.made[0].writes)
      .toString()
      .replace(/[^AB\r]/g, "");
    // Each text whole, then its Enter; the second only after the first.
    expect(sent).toBe(`${one}\r${two}\r`);
  }, 60_000);

  it("no such agent: false", async () => {
    const r = await rig();
    expect(await typeIntoAgent(resolveAgentsDeps(r.deps), "nobody", "x")).toBe(
      false,
    );
  });
});

describe("a dialog waiting for the person: Den never types into it", () => {
  it("a permission dialog on screen: nothing typed, false", async () => {
    const r = await rig();
    await started(r, ask);
    r.made[0].emit(DIALOG);
    const before = r.made[0].writes.length;
    const ok = await typeIntoAgent(
      resolveAgentsDeps(r.deps),
      "planner",
      "Den is back on 0.4.74",
    );
    expect(ok).toBe(false);
    await settle();
    expect(r.made[0].writes.length).toBe(before);
  }, 30_000);

  it("its trust question on screen: nothing typed, false", async () => {
    const r = await rig();
    await started(r, null);
    r.made[0].emit(TRUST);
    const before = r.made[0].writes.length;
    expect(
      await typeIntoAgent(resolveAgentsDeps(r.deps), "planner", "hello"),
    ).toBe(false);
    await settle();
    expect(r.made[0].writes.length).toBe(before);
  }, 30_000);

  it("the dialog answered and gone: typed as before", async () => {
    const r = await rig();
    await started(r, ask + answer);
    r.made[0].emit(DIALOG);
    r.made[0].emit("\x1b[2J\x1b[H> ");
    expect(
      await typeIntoAgent(resolveAgentsDeps(r.deps), "planner", "hello"),
    ).toBe(true);
    await settle();
    expect(Buffer.concat(r.made[0].writes).toString()).toContain("hello");
  }, 30_000);

  it("a permission dialog on screen: busy, even when its turn reads ended or output is quiet", async () => {
    const r = await rig();
    await started(r, ask + answer);
    r.made[0].emit(DIALOG);
    await settle();
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner")).toBe("busy");
    const q = await rig();
    await started(q, null);
    q.made[0].emit(DIALOG);
    await settle();
    expect(
      await agentInputState(
        resolveAgentsDeps(q.deps),
        "planner",
        new Set(),
        200,
      ),
    ).toBe("busy");
  }, 30_000);

  it("a message from the page or Hub with a dialog open: refused 409 dialog_open, nothing typed", async () => {
    const r = await rig();
    await started(r, ask);
    r.made[0].emit(DIALOG);
    await settle();
    const before = r.made[0].writes.length;
    const d = resolveAgentsDeps(r.deps);
    const rec = JSON.parse(
      fs.readFileSync(path.join(r.stateDir, "agents", "planner.json"), "utf-8"),
    );
    await expect(typeMessage(d, rec, "hello")).rejects.toMatchObject({
      status: 409,
      code: "dialog_open",
    });
    await settle();
    expect(r.made[0].writes.length).toBe(before);
  }, 30_000);

  it("a first instruction (no quiet wait) with a dialog open: not typed, and its caller hears why", async () => {
    const r = await rig();
    await started(r, null);
    r.made[0].emit(TRUST);
    await settle();
    const before = r.made[0].writes.length;
    const d = resolveAgentsDeps(r.deps);
    const sid = (record(r, "planner").session as { id: string }).id;
    let held = false;
    const rt = record(r, "planner").runtime as string;
    const sent = await sendFirstInstruction(d, sid, rt, "go", {
      quietMs: 0,
      maxMs: 0,
      onDialog: () => {
        held = true;
      },
    });
    expect([sent, held]).toEqual([false, true]);
    await settle();
    expect(r.made[0].writes.length).toBe(before);
  }, 30_000);
});

/**
 * Issue 664: Den types into an agent only when its screen shows the
 * runtime's input prompt, with nothing after it but its footer, no
 * dialog anywhere on the screen, no waiting mark and a quiet transcript.
 */
describe("issue 664: typed only at the agent's input prompt", () => {
  /** Its turn ended: the transcript reads idle. */
  const idle = ask + answer;

  /** Whether `screen`, drawn after its turn ended, gets text typed. */
  async function typedInto(screen: string | string[]): Promise<{
    typed: boolean;
    state: string;
  }> {
    const r = await rig();
    await started(r, idle);
    for (const s of Array.isArray(screen) ? screen : [screen])
      r.made[0].emit(s);
    await settle();
    const d = resolveAgentsDeps(r.deps);
    const state = await agentInputState(d, "planner", new Set(), 200);
    const before = r.made[0].writes.length;
    const ok = await typeIntoAgent(d, "planner", "a comment from Hub");
    await settle();
    const wrote = Buffer.concat(r.made[0].writes.slice(before)).toString();
    expect(ok).toBe(wrote.includes("a comment from Hub"));
    return { typed: ok, state };
  }

  it("(a) a dialog followed by more output: nothing typed", async () => {
    const more =
      "\r\n⏺ Reading the rest of the build log while it waits\r\n" +
      Array.from(
        { length: 20 },
        (_, i) =>
          `  ⎿ step ${i}: compiled module number ${i} of the bundle\r\n`,
      ).join("");
    expect(await typedInto([DIALOG, more])).toEqual({
      typed: false,
      state: "busy",
    });
  }, 30_000);

  it("(b) a dialog redrawn in place, with no clear: nothing typed", async () => {
    // The line above the dialog ticks: up, erase, redraw, back down.
    const ticks = Array.from(
      { length: 60 },
      (_, i) =>
        `\x1b[8A\x1b[2K\x1b[G✻ Waiting for your answer (${i}s elapsed)\x1b[8B\x1b[G`,
    ).join("");
    expect(
      await typedInto(["✻ Waiting for your answer (0s)\r\n", DIALOG, ticks]),
    ).toEqual({ typed: false, state: "busy" });
  }, 30_000);

  it("(c) a dialog in a form Den doesn't know: nothing typed", async () => {
    const odd =
      "Run this tool?\r\n\r\n  deploy --all\r\n\r\n" +
      "❯ 1. Allow once\r\n  2. Allow always\r\n  3. Deny\r\n";
    expect(await typedInto(odd)).toEqual({ typed: false, state: "busy" });
  }, 30_000);

  it("(d) a whole screen drawn as Claude Code draws its dialog: nothing typed", async () => {
    // Not a capture: drawn after its layout (Ink frame, rounded box, SGR
    // colour, a timer in the header repainted by cursor position).
    const frame =
      "\x1b[2J\x1b[H\x1b[?25l" +
      "\x1b[1m⏺\x1b[22m Bash(npm run build)\r\n" +
      "\x1b[38;5;174m╭──────────────────────────────────────────────╮\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m \x1b[1mBash command\x1b[22m \x1b[2m(0s)\x1b[22m                     \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m                                              \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m   npm run build                              \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m   \x1b[2mBuild the bundle\x1b[22m                         \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m                                              \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m Do you want to proceed?                      \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m \x1b[36m❯\x1b[39m \x1b[36m1. Yes\x1b[39m                                     \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m   2. Yes, and don't ask again for npm run build \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m│\x1b[39m   3. No, and tell Claude what to do differently (\x1b[1mesc\x1b[22m) \x1b[38;5;174m│\x1b[39m\r\n" +
      "\x1b[38;5;174m╰──────────────────────────────────────────────╯\x1b[39m\r\n";
    // Five minutes waiting: the header's timer repainted each second.
    const timer = Array.from(
      { length: 300 },
      (_, i) => `\x1b[3;16H\x1b[2m(${Math.floor(i / 60)}m ${i % 60}s)\x1b[22m`,
    ).join("");
    expect(await typedInto([frame, timer])).toEqual({
      typed: false,
      state: "busy",
    });
  }, 30_000);

  /** A captured Claude Code screen (tests/fixtures/claude-code-screens), as a terminal gets it. */
  const captured = (name: string) =>
    fs
      .readFileSync(
        path.join(
          __dirname,
          "../../fixtures/claude-code-screens",
          `${name}.raw`,
        ),
        "utf-8",
      )
      .replace(/\r?\n/g, "\r\n");

  it("(d) captured: Claude Code's dialog for a tool, and its redraw: nothing typed", async () => {
    expect(await typedInto(captured("3-tool-dialog"))).toEqual({
      typed: false,
      state: "busy",
    });
    expect(
      await typedInto([
        captured("3-tool-dialog"),
        captured("3b-tool-dialog-redraw"),
      ]),
    ).toEqual({ typed: false, state: "busy" });
  }, 60_000);

  it("captured: its folder-trust question (No first or Yes selected): nothing typed", async () => {
    for (const name of ["1-trust", "1b-trust-yes-selected"])
      expect(await typedInto(captured(name))).toEqual({
        typed: false,
        state: "busy",
      });
  }, 60_000);

  it("captured: at its input prompt (at start, after a turn, after a dialog's Esc): typed at once", async () => {
    for (const name of [
      "2-input-prompt",
      "2b-input-prompt-after-turn",
      "4-after-no",
    ])
      expect(await typedInto(captured(name))).toEqual({
        typed: true,
        state: "idle",
      });
  }, 90_000);

  it("at its input prompt (Claude Code's box and footer): typed at once, as today", async () => {
    const box =
      "\x1b[2J\x1b[H⏺ Done: the build passes.\r\n\r\n" +
      "\x1b[2m────────────────────────────────────────\x1b[22m\r\n" +
      "> \r\n" +
      "\x1b[2m────────────────────────────────────────\x1b[22m\r\n" +
      "  \x1b[2m? for shortcuts\x1b[22m                ⏵⏵ accept edits on (shift+tab to cycle)\r\n";
    expect(await typedInto(box)).toEqual({ typed: true, state: "idle" });
    const old =
      "\x1b[2J\x1b[H╭──────────────────────────────╮\r\n" +
      '│ > Try "fix the lint errors"  │\r\n' +
      "╰──────────────────────────────╯\r\n" +
      "  ? for shortcuts\r\n";
    expect(await typedInto(old)).toEqual({ typed: true, state: "idle" });
  }, 60_000);
});

/**
 * Issue 664, per runtime: each built-in runtime either declares its input
 * prompt (den-claude, from captured screens) or keeps today's rule
 * (unproven: no capture of what it draws). A first instruction still
 * reaches a fresh agent on each; a dialog on screen still holds it.
 */
describe("issue 664: each runtime's input check", () => {
  const RUNTIMES: Record<
    string,
    { prompt: "declared" | "today"; ready: string }
  > = {
    "den-claude": { prompt: "declared", ready: "\x1b[2J\x1b[H> " },
    codex: { prompt: "today", ready: "\x1b[2J\x1b[Hready" },
    gemini: { prompt: "today", ready: "\x1b[2J\x1b[Hready" },
    grok: { prompt: "today", ready: "\x1b[2J\x1b[Hready" },
    antigravity: { prompt: "today", ready: "\x1b[2J\x1b[Hready" },
    generic: { prompt: "today", ready: "\x1b[2J\x1b[Hready" },
  };

  it("every registered runtime is in this table", () => {
    expect(runtimeIds().sort()).toEqual(Object.keys(RUNTIMES).sort());
    for (const [id, want] of Object.entries(RUNTIMES))
      expect([id, getRuntime(id)?.inputPrompt ? "declared" : "today"]).toEqual([
        id,
        want.prompt,
      ]);
  });

  for (const [id, want] of Object.entries(RUNTIMES))
    it(`${id}: a fresh agent's first instruction is typed; with a dialog on screen it is not`, async () => {
      const r = await rig();
      await started(r, null);
      const d = resolveAgentsDeps(r.deps);
      const sid = (record(r, "planner").session as { id: string }).id;
      r.made[0].emit(want.ready);
      await settle();
      expect(
        await sendFirstInstruction(d, sid, id, "go", { quietMs: 0, maxMs: 0 }),
      ).toBe(true);
      await settle();
      expect(Buffer.concat(r.made[0].writes).toString()).toContain("go");
      // A dialog in a form no runtime declares: held on every runtime.
      r.made[0].emit("\r\nRun this tool?\r\n❯ 1. Allow once\r\n  2. Deny\r\n");
      await settle();
      const before = r.made[0].writes.length;
      let held = false;
      expect(
        await sendFirstInstruction(d, sid, id, "again", {
          quietMs: 0,
          maxMs: 0,
          onDialog: () => {
            held = true;
          },
        }),
      ).toBe(false);
      expect(held).toBe(true);
      expect(r.made[0].writes.length).toBe(before);
      if (want.prompt === "declared") {
        // Proven only at its prompt: other output holds it.
        r.made[0].emit("\x1b[2J\x1b[Hstill working on it");
        await settle();
        expect(
          await sendFirstInstruction(d, sid, id, "later", {
            quietMs: 0,
            maxMs: 0,
          }),
        ).toBe(false);
      }
    }, 30_000);
});
