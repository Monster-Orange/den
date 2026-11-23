/**
 * Issue 1326: inside the agent sandbox, a setuid program (ps, top, sudo)
 * can't start and Docker's socket is refused. Both are the sandbox working
 * as designed; the refusal note says so, and what to use instead, rather
 * than the state note (or nothing).
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "@jest/globals";
import {
  REFUSAL_NOTE,
  refusalNote,
} from "../../../src/shared/agents/guardrails/sandbox-refusal.js";

const IN = { DEN_AGENT_SANDBOX: "1" } as NodeJS.ProcessEnv;

/** The note a failed Bash call with `error` gets inside the sandbox. */
const noteFor = (error: string, env = IN) =>
  refusalNote(
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", error },
    env,
  )?.hookSpecificOutput.additionalContext ?? null;

describe("issue 1326: setuid programs in the sandbox", () => {
  // As zsh and bash print it when exec is refused.
  it.each([
    ["ps", "(eval):1: operation not permitted: ps"],
    ["top", "zsh:1: operation not permitted: top"],
    ["ps", "bash: /bin/ps: Operation not permitted"],
    ["ps", "bash: line 1: /bin/ps: Operation not permitted"],
  ])(
    "%s: says why, and to use pgrep/pkill or Den's status tools",
    (prog, error) => {
      const note = noteFor(error);
      expect(note).not.toBe(REFUSAL_NOTE);
      expect(note).toContain(`\`${prog}\``);
      expect(note).toMatch(/setuid/);
      expect(note).toMatch(/pgrep/);
      expect(note).toMatch(/pkill/);
      expect(note).toMatch(/status/);
    },
  );

  it("sudo: refused on purpose; an agent asks its person", () => {
    const note = noteFor("(eval):1: operation not permitted: sudo")!;
    expect(note).toContain("`sudo`");
    expect(note).toMatch(/on purpose/);
    expect(note).toMatch(/person/);
    expect(note).not.toMatch(/pgrep/);
  });

  it("a refused write through the shell (same words as a program it couldn't start) keeps the state note", () => {
    for (const e of [
      "sh: /home/x/.den/agents/a1.json: Operation not permitted",
      "zsh:1: operation not permitted: out.txt",
      "bash: line 1: /state/web.json: Operation not permitted",
    ])
      expect(noteFor(e)).toBe(REFUSAL_NOTE);
  });

  it("a refused write keeps the state note", () => {
    expect(
      noteFor("touch: /state/agents/x.json: Operation not permitted"),
    ).toBe(REFUSAL_NOTE);
    expect(
      noteFor("EPERM: operation not permitted, open '/state/agents/x.json'"),
    ).toBe(REFUSAL_NOTE);
  });
});

describe("issue 1326: Docker in the sandbox", () => {
  it.each([
    "permission denied while trying to connect to the docker API at unix:///home/me/.docker/run/docker.sock",
    'Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.24/containers/json": dial unix /var/run/docker.sock: connect: permission denied',
  ])(
    "says outside daemons' sockets are refused, and the person can turn the agent's sandbox off",
    (error) => {
      const note = noteFor(error)!;
      expect(note).toMatch(/Docker/);
      expect(note).toMatch(/daemons' sockets/);
      // The remedy only with its cost: no sandbox lifts every limit.
      expect(note).toMatch(/without its sandbox/);
      expect(note).toMatch(/full control of the machine/);
      expect(note).toMatch(/every other limit/);
      expect(note).toMatch(/person/);
      // Never the install-wide socket list.
      expect(note).not.toMatch(/sandbox_sockets/);
    },
  );

  it("outside the sandbox: nothing", () => {
    expect(
      noteFor(
        "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
        {} as NodeJS.ProcessEnv,
      ),
    ).toBeNull();
  });
});

describe("issue 1326: a file tool that succeeded is no refusal", () => {
  it.each(["Write", "Edit", "MultiEdit", "Read", "NotebookEdit"])(
    "%s whose content names the error: nothing",
    (tool) => {
      expect(
        refusalNote(
          {
            hook_event_name: "PostToolUse",
            tool_name: tool,
            tool_response: {
              filePath: "/w/t.test.ts",
              content: "expect(e).toMatch(/Operation not permitted/)",
            },
          },
          IN,
        ),
      ).toBeNull();
    },
  );

  it("a refused Write (it failed) still gets the state note", () => {
    expect(
      refusalNote(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Write",
          error: "EPERM: operation not permitted, open '/state/agents/x.json'",
        },
        IN,
      )?.hookSpecificOutput.additionalContext,
    ).toBe(REFUSAL_NOTE);
  });
});

describe("issue 1326: the rules and the docs", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, "../../..", rel), "utf8");

  it("the agent rules say setuid programs and Docker are refused by the sandbox, and what to use", () => {
    const text = read("src/shared/agents/guardrails/instructions.md");
    expect(text).toMatch(/`ps`[^\n]*`sudo`[^.]*sandbox/);
    expect(text).toMatch(/pgrep/);
    expect(text).toMatch(/Docker/);
  });

  it("the docs say sudo is refused inside a session on purpose", () => {
    expect(read("docs/distributions.md")).toMatch(
      /`sudo`[^.]*refused[^.]*on purpose/,
    );
  });
});
