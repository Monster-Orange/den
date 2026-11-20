/**
 * Issue 765: an agent's helper sub-agents (forks) share its files folder.
 *
 *   - Only the session Den launched counts: a fork's compaction (another
 *     session id, or a sub-agent's input: `agent_id`, a transcript under
 *     `subagents/`) leaves the agent's count unchanged.
 *   - Every rotation notice goes to the agent's own session only.
 *   - A fork never writes handoff.md: its write there is refused, pointing
 *     at handoffs/<its session>.md, and a relaunch never reads that one.
 *   - Put off rotation until a time: not due before it, due after it.
 *
 * The hooks run as Claude Code runs them: the command line from the
 * agent's settings file, through /bin/sh, JSON on stdin.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GUARDRAILS_DIR,
  guardrailHooks,
  hookCommands,
} from "../../../src/shared/agents/guardrails.js";
import {
  deferRotation,
  dueFor,
  launchRotation,
  newestHandoff,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-rot-fork-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const OWN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FORK = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type Hooks = Record<
  string,
  { matcher?: string; hooks: { command: string }[] }[]
>;

let n = 0;
function agent(after = 3) {
  const files = path.join(root, `files-${++n}`);
  fs.mkdirSync(files, { recursive: true });
  // Den launched the agent on OWN.
  launchRotation(files, OWN, after);
  const hooks = guardrailHooks(
    GUARDRAILS_DIR,
    hookCommands(GUARDRAILS_DIR, process.execPath, { files, after }),
  ) as Hooks;
  const run = (command: string, input: unknown) => {
    const r = spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: root },
    });
    return r.stdout.trim();
  };
  const sh = (event: string, input: unknown) =>
    run(hooks[event][0].hooks[0].command, input);
  /** The PreToolUse hook that sees file writes (the rotation hook's). */
  const preToolWrite = (input: unknown) => {
    const h = hooks.PreToolUse.find((x) => /Write/.test(x.matcher ?? ""));
    expect(h).toBeDefined();
    return run(h!.hooks[0].command, input);
  };
  const common = (session: string, extra: Record<string, unknown> = {}) => ({
    session_id: session,
    transcript_path: path.join(root, `${session}.jsonl`),
    cwd: root,
    ...extra,
  });
  const compact = (session = OWN, extra: Record<string, unknown> = {}) => {
    const pre = sh("PreCompact", {
      ...common(session, extra),
      hook_event_name: "PreCompact",
      trigger: "auto",
      custom_instructions: null,
    });
    const start = sh("SessionStart", {
      ...common(session, extra),
      hook_event_name: "SessionStart",
      source: "compact",
    });
    return { pre, start };
  };
  const stop = (session = OWN, extra: Record<string, unknown> = {}) =>
    sh("Stop", {
      ...common(session, extra),
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Done for now.",
    });
  return { files, hooks, sh, compact, stop, preToolWrite, common };
}

describe("a fork's compactions (issue 765)", () => {
  it("another session in the same folder leaves the agent's count unchanged", () => {
    const a = agent();
    a.compact();
    a.compact();
    for (let i = 0; i < 5; i++) {
      const r = a.compact(FORK);
      expect(r.pre).toBe("");
      expect(r.start).toBe("");
    }
    expect(readRotation(a.files)).toMatchObject({
      conversation: OWN,
      compactions: 2,
    });
    expect(readRotation(a.files)?.due).toBeUndefined();
    // The agent's own third compaction is still the one that makes it due.
    a.compact();
    expect(readRotation(a.files)).toMatchObject({
      compactions: 3,
      due: "compactions",
    });
  });

  it("a sub-agent's input (agent_id, or a transcript under subagents/) is never counted", () => {
    const a = agent();
    a.compact(OWN, { agent_id: "a1b2c3", agent_type: "fork" });
    a.compact(OWN, {
      transcript_path: path.join(root, OWN, "subagents", "agent-a1b2c3.jsonl"),
    });
    expect(readRotation(a.files)?.compactions).toBe(0);
    a.compact();
    expect(readRotation(a.files)?.compactions).toBe(1);
  });
});

describe("the rotation notice goes to the agent's own session only", () => {
  function due() {
    const a = agent();
    for (let i = 0; i < 3; i++) a.compact();
    return a;
  }

  it("Stop and SessionStart say nothing to a fork; the agent's own session is asked", () => {
    const a = due();
    expect(a.stop(FORK)).toBe("");
    expect(a.stop(OWN, { agent_id: "a1b2c3" })).toBe("");
    expect(
      a.sh("SessionStart", {
        ...a.common(FORK),
        hook_event_name: "SessionStart",
        source: "resume",
      }),
    ).toBe("");
    expect(a.compact(FORK).pre).toBe("");
    const o = JSON.parse(a.stop()) as { decision: string; reason: string };
    expect(o.decision).toBe("block");
    expect(o.reason).toContain(path.join(a.files, "handoff.md"));
  });
});

describe("a fork's handoff never replaces handoff.md", () => {
  const write = (session: string, file: string, extra = {}) => ({
    session_id: session,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: file, content: GOOD_HANDOFF },
    ...extra,
  });

  it("a fork's write to handoff.md is refused, naming handoffs/<session>.md", () => {
    const a = agent();
    const out = a.preToolWrite(write(FORK, path.join(a.files, "handoff.md")));
    const o = JSON.parse(out) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(o.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(o.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(o.hookSpecificOutput.permissionDecisionReason).toContain(
      path.join(a.files, "handoffs", `${FORK}.md`),
    );
    // A sub-agent's Edit too.
    expect(
      a.preToolWrite({
        ...write(OWN, path.join(a.files, "handoff.md"), {
          agent_id: "a1b2c3",
        }),
        tool_name: "Edit",
      }),
    ).toMatch(/"deny"/);
  });

  it("the agent's own write, and a fork's write to its own file, go ahead", () => {
    const a = agent();
    expect(a.preToolWrite(write(OWN, path.join(a.files, "handoff.md")))).toBe(
      "",
    );
    expect(
      a.preToolWrite(write(FORK, path.join(a.files, "handoffs", `${FORK}.md`))),
    ).toBe("");
  });

  it("a relaunch never takes a fork's handoff for the agent's", () => {
    const a = agent();
    fs.mkdirSync(path.join(a.files, "handoffs"), { recursive: true });
    fs.writeFileSync(
      path.join(a.files, "handoffs", `${FORK}.md`),
      GOOD_HANDOFF,
    );
    expect(newestHandoff(a.files)).toBeNull();
  });
});

describe("put off rotation until a time", () => {
  it("a deferred agent isn't due before its time, and is due after it", () => {
    const a = agent();
    for (let i = 0; i < 3; i++) a.compact();
    const now = new Date();
    const until = new Date(now.getTime() + 3_600_000);
    deferRotation(a.files, until);
    expect(readRotation(a.files)?.deferUntil).toBe(until.toISOString());
    expect(dueFor(readRotation(a.files), OWN, now)).toBeUndefined();
    // The hooks say nothing while it is put off.
    expect(a.stop()).toBe("");
    expect(
      dueFor(readRotation(a.files), OWN, new Date(until.getTime() + 1)),
    ).toBe("compactions");
    // Its time came: the normal rule applies again.
    deferRotation(a.files, new Date(now.getTime() - 1000));
    expect(JSON.parse(a.stop()).decision).toBe("block");
    // Cleared.
    deferRotation(a.files, null);
    expect(readRotation(a.files)?.deferUntil).toBeUndefined();
  });

  it("a new conversation drops it; a resume of the same one keeps it", () => {
    const a = agent();
    const until = new Date(Date.now() + 3_600_000);
    deferRotation(a.files, until);
    launchRotation(a.files, OWN, 3);
    expect(readRotation(a.files)?.deferUntil).toBe(until.toISOString());
    launchRotation(a.files, FORK, 3);
    expect(readRotation(a.files)?.deferUntil).toBeUndefined();
  });
});
