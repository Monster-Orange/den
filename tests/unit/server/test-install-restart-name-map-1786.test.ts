import { describe, expect, it } from "@jest/globals";
import { getProfile } from "../../../src/shared/paths.js";
import { envName } from "../../../src/shared/profile.js";
import {
  takeTestInstallLaunchFlag,
  takeTestResolveLaunch,
  testInstallRestartEnv,
} from "../../../src/shared/test-install-launch.js";
import { webRestartEnv } from "../../../src/ui/cli/web-command.js";

const FLAG = envName(getProfile(), "TEST_INSTALL");
const MAP = envName(getProfile(), "TEST_RESOLVE");
const RAW = "den.test=127.0.0.1";

function boot(env: NodeJS.ProcessEnv): string | undefined {
  takeTestInstallLaunchFlag(getProfile(), env);
  return takeTestResolveLaunch(getProfile(), env);
}

describe("a test install's restart keeps its name map (issue 1786)", () => {
  it("a test install launched with a map: its restart gets the mark and the map", () => {
    const env: NodeJS.ProcessEnv = { [FLAG]: "1", [MAP]: RAW, HOME: "/h" };
    expect(boot(env)).toBe(RAW);
    expect(testInstallRestartEnv()).toEqual({ [FLAG]: "1", [MAP]: RAW });
    const r = webRestartEnv(7000, env);
    expect(r[FLAG]).toBe("1");
    expect(r[MAP]).toBe(RAW);
  });

  it("a normal install launched with a map: its restart gains neither", () => {
    const env: NodeJS.ProcessEnv = { [MAP]: RAW, HOME: "/h" };
    expect(boot(env)).toBe(RAW);
    expect(testInstallRestartEnv()).toEqual({});
    const r = webRestartEnv(7000, env);
    expect(r[FLAG]).toBeUndefined();
    expect(r[MAP]).toBeUndefined();
  });

  it("a normal install with no map: nothing to hand on", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/h" };
    expect(boot(env)).toBeUndefined();
    expect(testInstallRestartEnv()).toEqual({});
  });

  it("a test install with no map: its restart gets only the mark", () => {
    const env: NodeJS.ProcessEnv = { [FLAG]: "1" };
    expect(boot(env)).toBeUndefined();
    expect(testInstallRestartEnv()).toEqual({ [FLAG]: "1" });
  });

  it("both leave the server's own environment, so agents and terminals never inherit them", () => {
    const env: NodeJS.ProcessEnv = { [FLAG]: "1", [MAP]: RAW, HOME: "/h" };
    boot(env);
    expect(env[FLAG]).toBeUndefined();
    expect(env[MAP]).toBeUndefined();
    expect(env.HOME).toBe("/h");
  });
});
