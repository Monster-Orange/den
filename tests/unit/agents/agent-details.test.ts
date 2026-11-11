/**
 * D45: a stopped agent's details beyond its row (agentDetails, GET
 * .../agents/:id/details): what a person last asked it, by D39's turn
 * rules, and how its session ended (exit code, last line, redacted). A rig
 * (a scripted PTY, nothing runs); Claude Code's files under the rig's own
 * config dir, never this machine's. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { lastPrompt } from "../../../src/shared/agents/conversations.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentDetails,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({
    type: "user",
    timestamp: "2026-11-01T10:00:00.000Z",
    message: { role: "user", content },
    ...extra,
  });
const answer = line({
  type: "assistant",
  message: { role: "assistant", stop_reason: "end_turn", content: [] },
});

/** A started agent whose conversation's transcript is `body`. */
async function started(r: Rig, body: string, id = "planner"): Promise<void> {
  expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
  const sid = (record(r, id).session as { id: string }).id;
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(sid, Buffer.from("plan the release\r"));
  await settle();
  c.close();
  const token = record(r, id).resumeToken as string;
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${token}.jsonl`), body);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

describe("lastPrompt (D45)", () => {
  it("is the last ask a person typed: never a summary, a `!`, a tool result or a command", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-lp-"));
    try {
      const f = path.join(dir, "t.jsonl");
      fs.writeFileSync(
        f,
        user("Write the north\nreport") +
          answer +
          user("This session is being continued", {
            isCompactSummary: true,
            isVisibleInTranscriptOnly: true,
          }) +
          user("<bash-input>ls</bash-input>") +
          user([{ type: "tool_result", content: "ok" }]) +
          user("<command-name>/cost</command-name>"),
      );
      expect(lastPrompt(f)).toEqual({
        text: "Write the north report",
        at: "2026-11-01T10:00:00.000Z",
      });
      fs.writeFileSync(f, answer);
      expect(lastPrompt(f)).toBeNull();
      expect(lastPrompt(null)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agentDetails (D45)", () => {
  it("a session that ended on its own: its last ask, exit code and last line, secrets redacted", async () => {
    const r = await rig();
    await started(r, user("Ship the release notes") + answer);
    r.made[0].emit(
      "working\r\n\u001b[31mError: token ghp_" +
        "a".repeat(36) +
        " refused\u001b[0m\r\n",
    );
    r.made[0].exit(3);
    await settle();
    const d = await agentDetails(resolveAgentsDeps(r.deps), "planner", "north");
    expect(d).toMatchObject({
      agent: "planner",
      workspace: "north",
      lastPrompt: { text: "Ship the release notes" },
      exitCode: 3,
    });
    expect(d.lastLine).toMatch(/^Error: token .* refused$/);
    expect(d.lastLine).not.toContain("a".repeat(36));
  });

  it("no transcript yet, and no session host: no ask, no session facts, no error", async () => {
    const r = await rig();
    await started(r, "{}\n");
    const deps = resolveAgentsDeps(r.deps);
    const d = await agentDetails(
      { ...deps, connectExisting: async () => null },
      "planner",
      "north",
    );
    expect(d).toEqual({
      agent: "planner",
      workspace: "north",
      lastPrompt: null,
    });
  });
});
