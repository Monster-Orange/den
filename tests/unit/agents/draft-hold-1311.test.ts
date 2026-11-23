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
  noteInput,
} from "../../../src/shared/agents/draft-input.js";
import "../../../src/shared/agents/runtimes.js";
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
    const d = resolveAgentsDeps(r.deps);
    expect(await agentInputState(d, "planner", new Set(), 200)).toBe("idle");
    expect(draftPending(sid)).toBe(false);
  }, 30_000);

  it("no draft: typed as today", async () => {
    const { r } = await planner(box(""));
    const d = resolveAgentsDeps(r.deps);
    expect(await typeIntoAgent(d, "planner", "a comment from Hub")).toBe(true);
  }, 30_000);
});
