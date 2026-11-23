/**
 * Issues 1036 and 1026: a run started inside a Den install (an agent's
 * session, or a gate run) inherited that install's markers: DEN_ROOT,
 * DEN_ENGINE_ROOT and DEN_INVOKE_CWD. A test's in-process session host then
 * hashed the running install's code, not this checkout's, so every test
 * server restarted its terminal host and the bell gained a row no test
 * seeded; gate-command named the running install. CI sets none of them.
 * Jest's global setup now removes them before any worker starts, so a
 * local run sees what CI sees.
 */
import { beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

type M = typeof import("../../install-env.js");
let INSTALL_ENV: M["INSTALL_ENV"];
let stripInstallEnv: M["stripInstallEnv"];
beforeAll(async () => {
  ({ INSTALL_ENV, stripInstallEnv } = await import("../../install-env.js"));
});

describe("the running install's markers (issues 1036, 1026)", () => {
  it("are removed, and named", () => {
    const env: NodeJS.ProcessEnv = {
      DEN_ROOT: "/elsewhere/dist",
      DEN_ENGINE_ROOT: "/elsewhere/node_modules/den",
      DEN_INVOKE_CWD: "/elsewhere",
      DEN_HOME: "/kept",
      PATH: "/usr/bin",
    };
    expect(stripInstallEnv(env)).toEqual([
      "DEN_ROOT",
      "DEN_ENGINE_ROOT",
      "DEN_INVOKE_CWD",
    ]);
    expect(env).toEqual({ DEN_HOME: "/kept", PATH: "/usr/bin" });
  });

  it("none set: nothing removed", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(stripInstallEnv(env)).toEqual([]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("are the three a launcher sets", () => {
    expect([...INSTALL_ENV]).toEqual([
      "DEN_ROOT",
      "DEN_ENGINE_ROOT",
      "DEN_INVOKE_CWD",
    ]);
  });

  it("no test worker has them", () => {
    for (const n of INSTALL_ENV) expect(process.env[n]).toBeUndefined();
  });

  it("Jest's global setup removes them before any worker starts", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "tests/global-setup.mjs"),
      "utf-8",
    );
    expect(src).toMatch(
      /import \{ stripInstallEnv \} from "\.\/install-env\.js"/,
    );
    expect(src).toMatch(/stripInstallEnv\(process\.env\)/);
  });
});
