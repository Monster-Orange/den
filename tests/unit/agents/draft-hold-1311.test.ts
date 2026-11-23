/**
 * Issue 1311: Den never types into an agent's prompt that holds its
 * person's unsent draft. The server sees every key the person sends
 * through Den's terminal (noteInput); a draft pending holds what Den
 * would type (agentInputState "busy", typeIntoAgent waits), in order,
 * until Enter, Ctrl-C, Ctrl-U or an empty input line clears it.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentInputState,
  heldForDraft,
  resolveAgentsDeps,
  typeIntoAgent,
} from "../../../src/ui/cli/agent-ops.js";
import {
  clearDraft,
  draftPending,
  ECHO_MS,
  noteInput,
} from "../../../src/shared/agents/draft-input.js";
import "../../../src/shared/agents/runtimes.js";
import {
  DRAFT_HOLD_MAX_MINUTES,
  readAgentsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";
import * as cliRows from "../../../src/shared/settings-cli-rows.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const key = (sid: string, s: string) => noteInput(sid, Buffer.from(s, "utf-8"));

describe("issue 1311: which keys make a draft", () => {
  const sid = "s-keys";
  afterEach(() => clearDraft(sid));

  it("printable text sets it; Enter clears it", () => {
    key(sid, "half a sen");
    expect(draftPending(sid)).toBe(true);
    key(sid, "tence\r");
    expect(draftPending(sid)).toBe(false);
  });

  it("Ctrl-C and Ctrl-U clear it", () => {
    key(sid, "abc");
    key(sid, "\x03");
    expect(draftPending(sid)).toBe(false);
    key(sid, "abc");
    key(sid, "\x15");
    expect(draftPending(sid)).toBe(false);
  });

  it("backspacing to empty clears it; part of the way keeps it", () => {
    key(sid, "ab");
    key(sid, "\x7f");
    expect(draftPending(sid)).toBe(true);
    key(sid, "\x7f");
    expect(draftPending(sid)).toBe(false);
  });

  it("a paste sets it, its newlines included", () => {
    key(sid, "\x1b[200~line one\rline two\x1b[201~");
    expect(draftPending(sid)).toBe(true);
  });

  it("arrows, focus and mouse reports and other escapes never set it", () => {
    key(sid, "\x1b[A\x1b[B\x1b[C\x1b[D"); // arrows
    key(sid, "\x1bOA"); // an arrow in application mode
    key(sid, "\x1b[I\x1b[O"); // focus in, out
    key(sid, "\x1b[<0;12;5M\x1b[<0;12;5m"); // an SGR mouse click
    key(sid, "\x1b[M !!"); // an X10 mouse click
    key(sid, "\x1b]11;rgb:0000/0000/0000\x07"); // an OSC answer
    key(sid, "\x1b[2;1R"); // a cursor report
    expect(draftPending(sid)).toBe(false);
  });

  it("an escape split across two frames is still an escape, not text", () => {
    key(sid, "\x1b");
    key(sid, "[A"); // an arrow, its ESC in the frame before
    key(sid, "\x1b[");
    key(sid, "<0;12;5M"); // a mouse click, split inside
    key(sid, "\x1b]11;rgb:00");
    key(sid, "00/0000/0000\x07"); // an OSC answer, split inside
    expect(draftPending(sid)).toBe(false);
  });

  it("a paste whose start marker is split still makes a draft, and its end ends it", () => {
    key(sid, "\x1b[20");
    key(sid, "0~pasted\x1b[2");
    key(sid, "01~");
    expect(draftPending(sid)).toBe(true);
  });

  it("an Escape key alone, then text a moment later: the text is a draft", async () => {
    key(sid, "\x1b");
    await new Promise((r) => setTimeout(r, 600));
    key(sid, "[abc");
    expect(draftPending(sid)).toBe(true);
  });

  it("a backslash before Enter is a new line in the draft, not a send", () => {
    key(sid, "first line\\\r");
    expect(draftPending(sid)).toBe(true);
  });
});

/** Claude Code's input box, its line holding `line`. */
const box = (line: string) =>
  "\x1b[2J\x1b[H⏺ Done: the build passes.\r\n\r\n" +
  "────────────────────────────────────────\r\n" +
  `> ${line}\r\n` +
  "────────────────────────────────────────\r\n" +
  "  ? for shortcuts\r\n";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const idle =
  line({
    type: "user",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "plan the release" },
  }) +
  line({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", stop_reason: "end_turn", content: [] },
  });

const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as { session: { id: string }; resumeToken: string };

/** Agent planner, its turn over, its screen `screen`. */
async function planner(screen: string): Promise<{ r: Rig; sid: string }> {
  const r = await rig();
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  await settle();
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${record(r, "planner").resumeToken}.jsonl`),
    idle,
  );
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  r.made[0].emit(screen);
  await settle();
  return { r, sid: record(r, "planner").session.id };
}

const written = (r: Rig, from: number) =>
  Buffer.concat(r.made[0].writes.slice(from)).toString();

describe("issue 1311: a draft holds what Den types", () => {
  it("a draft pending: not idle, nothing typed; Enter sends it, then Den's text goes", async () => {
    const { r, sid } = await planner(box("half a sen"));
    key(sid, "half a sen");
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner", new Set(), 200)).toBe("busy");
    expect(heldForDraft("planner")).toBe(true);
    const before = r.made[0].writes.length;
    const typing = typeIntoAgent(d, "planner", "a comment from Hub");
    await new Promise((res) => setTimeout(res, 2500));
    expect(written(r, before)).not.toContain("a comment from Hub");
    // The person sends their draft: the prompt is empty again.
    key(sid, "\r");
    r.made[0].emit(box(""));
    expect(await typing).toBe(true);
    await settle();
    expect(written(r, before)).toContain("a comment from Hub");
    expect(heldForDraft("planner")).toBe(false);
  }, 30_000);

  it("refuse: returns false at once, nothing typed, the draft intact", async () => {
    const { r, sid } = await planner(box("half a sen"));
    key(sid, "half a sen");
    const d = resolveAgentsDeps(r.deps);
    const before = r.made[0].writes.length;
    expect(
      await typeIntoAgent(d, "planner", "a comment from Hub", {
        onDraft: "refuse",
      }),
    ).toBe(false);
    await settle();
    expect(written(r, before)).toBe("");
    expect(draftPending(sid)).toBe(true);
    clearDraft(sid);
  }, 30_000);

  it("Ctrl-U clears it: Den's text goes", async () => {
    const { r, sid } = await planner(box("half a sen"));
    key(sid, "half a sen");
    key(sid, "\x15");
    r.made[0].emit(box(""));
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner", new Set(), 200)).toBe("idle");
    expect(await typeIntoAgent(d, "planner", "a comment from Hub")).toBe(true);
  }, 30_000);

  it("the input line shows empty again (cleared some other way): the draft clears", async () => {
    const { r, sid } = await planner(box("half a sen"));
    key(sid, "half a sen");
    key(sid, "\x17"); // Ctrl-W: Den can't count what it took
    expect(draftPending(sid)).toBe(true);
    r.made[0].emit(box(""));
    await settle();
    // Older than its echo could take: the empty line is what it shows.
    await new Promise((res) => setTimeout(res, ECHO_MS + 100));
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner", new Set(), 200)).toBe("idle");
    expect(draftPending(sid)).toBe(false);
  }, 30_000);

  it("a draft just begun, against an empty line its echo hasn't reached: held", async () => {
    const { r, sid } = await planner(box(""));
    key(sid, "h");
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner", new Set(), 200)).toBe("busy");
    expect(draftPending(sid)).toBe(true);
    const before = r.made[0].writes.length;
    expect(
      await typeIntoAgent(d, "planner", "a comment from Hub", {
        onDraft: "refuse",
      }),
    ).toBe(false);
    expect(written(r, before)).toBe("");
    clearDraft(sid);
  }, 30_000);

  it("an old draft erased out of Den's sight, then a fresh key, against an empty line: held", async () => {
    const { r, sid } = await planner(box("half a sen"));
    key(sid, "half a sen");
    key(sid, "\x17"); // Ctrl-W: Den can't count what it took
    r.made[0].emit(box(""));
    await settle();
    await new Promise((res) => setTimeout(res, ECHO_MS + 100));
    key(sid, "x"); // typing again; its echo isn't on the screen yet
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner", new Set(), 200)).toBe("busy");
    expect(draftPending(sid)).toBe(true);
    clearDraft(sid);
  }, 30_000);

  it("no draft: typed as today", async () => {
    const { r } = await planner(box(""));
    const d = resolveAgentsDeps(r.deps);
    expect(await typeIntoAgent(d, "planner", "a comment from Hub")).toBe(true);
  }, 30_000);
});

describe("issue 1311: agents.draft_hold_max_minutes is a Setting", () => {
  const MIN = 60_000;
  const hold = (v: unknown) =>
    readAgentsConfig({
      agents: { draft_hold_max_minutes: v },
    } as unknown as DenConfig).draftHoldMaxMs;

  it("30 unset; 1 to 1440; anything else names the key", () => {
    expect(readAgentsConfig({} as DenConfig).draftHoldMaxMs).toBe(30 * MIN);
    expect(hold(1)).toBe(MIN);
    expect(hold(1440)).toBe(1440 * MIN);
    for (const bad of [0, 0.5, 1441, "30", -1])
      expect(() => hold(bad)).toThrow(/agents\.draft_hold_max_minutes/);
  });

  it("Settings has its row, and its POST field writes user.yml agents.draft_hold_max_minutes", () => {
    const row = (
      DEN_SETTINGS as {
        id: string;
        keys?: string[];
        control?: Record<string, unknown>;
        scope?: string;
        category?: string;
      }[]
    ).find((x) => x.keys?.includes("agents_draft.hold_max_minutes"));
    expect(row).toMatchObject({
      category: "agents",
      scope: "user",
      control: {
        type: "number",
        min: DRAFT_HOLD_MAX_MINUTES.min,
        max: DRAFT_HOLD_MAX_MINUTES.max,
      },
    });
    expect(DRAFT_HOLD_MAX_MINUTES).toMatchObject({ min: 1, max: 1440 });
    const user: Record<string, unknown> = { agents: { lock_wait_minutes: 5 } };
    expect(
      cliRows.patchCliRows(user, { agents_draft: { hold_max_minutes: 45 } }),
    ).toEqual({ ok: true });
    expect(user.agents).toEqual({
      lock_wait_minutes: 5,
      draft_hold_max_minutes: 45,
    });
    for (const bad of [0, 1441])
      expect(
        cliRows.patchCliRows(user, { agents_draft: { hold_max_minutes: bad } })
          .ok,
      ).toBe(false);
    cliRows.patchCliRows(user, { agents_draft: { hold_max_minutes: null } });
    expect(user.agents).toEqual({ lock_wait_minutes: 5 });
  });
});
