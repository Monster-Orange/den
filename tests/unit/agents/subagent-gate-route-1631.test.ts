import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const dir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-sub-route-")),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 1631: a subagent's heavy run goes through the gate too", () => {
  it("a Bash call from a subagent (agent_id, agent_type) is rewritten to gate run", () => {
    const r = spawnSync(
      process.execPath,
      [
        HOOK,
        "--gate",
        "/opt/den/bin/den",
        "--gate-settings",
        path.join(dir, "settings.json"),
      ],
      {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "npx jest a.test.ts" },
          cwd: dir,
          agent_id: "a1b2c3",
          agent_type: "general-purpose",
        }),
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      },
    );
    expect(r.status).toBe(0);
    const u = JSON.parse(r.stdout).hookSpecificOutput.updatedInput;
    expect(u.command).toMatch(/^\/opt\/den\/bin\/den gate run --kind cpu -- /);
  });
});
