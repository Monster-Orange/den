/**
 * Session rotation (den#4), its hooks and its handoff check:
 *
 *   - PreCompact (rotation-hook.ts) counts each compaction of the agent's
 *     conversation in its files dir; at agents.rotate.after_compactions
 *     (default 3) a rotation is due, and its stdout (the compaction
 *     summary's instructions) asks for the handoff. Its input is Claude
 *     Code's documented shape: the common fields, `trigger`,
 *     `custom_instructions`; anything else is tolerated.
 *   - SessionStart (compact, resume) adds the instruction to the context
 *     while a rotation is due and handoff.md is not ready.
 *   - Stop blocks once while handoff.md is missing or fails the check.
 *   - handoff.md has Objective, State, Open items, How to QA and Next step,
 *     each filled in, every ID explained; `agents handoff-check` runs it.
 *   - agents.rotate: after_compactions and standing (default true);
 *     standing: false keeps standing personas from rotating.
 *
 * The hooks run as Claude Code runs them: the command line from the
 * agent's settings file, through /bin/sh, JSON on stdin. Nothing real runs.
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
import { checkHandoff } from "../../../src/shared/agents/handoff.js";
import { loadPersonas } from "../../../src/shared/agents/personas.js";
import {
  DEFAULT_ROTATE,
  readRotation,
  rotateAfter,
} from "../../../src/shared/agents/rotation.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-rot-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let n = 0;
function agent(after = 3) {
  const files = path.join(root, `files-${++n}`);
  const hooks = guardrailHooks(
    GUARDRAILS_DIR,
    hookCommands(GUARDRAILS_DIR, process.execPath, { files, after }),
  ) as Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  const sh = (event: string, input: unknown) => {
    const r = spawnSync("/bin/sh", ["-c", hooks[event][0].hooks[0].command], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: root },
    });
    return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
  };
  const compact = (trigger = "auto", session = CONV) =>
    sh("PreCompact", {
      session_id: session,
      transcript_path: path.join(root, `${session}.jsonl`),
      cwd: root,
      hook_event_name: "PreCompact",
      trigger,
      custom_instructions: null,
    });
  return { files, hooks, sh, compact };
}

describe("the PreCompact hook", () => {
  it("is in the agent's settings for every compaction, and SessionStart for compact and resume", () => {
    const { hooks, files } = agent();
    expect(hooks.PreCompact[0].matcher).toBeUndefined();
    expect(hooks.PreCompact[0].hooks[0].command).toContain("rotation-hook");
    expect(hooks.PreCompact[0].hooks[0].command).toContain(files);
    expect(hooks.SessionStart[0].matcher).toBe("compact|resume");
    expect(hooks.Stop[0].hooks[0].command).toMatch(/--files .+ --after 3/);
  });

  it("counts compactions of the conversation, and a rotation is due at the third", () => {
    const a = agent();
    let r = a.compact("manual");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(readRotation(a.files)).toMatchObject({
      conversation: CONV,
      compactions: 1,
      after: 3,
      lastTrigger: "manual",
    });
    expect(a.compact().stdout).toBe("");
    r = a.compact();
    expect(readRotation(a.files)).toMatchObject({
      compactions: 3,
      due: "compactions",
    });
    // Its stdout is the summary's instructions: keep the handoff ask.
    expect(r.stdout).toMatch(/compacted 3 times/);
    expect(r.stdout).toContain(path.join(a.files, "handoff.md"));
    expect(r.stdout).toMatch(/## Objective, ## State, ## Open items/);
    expect(r.stdout.length).toBeLessThan(10_000);
    expect(fs.statSync(path.join(a.files, "rotation.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("starts the count again for another conversation", () => {
    const a = agent();
    a.compact();
    a.compact();
    a.compact("auto", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(readRotation(a.files)).toMatchObject({
      conversation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      compactions: 1,
    });
  });

  it("is tolerant: no session id or event name still counts; bad JSON is ignored", () => {
    const a = agent();
    expect(a.sh("PreCompact", { trigger: "auto" }).status).toBe(0);
    expect(readRotation(a.files)?.compactions).toBe(1);
    const r = spawnSync(
      "/bin/sh",
      ["-c", a.hooks.PreCompact[0].hooks[0].command],
      { input: "not json", encoding: "utf-8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("never rotates with --after 0 (a standing persona when agents.rotate.standing is false)", () => {
    const a = agent(0);
    for (let i = 0; i < 5; i++) expect(a.compact().stdout).toBe("");
    expect(readRotation(a.files)).toMatchObject({ compactions: 5, after: 0 });
    expect(readRotation(a.files)?.due).toBeUndefined();
  });
});

describe("SessionStart and Stop while a rotation is due", () => {
  function due() {
    const a = agent();
    for (let i = 0; i < 3; i++) a.compact();
    return a;
  }

  it("SessionStart after the compaction adds the instruction to Claude's context", () => {
    const a = due();
    const r = a.sh("SessionStart", {
      session_id: CONV,
      hook_event_name: "SessionStart",
      source: "compact",
    });
    const o = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(o.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(o.hookSpecificOutput.additionalContext).toMatch(
      /Write your handoff now/,
    );
    // A new session, or a startup, gets nothing.
    expect(
      a.sh("SessionStart", {
        session_id: CONV,
        hook_event_name: "SessionStart",
        source: "startup",
      }).stdout,
    ).toBe("");
  });

  it("Stop blocks once with what to write; a failing handoff names its problems; a good one ends the turn", () => {
    const a = due();
    const stop = (active = false) =>
      a.sh("Stop", {
        session_id: CONV,
        hook_event_name: "Stop",
        stop_hook_active: active,
        last_assistant_message: "Done for now.",
      });
    let o = JSON.parse(stop().stdout) as { decision: string; reason: string };
    expect(o.decision).toBe("block");
    expect(o.reason).toMatch(/session is done, because it has compacted 3/);
    // Already continuing because of a stop hook: it never loops.
    expect(stop(true).stdout).toBe("");

    fs.writeFileSync(path.join(a.files, "handoff.md"), "## Objective\nShip.\n");
    o = JSON.parse(stop().stdout) as { decision: string; reason: string };
    expect(o.reason).toMatch(/Missing "## State"/);

    fs.writeFileSync(path.join(a.files, "handoff.md"), GOOD_HANDOFF);
    expect(stop().stdout).toBe("");
    // SessionStart has nothing more to say once the handoff is ready.
    expect(
      a.sh("SessionStart", {
        session_id: CONV,
        hook_event_name: "SessionStart",
        source: "resume",
      }).stdout,
    ).toBe("");
  });

  it("Stop does nothing for rotation before one is due", () => {
    const a = agent();
    a.compact();
    expect(
      a.sh("Stop", {
        session_id: CONV,
        stop_hook_active: false,
        last_assistant_message: "Done.",
      }).stdout,
    ).toBe("");
  });
});

describe("the handoff check", () => {
  it("passes a complete, plain handoff", () => {
    expect(checkHandoff(GOOD_HANDOFF)).toEqual({ ok: true, problems: [] });
  });

  it("names each missing or empty part", () => {
    const r = checkHandoff(
      "## Objective\nShip it.\n## State\n\n## How to QA\nClick Export.\n",
    );
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      '"## State" is empty. Fill it in.',
      'Missing "## Open items". Add it.',
      'Missing "## Next step". Add it.',
    ]);
  });

  it("takes `Label: text` lines too, and names an empty file", () => {
    expect(
      checkHandoff(
        "Objective: ship.\nState: done.\nOpen items: none.\nHow to QA: click.\nNext step: merge.\n",
      ).ok,
    ).toBe(true);
    expect(checkHandoff("").problems[0]).toMatch(/The handoff is empty/);
  });

  it("names a bare ID, and a handoff too long to be a first prompt", () => {
    const bare = GOOD_HANDOFF.replace(
      "Translate the CSV header.",
      "Fix AG-9 next.",
    );
    expect(checkHandoff(bare).problems).toEqual([
      '"AG-9" is not explained. Say what it is, e.g. "AG-9 (what it is)".',
    ]);
    const long = `${GOOD_HANDOFF}\n${"word ".repeat(5000)}`;
    expect(checkHandoff(long).problems[0]).toMatch(/Keep it under 20000/);
  });

  it("`agents handoff-check <file|->` exits 0 when ready, 1 with each problem", async () => {
    const f = path.join(root, "handoff.md");
    fs.writeFileSync(f, GOOD_HANDOFF);
    const out: string[] = [];
    const deps = {
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
    } as never;
    expect(await cmdAgents(["handoff-check", f], deps)).toBe(0);
    expect(out).toEqual(["✓ the handoff is complete and plain"]);
    out.length = 0;
    const bad = path.join(root, "bad.md");
    fs.writeFileSync(bad, "## Objective\nShip it.\n");
    expect(await cmdAgents(["handoff-check", bad], deps)).toBe(1);
    expect(out[0]).toBe("✗ the handoff is not ready:");
    expect(out).toContain('  - Missing "## Next step". Add it.');
    out.length = 0;
    expect(
      await cmdAgents(["handoff-check", "-", "--json"], {
        ...(deps as object),
        readHandback: async () => GOOD_HANDOFF,
      } as never),
    ).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ ok: true, problems: [] });
  });
});

describe("agents.rotate", () => {
  const cfg = (agents: unknown) =>
    readAgentsConfig({ environments: [], agents } as never);

  it("defaults to 3 compactions, standing personas included", () => {
    expect(cfg({}).rotate).toEqual({ afterCompactions: 3, standing: true });
    expect(DEFAULT_ROTATE).toEqual({ afterCompactions: 3, standing: true });
  });

  it("reads after_compactions and standing, and refuses a typo or a bad value", () => {
    expect(
      cfg({ rotate: { after_compactions: 5, standing: false } }).rotate,
    ).toEqual({
      afterCompactions: 5,
      standing: false,
    });
    expect(() => cfg({ rotate: { after_compactions: 0 } })).toThrow(
      /agents\.rotate\.after_compactions: must be a whole number from 1 to 100/,
    );
    expect(() => cfg({ rotate: { standing: "no" } })).toThrow(
      /agents\.rotate\.standing: must be true or false/,
    );
    expect(() => cfg({ rotate: { afterCompactions: 2 } })).toThrow(
      /agents\.rotate\.afterCompactions: unknown key/,
    );
  });

  it("standing: false keeps standing personas (planner) from rotating; others still do", () => {
    const all = loadPersonas([]);
    const planner = all.get("planner")!;
    const dev = all.get("be-dev")!;
    expect(planner.standing).toBe(true);
    const off = { afterCompactions: 3, standing: false };
    expect(rotateAfter(off, planner)).toBe(0);
    expect(rotateAfter(off, dev)).toBe(3);
    expect(rotateAfter(DEFAULT_ROTATE, planner)).toBe(3);
  });
});
