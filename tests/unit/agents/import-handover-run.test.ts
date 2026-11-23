/**
 * Issue 159, end to end through runAgentImport (the held write's run): a
 * conversation still open in a terminal is no longer refused. The Allow's
 * answer asks it for its hand-off; once that is written and the terminal
 * is closed, Den continues the conversation as the agent and tells it so.
 *
 * A real host on a temp socket with a scripted PTY: nothing runs, and the
 * `claude` shim must never run. A temp CLAUDE_CONFIG_DIR, never ~/.claude.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { claudeSlug } from "../../../src/shared/agents/conversations.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { agentFilesDir } from "../../../src/shared/agents/records.js";
import {
  resolveAgentsDeps,
  runAgentImport,
} from "../../../src/ui/cli/agent-ops.js";
import type { HandoverFailure } from "../../../src/shared/agents/import-handover.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  await cleanupRigs();
});

const TOKEN = "0f1e2d3c-aaaa-bbbb-cccc-000000000159";

/** A Claude Code transcript that ran in `cwd`, last written `ageMs` ago. */
function conversation(r: Rig, cwd: string, ageMs: number): string {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", claudeSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${TOKEN}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "user", cwd, message: { content: "Tidy the docs" } })}\n`,
  );
  age(file, ageMs);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  return file;
}

const age = (file: string, ageMs: number) => {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
};

const ask = { project: "north", session: TOKEN, persona: "planner" };

describe("issue 159: agent_import after the Allow", () => {
  it("a conversation not open elsewhere comes in at once, as before", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), 10 * 60_000);
    const out = await runAgentImport(resolveAgentsDeps(r.deps), ask);
    expect(out).toMatchObject({ ok: true, id: "planner", project: "north" });
    expect(out).not.toHaveProperty("handover");
    expect(r.made[0].args.slice(0, 2)).toEqual(["--resume", TOKEN]);
  });

  it("one still open: the answer asks for its hand-off; once written and closed, Den brings it in and tells it", async () => {
    const r = await rig();
    const file = conversation(r, r.wsDir("north"), 5_000);
    const failures: HandoverFailure[] = [];
    let finished: (v: unknown) => void = () => undefined;
    const done = new Promise((res) => (finished = res));
    const out = (await runAgentImport(resolveAgentsDeps(r.deps), ask, {
      pollMs: 20,
      fail: (f) => failures.push(f),
      done: finished,
    })) as Record<string, unknown>;
    const handoff = path.join(
      agentFilesDir(r.stateDir, "planner"),
      "handoff.md",
    );
    expect(out).toMatchObject({
      ok: true,
      id: "planner",
      handover: "waiting",
      handoff,
    });
    expect(String(out.next)).toContain(handoff);
    // Nothing started yet: the conversation is still open.
    expect(r.made).toHaveLength(0);
    // It writes its hand-off and its terminal goes quiet.
    fs.writeFileSync(handoff, GOOD_HANDOFF);
    age(file, 5 * 60_000);
    expect(await done).toMatchObject({ ok: true, id: "planner" });
    expect(failures).toEqual([]);
    expect(r.made[0].args.slice(0, 2)).toEqual(["--resume", TOKEN]);
    expect(readRecord(r.stateDir, "planner")?.resumeToken).toBe(TOKEN);
  });

  it("an old hand-off left in the agent's folder is set aside, never taken as this one", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), 5_000);
    const folder = agentFilesDir(r.stateDir, "planner");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "handoff.md"), GOOD_HANDOFF);
    const out = (await runAgentImport(resolveAgentsDeps(r.deps), ask, {
      pollMs: 20,
      fail: () => undefined,
    })) as Record<string, unknown>;
    expect(out.handover).toBe("waiting");
    expect(fs.existsSync(path.join(folder, "handoff.md"))).toBe(false);
  });
});
