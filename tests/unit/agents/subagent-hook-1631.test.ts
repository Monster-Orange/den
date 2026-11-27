import { afterEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { subagentDecision } from "../../../src/shared/agents/guardrails/subagent-hook.js";
import { SubagentGate } from "../../../src/shared/agents/subagent-gate.js";
import {
  SUBAGENT_START_PATH,
  handleSubagentStart,
} from "../../../src/ui/server/subagent-routes.js";
import {
  getRuntime,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";
import type { Persona } from "../../../src/shared/agents/personas.js";

const call = { timeoutMs: 2000, retries: 0, backoffMs: 1 };
const env = { DEN_ACTOR_TOKEN: "tok-abc" };

function fakeFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { f, seen };
}

describe("issue 1631: the Agent hook asks Den before a subagent starts", () => {
  it("an Agent call Den refuses is blocked with Den's words", async () => {
    const { f, seen } = fakeFetch(409, {
      ok: false,
      reason: "max_subagents",
      message:
        "Den's subagent limit is reached (8 of 8 running, agents.max_subagents); start fewer, or wait.",
    });
    const d = await subagentDecision(
      "http://den.test",
      { tool_name: "Agent", tool_input: { prompt: "x" } },
      { env, fetch: f, call },
    );
    expect(d).toEqual({
      block:
        "Den's subagent limit is reached (8 of 8 running, agents.max_subagents); start fewer, or wait.",
    });
    expect(seen[0]!.url).toBe(`http://den.test${SUBAGENT_START_PATH}`);
    expect(
      (seen[0]!.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer tok-abc");
  });

  it("an allowed one, another tool, or no token goes on without blocking", async () => {
    const ok = fakeFetch(200, { ok: true });
    expect(
      await subagentDecision(
        "http://den.test",
        { tool_name: "Task", tool_input: {} },
        { env, fetch: ok.f, call },
      ),
    ).toBeNull();
    const never = fakeFetch(409, { ok: false, message: "no" });
    expect(
      await subagentDecision(
        "http://den.test",
        { tool_name: "Bash", tool_input: { command: "ls" } },
        { env, fetch: never.f, call },
      ),
    ).toBeNull();
    expect(
      await subagentDecision(
        "http://den.test",
        { tool_name: "Agent", tool_input: {} },
        { env: {}, fetch: never.f, call },
      ),
    ).toBeNull();
    expect(never.seen).toHaveLength(0);
  });

  it("Den out of reach lets it start and says why", async () => {
    let why = "";
    const d = await subagentDecision(
      "http://den.test",
      { tool_name: "Agent", tool_input: {} },
      {
        env,
        fetch: async () => {
          throw new Error("down");
        },
        call,
        onMiss: (r) => (why = r),
      },
    );
    expect(d).toBeNull();
    expect(why).toBe("no answer");
  });

  it("a refusal's message is cut short and stripped of control characters", async () => {
    const { f } = fakeFetch(409, {
      ok: false,
      message: `a\u001b[2Jb${"x".repeat(900)}`,
    });
    const d = await subagentDecision(
      "http://den.test",
      { tool_name: "Agent", tool_input: {} },
      { env, fetch: f, call },
    );
    expect(d!.block.includes("\u001b")).toBe(false);
    expect(d!.block.length).toBeLessThanOrEqual(500);
  });
});

describe("issue 1631: Den's route decides, for an agent's own token only", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function serve(agent: string | null, gate: SubagentGate) {
    const s = http.createServer((req, res) => {
      void handleSubagentStart(req, res, {
        agentOf: () => agent,
        gate: async (id) => gate.decide(id),
      });
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as { port: number }).port;
    return (method = "POST") =>
      fetch(`http://127.0.0.1:${port}${SUBAGENT_START_PATH}`, { method });
  }

  const gateOf = (max: number) =>
    new SubagentGate({
      maxSubagents: () => max,
      respectLoadHold: () => true,
      loadCeiling: () => undefined,
      load1: () => 0,
      running: () => [],
    });

  it("a swarm's starts past agents.max_subagents get 409 with the setting's name", async () => {
    const post = await serve("swarmer", gateOf(2));
    const got = await Promise.all([post(), post(), post()]);
    expect(got.map((r) => r.status).sort()).toEqual([200, 200, 409]);
    const refused = got.find((r) => r.status === 409)!;
    expect(((await refused.json()) as { message: string }).message).toMatch(
      /agents\.max_subagents/,
    );
  });

  it("a person's token, or no token, is refused; only POST", async () => {
    expect((await (await serve(null, gateOf(2)))()).status).toBe(403);
    expect((await (await serve("a", gateOf(2)))("GET")).status).toBe(405);
  });
});

describe("issue 1631: every Claude Code agent gets the Agent hook", () => {
  it("its settings run the subagent hook before Agent and Task calls", () => {
    const state = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-hk-")),
    );
    try {
      const bin = path.join(state, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      const inp: LaunchInput = {
        persona: {
          id: "builder",
          prompt: "x",
          standing: false,
          tools: [],
          context: [],
          source: "/p.md",
        } as unknown as Persona,
        workspace: { name: "north", dir: "/w/north" },
        agentId: "builder",
        worktree: "/w/north",
        mcp: {
          name: "acme",
          command: ["/dist/bin/acme", "mcp"],
          env: {},
          scope: "north",
        },
        filesDir: path.join(state, "agent-files", "builder"),
        stateDir: state,
        env: { PATH: `${bin}:/usr/bin:/bin` },
        attention: { base: "http://127.0.0.1:4000" },
      };
      const out = getRuntime("den-claude")!.launch(inp);
      const settings = JSON.parse(
        out.files![path.join(inp.filesDir, "settings.json")]!,
      ) as {
        hooks: {
          PreToolUse: { matcher?: string; hooks: { command: string }[] }[];
        };
      };
      const entry = settings.hooks.PreToolUse.find(
        (e) => e.matcher === "Agent|Task",
      );
      expect(entry).toBeDefined();
      expect(entry!.hooks[0]!.command).toMatch(/subagent-hook\.[jt]s/);
      expect(entry!.hooks[0]!.command).toContain("--den http://127.0.0.1:4000");
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});
