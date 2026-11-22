/**
 * Issue 1038: the caller's install markers, as bin/den recorded them
 * before any launcher set its own. The record lasts one invocation: the
 * CLI takes it out of its environment as it starts (so nothing it starts,
 * a server, a session, the gate's own command, inherits it), and
 * callerEnv gives a command Den runs for its caller the values from that
 * in-memory record.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  CALLER_ENV_SET,
  callerEnv,
  takeCallerRecord,
} from "../../../src/shared/caller-env.js";

describe("takeCallerRecord (issue 1038)", () => {
  it("reads the record and removes it from the environment", () => {
    const env: NodeJS.ProcessEnv = {
      [CALLER_ENV_SET]: "1",
      DEN_CALLER_ROOT: "/mine",
      DEN_ROOT: "/dist",
      PATH: "/usr/bin",
    };
    expect(takeCallerRecord(env)).toEqual({
      DEN_ROOT: "/mine",
      DEN_ENGINE_ROOT: undefined,
      DEN_INVOKE_CWD: undefined,
    });
    expect(env).toEqual({ DEN_ROOT: "/dist", PATH: "/usr/bin" });
  });

  it("no record: null, and stray caller values are removed too", () => {
    const env: NodeJS.ProcessEnv = { DEN_CALLER_ROOT: "/stale", X: "y" };
    expect(takeCallerRecord(env)).toBeNull();
    expect(env).toEqual({ X: "y" });
  });
});

describe("callerEnv (issue 1038)", () => {
  const install = {
    DEN_ROOT: "/dist",
    DEN_ENGINE_ROOT: "/dist/node_modules/den",
    DEN_INVOKE_CWD: "/dist",
    PATH: "/usr/bin",
  };

  it("a record with none set: the command gets none of the three", () => {
    const rec = {
      DEN_ROOT: undefined,
      DEN_ENGINE_ROOT: undefined,
      DEN_INVOKE_CWD: undefined,
    };
    expect(callerEnv({ ...install }, rec)).toEqual({ PATH: "/usr/bin" });
  });

  it("recorded values come back", () => {
    const rec = {
      DEN_ROOT: "/mine",
      DEN_ENGINE_ROOT: undefined,
      DEN_INVOKE_CWD: "/here",
    };
    expect(callerEnv({ ...install }, rec)).toEqual({
      DEN_ROOT: "/mine",
      DEN_INVOKE_CWD: "/here",
      PATH: "/usr/bin",
    });
  });

  it("no record (no launcher ran): the environment as it is, minus any caller values", () => {
    expect(
      callerEnv({ DEN_ROOT: "/mine", DEN_CALLER_ROOT: "/stale" }, null),
    ).toEqual({ DEN_ROOT: "/mine" });
  });
});

describe("each CLI entry takes the record first (issue 1038)", () => {
  for (const entry of ["index.ts", "mcp-main.ts", "create-main.ts"])
    it(entry, () => {
      const src = fs.readFileSync(
        path.join(process.cwd(), "src/ui/cli", entry),
        "utf-8",
      );
      const first = src.match(/^import .*$/m)?.[0];
      expect(first).toBe('import "../../shared/caller-env-take.js";');
    });
});
