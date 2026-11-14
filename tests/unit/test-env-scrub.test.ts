/**
 * No credential from the developer's shell reaches a test worker (and so
 * neither a failure diff nor a spawned child): tests/setup.ts scrubs them.
 * Fail-first: run with a fake token in the environment against a setup
 * file that does not scrub.
 */
import { describe, expect, it } from "@jest/globals";
import { isDenIdentityEnv, isSecretEnv, scrubSecretEnv } from "../scrub-env";

describe("test workers inherit no credentials", () => {
  it("process.env holds nothing credential-shaped by the time a suite runs", () => {
    const leaked = Object.entries(process.env)
      .filter(([k, v]) => isSecretEnv(k, v))
      .map(([k]) => k); // names only, never values
    expect(leaked).toEqual([]);
  });

  it("an agent session's identity never reaches a test: no test acts as a real agent", () => {
    // Run inside an agent's session, the suite inherits its markers; with
    // them a test's CLI call would carry that agent's identity to a live Den.
    expect(Object.keys(process.env).filter((k) => isDenIdentityEnv(k))).toEqual(
      [],
    );
    const env: NodeJS.ProcessEnv = {
      DEN_AGENT: "agent:planner",
      DEN_ACTOR_TOKEN: "x",
      DEN_ACTOR_TOKEN_FILE: "/tmp/agent-token",
      DEN_PERSON_TOKEN: "x",
      DEN_SESSION_ID: "s-1",
      DEN_AGENTS_SHOTS: "1",
      DEN_HOME: "/tmp/den",
    };
    scrubSecretEnv(env);
    expect(Object.keys(env).sort()).toEqual(["DEN_AGENTS_SHOTS", "DEN_HOME"]);
  });

  it("matches by name, by family and by token shape", () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: "x",
      OP_SERVICE_ACCOUNT_TOKEN: "x",
      CLAUDE_CODE_MESSAGING_TOKEN: "x",
      DOPPLER_CONFIG: "dev",
      github: `{"token":"ghp_${"a".repeat(36)}"}`,
      HOME: "/home/u",
      PATH: "/usr/bin",
      DEN_HOME: "/tmp/den",
    };
    expect(scrubSecretEnv(env).sort()).toEqual(
      [
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "DOPPLER_CONFIG",
        "GITHUB_TOKEN",
        "OP_SERVICE_ACCOUNT_TOKEN",
        "github",
      ].sort(),
    );
    expect(Object.keys(env).sort()).toEqual(["DEN_HOME", "HOME", "PATH"]);
  });
});
