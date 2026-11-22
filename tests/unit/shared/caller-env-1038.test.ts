/**
 * Issue 1038: callerEnv gives a command Den runs for its caller (gate run)
 * the caller's own install markers, as bin/den recorded them before any
 * launcher set its own.
 */
import { describe, expect, it } from "@jest/globals";
import { CALLER_ENV_SET, callerEnv } from "../../../src/shared/caller-env.js";

describe("callerEnv (issue 1038)", () => {
  it("recorded with none set: the command gets none of the three", () => {
    const env = {
      [CALLER_ENV_SET]: "1",
      DEN_ROOT: "/dist",
      DEN_ENGINE_ROOT: "/dist/node_modules/den",
      DEN_INVOKE_CWD: "/dist",
      PATH: "/usr/bin",
    };
    expect(callerEnv(env)).toEqual({ PATH: "/usr/bin" });
    // The CLI's own environment is untouched.
    expect(env.DEN_ROOT).toBe("/dist");
  });

  it("recorded values come back, and the record goes", () => {
    expect(
      callerEnv({
        [CALLER_ENV_SET]: "1",
        DEN_CALLER_ROOT: "/mine",
        DEN_CALLER_INVOKE_CWD: "/here",
        DEN_ROOT: "/dist",
        DEN_ENGINE_ROOT: "/dist/node_modules/den",
        DEN_INVOKE_CWD: "/dist",
        X: "y",
      }),
    ).toEqual({ DEN_ROOT: "/mine", DEN_INVOKE_CWD: "/here", X: "y" });
  });

  it("no record (no launcher ran): the environment is the caller's, as it is", () => {
    const env = { DEN_ROOT: "/mine", PATH: "/usr/bin" };
    expect(callerEnv(env)).toEqual(env);
  });
});
