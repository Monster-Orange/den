/**
 * Issue 832: Den's own restart of a test install keeps the test-install
 * mark. The server reads the launcher's flag once at boot and takes it out
 * of its own env (agents and terminals never inherit it); Den hands it back
 * only to the restart it starts itself.
 */
import { describe, expect, it } from "@jest/globals";
import { getProfile } from "../../../src/shared/paths.js";
import { envName } from "../../../src/shared/profile.js";
import {
  takeTestInstallLaunchFlag,
  testInstallRestartEnv,
} from "../../../src/shared/test-install-launch.js";
import { webRestartEnv } from "../../../src/ui/cli/web-command.js";

const FLAG = envName(getProfile(), "TEST_INSTALL");

describe("a test install's restart keeps its mark (issue 832)", () => {
  it("no flag at boot: nothing to hand on", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(takeTestInstallLaunchFlag(getProfile(), env)).toBe(false);
    expect(testInstallRestartEnv()).toEqual({});
    expect(webRestartEnv(7000, { HOME: "/h" })[FLAG]).toBeUndefined();
  });

  it("the flag at boot: taken out of the server's env, handed only to its restart", () => {
    const env: NodeJS.ProcessEnv = { [FLAG]: "1", HOME: "/h" };
    expect(takeTestInstallLaunchFlag(getProfile(), env)).toBe(true);
    // What agents and terminals inherit (the server's env) has no flag.
    expect(env[FLAG]).toBeUndefined();
    expect(testInstallRestartEnv()).toEqual({ [FLAG]: "1" });
    // The restart Den starts itself has it, with the port.
    const r = webRestartEnv(7000, env);
    expect(r[FLAG]).toBe("1");
    expect(r.PORT).toBe("7000");
    expect(r.HOME).toBe("/h");
    expect(env[FLAG]).toBeUndefined();
  });

  it("any other value is no flag", () => {
    const env: NodeJS.ProcessEnv = { [FLAG]: "yes" };
    expect(takeTestInstallLaunchFlag(getProfile(), env)).toBe(false);
    expect(env[FLAG]).toBeUndefined();
    expect(testInstallRestartEnv()).toEqual({});
  });
});
