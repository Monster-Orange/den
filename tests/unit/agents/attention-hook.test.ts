/**
 * NT-1: Claude Code's Notification and Stop hooks tell Den an agent needs
 * its person (attention-hook.ts), and every agent gets them at launch,
 * beside Den's other hooks, whatever its persona. Never a token in its
 * files. A fake fetch; no real runtime runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  attentionOf,
  sendAttention,
} from "../../../src/shared/agents/guardrails/attention-hook.js";
import { loadPersonas } from "../../../src/shared/agents/personas.js";
import { getRuntime } from "../../../src/shared/agents/runtimes.js";
import type { LaunchInput } from "../../../src/shared/agents/runtime.js";

let root = "";
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "den-atth-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("what the hook tells Den", () => {
  it("a permission prompt, waiting for input, the turn's end", () => {
    expect(
      attentionOf({
        hook_event_name: "Notification",
        message: "Claude needs your permission to use Bash",
      }),
    ).toEqual({
      event: "waiting",
      why: "permission",
      text: "Claude needs your permission to use Bash",
      hooked: true,
    });
    expect(
      attentionOf({
        hook_event_name: "Notification",
        message: "Claude is waiting for your input",
      }),
    ).toMatchObject({ event: "waiting", why: "input" });
    expect(attentionOf({ hook_event_name: "Stop" })).toEqual({
      event: "finished",
      text: "",
      hooked: true,
    });
    // A Stop another Stop hook kept going is not the turn's end.
    expect(
      attentionOf({ hook_event_name: "Stop", stop_hook_active: true }),
    ).toBeNull();
    // PreToolUse comes before the permission check: it never clears one.
    expect(attentionOf({ hook_event_name: "PreToolUse" })).toBeNull();
    expect(attentionOf("x")).toBeNull();
  });

  it("the 0.4.41 gate: a permission dialog (any tool) marks it; a tool run or a prompt says it went on", () => {
    expect(
      attentionOf({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    ).toEqual({
      event: "waiting",
      why: "permission",
      text: "Claude needs your permission to use Bash",
      hooked: true,
    });
    expect(attentionOf({ hook_event_name: "PostToolUse" })).toEqual({
      event: "resumed",
      from: "tool",
      hooked: true,
    });
    expect(attentionOf({ hook_event_name: "UserPromptSubmit" })).toEqual({
      event: "resumed",
      from: "prompt",
      hooked: true,
    });
  });

  it("posts to Den with the agent's own token; no token, no call; a failure is quiet", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    };
    expect(
      await sendAttention(
        "http://localhost:4100/",
        { event: "finished", text: "" },
        { env: { DEN_ACTOR_TOKEN: "den_at_TESTONLY" }, fetch: f },
      ),
    ).toBe(true);
    expect(calls[0].url).toBe(
      "http://localhost:4100/api/agents/self/attention",
    );
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer den_at_TESTONLY");
    expect(
      await sendAttention(
        "http://localhost:4100",
        { event: "finished", text: "" },
        { env: {}, fetch: f },
      ),
    ).toBe(false);
    expect(calls).toHaveLength(1);
    expect(
      await sendAttention(
        "http://localhost:4100",
        { event: "finished", text: "" },
        {
          env: { DEN_ACTOR_TOKEN: "den_at_TESTONLY" },
          fetch: async () => {
            throw new Error("refused");
          },
        },
      ),
    ).toBe(false);
  });
});

describe("at launch", () => {
  function launch(persona = loadPersonas([]).get("planner")!) {
    const inp: LaunchInput = {
      persona,
      workspace: { name: "north", dir: root },
      agentId: persona.id,
      worktree: root,
      mcp: {
        name: "acme",
        command: ["/x/acme", "mcp"],
        env: {},
        scope: "north",
      },
      filesDir: path.join(root, "files", persona.id),
      stateDir: path.join(root, "state"),
      env: {},
      bin: "/nowhere/claude",
      attention: { base: "http://localhost:4100" },
    };
    const out = getRuntime("den-claude")!.launch(inp);
    return JSON.parse(out.files![path.join(inp.filesDir, "settings.json")]) as {
      hooks?: Record<string, { hooks: { command: string }[] }[]>;
    };
  }

  it("Notification and Stop post to Den, beside Den's own Stop hook", () => {
    const { hooks } = launch();
    const n = hooks!.Notification.map((e) => e.hooks[0].command);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatch(/attention-hook\.[jt]s/);
    expect(n[0]).toContain("--den http://localhost:4100");
    const stops = hooks!.Stop.map((e) => e.hooks[0].command);
    expect(stops.some((c) => /stop-hook\.[jt]s/.test(c))).toBe(true);
    expect(stops.some((c) => /attention-hook\.[jt]s/.test(c))).toBe(true);
    expect(JSON.stringify(hooks)).not.toMatch(/den_at_/);
  });

  it("a persona without Den's hooks still gets them", () => {
    const dir = path.join(root, "pack");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "quiet.md"),
      "---\nname: quiet\nden_hooks: false\n---\nYou plan.\n",
    );
    const { hooks } = launch(loadPersonas([dir]).get("quiet")!);
    expect(Object.keys(hooks!).sort()).toEqual([
      "Notification",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
  });
});
