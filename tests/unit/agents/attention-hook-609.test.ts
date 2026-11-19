/**
 * Issue 609: an agent's attention marks were lost on a busy machine. The
 * hook gave up after a hard 2 s; when Den was slow to answer (a loaded
 * machine, a restart), it closed its connection, and Den could no longer
 * find the process that made the call. Now the hook's wait, its retries
 * and the pause between them are Settings (user.yml agent_hooks.*) with
 * permissive defaults, passed to the hook at launch.
 *
 * A real loopback server stands in for a slow Den; the token is a test
 * one; no real runtime runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { sendAttention } from "../../../src/shared/agents/guardrails/attention-hook.js";
import {
  HOOK_CALL_DEFAULT,
  HOOK_CALL_LIMITS,
  callDen,
  hookCallBudgetSeconds,
  hookCallFlags,
  hookCallOf,
  hookCallSettings,
} from "../../../src/shared/agents/guardrails/hook-call.js";
import { patchCliRows } from "../../../src/shared/settings-cli-rows.js";
import { inboxBlock } from "../../../src/shared/agents/guardrails/hub-inbox.js";
import { loadPersonas } from "../../../src/shared/agents/personas.js";
import { getRuntime } from "../../../src/shared/agents/runtimes.js";
import type { LaunchInput } from "../../../src/shared/agents/runtime.js";

const ENV = { DEN_ACTOR_TOKEN: "den_at_TESTONLY_609" };
const EV = { event: "finished", text: "", hooked: true } as const;

let root = "";
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "den-609-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A Den that answers each request after `ms`. */
async function slowDen(ms: number): Promise<{
  base: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let n = 0;
  const s = http.createServer((req, res) => {
    n++;
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.url?.endsWith("/api/inbox") ? '{"yours":1}' : "{}");
    }, ms);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    hits: () => n,
    close: async () => {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    },
  };
}

describe("issue 609: a slow Den still gets the mark", () => {
  it("Den answers after 3 s: the mark lands with the default wait", async () => {
    const den = await slowDen(3_000);
    try {
      expect(await sendAttention(den.base, EV, { env: ENV })).toBe(true);
      expect(den.hits()).toBe(1);
    } finally {
      await den.close();
    }
  }, 15_000);

  it("the Hub inbox check waits as long too", async () => {
    const den = await slowDen(3_000);
    const files = path.join(root, "inbox");
    try {
      const out = await inboxBlock({ base: den.base, files }, { env: ENV });
      expect(den.hits()).toBe(1);
      // It read the answer: one comment waits, and the agent is told.
      expect(out).toContain("1 Hub comment waits on you");
    } finally {
      await den.close();
    }
  }, 15_000);

  it("a wait set shorter than Den's answer: given up, quietly", async () => {
    const den = await slowDen(1_500);
    try {
      expect(
        await sendAttention(den.base, EV, {
          env: ENV,
          call: { timeoutMs: 200, retries: 0, backoffMs: 0 },
        }),
      ).toBe(false);
    } finally {
      await den.close();
    }
  });
});

describe("issue 609: a refused or failed mark is tried again", () => {
  const ok = () => new Response("{}", { status: 200 });
  const noSleep = async () => undefined;

  it("a failure, then a refusal, then Den takes it: three calls, with the pause doubling", async () => {
    const answers: (() => Response)[] = [
      () => {
        throw new Error("connection refused");
      },
      () => new Response("{}", { status: 403 }),
      ok,
    ];
    const urls: string[] = [];
    const slept: number[] = [];
    const r = await sendAttention("http://127.0.0.1:1", EV, {
      env: ENV,
      call: { timeoutMs: 1_000, retries: 2, backoffMs: 500 },
      fetch: async (url) => {
        urls.push(url);
        return answers[urls.length - 1]();
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(r).toBe(true);
    expect(urls).toHaveLength(3);
    expect(slept).toEqual([500, 1_000]);
  });

  it("retries 0: one call; and a request Den rejects as wrong is never repeated", async () => {
    let n = 0;
    const fail = async () => {
      n++;
      throw new Error("down");
    };
    expect(
      await sendAttention("http://127.0.0.1:1", EV, {
        env: ENV,
        call: { timeoutMs: 1_000, retries: 0, backoffMs: 0 },
        fetch: fail,
        sleep: noSleep,
      }),
    ).toBe(false);
    expect(n).toBe(1);
    n = 0;
    const bad = async () => {
      n++;
      return new Response("{}", { status: 400 });
    };
    expect(
      await sendAttention("http://127.0.0.1:1", EV, {
        env: ENV,
        call: { timeoutMs: 1_000, retries: 3, backoffMs: 0 },
        fetch: bad,
        sleep: noSleep,
      }),
    ).toBe(false);
    expect(n).toBe(1);
  });

  it("callDen: every try failing gives null after 1 + retries calls", async () => {
    let n = 0;
    const r = await callDen(
      "http://127.0.0.1:1/x",
      { method: "GET" },
      { timeoutMs: 100, retries: 2, backoffMs: 0 },
      {
        fetch: async () => {
          n++;
          return new Response("", { status: 503 });
        },
        sleep: noSleep,
      },
    );
    expect(r).toBeNull();
    expect(n).toBe(3);
  });
});

describe("issue 609: the hooks' wait is a Setting", () => {
  it("permissive defaults: 20 s a try, 2 retries, 1 s pause", () => {
    expect(HOOK_CALL_DEFAULT).toEqual({
      timeoutMs: 20_000,
      retries: 2,
      backoffMs: 1_000,
    });
    expect(HOOK_CALL_LIMITS.timeout_seconds.default).toBe(20);
  });

  it("user.yml agent_hooks.*: read, and a value out of range falls back to its default", () => {
    expect(hookCallSettings(() => ({}))).toEqual(HOOK_CALL_DEFAULT);
    expect(
      hookCallSettings(() => ({
        agent_hooks: { timeout_seconds: 45, retries: 4, backoff_seconds: 2.5 },
      })),
    ).toEqual({ timeoutMs: 45_000, retries: 4, backoffMs: 2_500 });
    expect(
      hookCallSettings(() => ({
        agent_hooks: {
          timeout_seconds: 0,
          retries: 1.5,
          backoff_seconds: "soon",
        },
      })),
    ).toEqual(HOOK_CALL_DEFAULT);
    expect(
      hookCallSettings(() => {
        throw new Error("unreadable");
      }),
    ).toEqual(HOOK_CALL_DEFAULT);
  });

  it("Settings writes them to user.yml agent_hooks, checked first", () => {
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, {
        agent_hooks: { timeout_seconds: 30, retries: 3, backoff_seconds: 0.5 },
      }),
    ).toEqual({ ok: true });
    expect(user.agent_hooks).toEqual({
      timeout_seconds: 30,
      retries: 3,
      backoff_seconds: 0.5,
    });
    expect(patchCliRows(user, { agent_hooks: { retries: 1.5 } }).ok).toBe(
      false,
    );
    expect(patchCliRows(user, { agent_hooks: { timeout_seconds: 0 } }).ok).toBe(
      false,
    );
    expect(patchCliRows(user, { agent_hooks: { soon: 1 } }).ok).toBe(false);
    expect((user.agent_hooks as { retries: number }).retries).toBe(3);
    expect(
      patchCliRows(user, {
        agent_hooks: {
          timeout_seconds: null,
          retries: null,
          backoff_seconds: null,
        },
      }),
    ).toEqual({ ok: true });
    expect(user.agent_hooks).toBeUndefined();
  });

  it("the hook's flags round-trip; missing or bad flags are the defaults", () => {
    const c = { timeoutMs: 7_000, retries: 1, backoffMs: 250 };
    expect(hookCallOf(["--den", "x", ...hookCallFlags(c)])).toEqual(c);
    expect(hookCallOf(["--den", "x"])).toEqual(HOOK_CALL_DEFAULT);
    expect(hookCallOf(["--call-timeout-ms", "-4"])).toEqual(HOOK_CALL_DEFAULT);
  });

  it("the runtime's own limit on the hook covers every try and pause", () => {
    // 3 tries of 20 s, pauses of 1 + 2 s, and a margin.
    expect(hookCallBudgetSeconds(HOOK_CALL_DEFAULT)).toBeGreaterThanOrEqual(63);
  });

  it("at launch: the attention and Stop hooks get the setting, and a limit that fits it", () => {
    const persona = loadPersonas([]).get("planner")!;
    const call = { timeoutMs: 30_000, retries: 3, backoffMs: 2_000 };
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
        hub: { name: "hub", inboxBase: "http://localhost:4100/hub" },
      } as LaunchInput["mcp"],
      filesDir: path.join(root, "files", persona.id),
      stateDir: path.join(root, "state"),
      env: {},
      bin: "/nowhere/claude",
      attention: { base: "http://localhost:4100", call },
    };
    const out = getRuntime("den-claude")!.launch(inp);
    const { hooks } = JSON.parse(
      out.files![path.join(inp.filesDir, "settings.json")],
    ) as {
      hooks: Record<
        string,
        { hooks: { command: string; timeout: number }[] }[]
      >;
    };
    const budget = hookCallBudgetSeconds(call);
    const att = hooks.Notification[0].hooks[0];
    expect(att.command).toContain("--call-timeout-ms 30000");
    expect(att.command).toContain("--call-retries 3");
    expect(att.command).toContain("--call-backoff-ms 2000");
    expect(att.timeout).toBeGreaterThanOrEqual(budget);
    const stop = hooks.Stop.map((e) => e.hooks[0]).find((h) =>
      /stop-hook\.[jt]s/.test(h.command),
    )!;
    expect(stop.command).toContain("--hub-inbox");
    expect(stop.command).toContain("--call-timeout-ms 30000");
    expect(stop.timeout).toBeGreaterThanOrEqual(budget);
  });
});
