import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "dist-smoke.sh");

function smokeEnv(extra: NodeJS.ProcessEnv): Map<string, string> {
  const r = spawnSync("bash", [SCRIPT], {
    env: { ...process.env, ...extra, DIST_SMOKE_PRINT_ENV: "1" },
    encoding: "utf-8",
  });
  expect(r.status).toBe(0);
  const env = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env.set(line.slice(0, i), line.slice(i + 1));
  }
  return env;
}

describe("dist-smoke started from an agent's session (issue 1689)", () => {
  it("runs its install with none of the caller's Den or agent variables", () => {
    const env = smokeEnv({
      DEN_AGENT: "stand-in",
      DEN_ACTOR_TOKEN_FILE: "/nowhere/token",
      DEN_ROOT: "/nowhere/dist",
      DEN_WEB_URL: "https://stand-in.example.com",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "stand-in",
      ACME_HOME: "/nowhere/acme",
      SOME_TOKEN: "stand-in",
    });
    const leaked = [...env.keys()].filter((k) =>
      /^(DEN_|CLAUDE|ACME_)|TOKEN/.test(k),
    );
    expect(leaked).toEqual([]);
  });

  it("keeps what a run needs: PATH, HOME, the temp folder and its own switches", () => {
    const env = smokeEnv({
      TMPDIR: "/tmp/",
      RUNNER_TEMP: "/tmp/runner",
      CI: "true",
      DIST_SMOKE_OMIT_OPTIONAL: "1",
    });
    expect(env.get("PATH")).toBe(process.env.PATH);
    expect(env.get("HOME")).toBe(process.env.HOME);
    expect(env.get("TMPDIR")).toBe("/tmp/");
    expect(env.get("RUNNER_TEMP")).toBe("/tmp/runner");
    expect(env.get("CI")).toBe("true");
    expect(env.get("DIST_SMOKE_OMIT_OPTIONAL")).toBe("1");
  });
});
