/**
 * D41: before an agent stops, its Stop hook asks Hub how many comments wait
 * on it, and blocks once when that number went up: "N Hub comments wait on
 * you: call hub_inbox". D52: it asks Den's proxy to Hub with the agent's
 * own Den token (its session's DEN_ACTOR_TOKEN); the install's Hub token is
 * never the agent's. Any failure lets the agent stop.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  inboxArgs,
  inboxBlock,
  type InboxArgs,
} from "../../../src/shared/agents/guardrails/hub-inbox.js";
import { stopHook } from "../../../src/shared/agents/guardrails/stop-hook.js";
import { loadPersonas } from "../../../src/shared/agents/personas.js";
import {
  getRuntime,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-inbox-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** An agent's own Den token, as its session's env has it. */
const denToken = (k: number) => `den_at_TESTONLY${k}`;
let yours: unknown = 0;
let status = 200;
let delayMs = 0;
const seen: { auth?: string; agent?: string; url?: string }[] = [];
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({
      auth: req.headers.authorization,
      agent: req.headers["x-den-agent-id"] as string | undefined,
      url: req.url,
    });
    setTimeout(() => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ waiting: 9, yours, threads: [] }));
    }, delayMs);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // Den's proxy to Hub (D52): the fake answers as Hub would through it.
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hub`;
});
afterAll(
  () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
);

let n = 0;
/** A fresh agent: its files dir, and its session's env (its Den token). */
function agent(at = base) {
  const files = path.join(root, `a${++n}`);
  fs.mkdirSync(files, { recursive: true });
  return { base: at, files } satisfies InboxArgs;
}
const env = () => ({ DEN_ACTOR_TOKEN: denToken(n) });
/** The check as the agent's Stop hook runs it. */
const check = (a: InboxArgs, more: { timeoutMs?: number } = {}) =>
  inboxBlock(a, { env: env(), ...more });

const reset = (y: unknown, s = 200) => {
  yours = y;
  status = s;
  delayMs = 0;
  seen.length = 0;
};

describe("D41: the inbox check", () => {
  it("blocks once when comments wait, with the count; not again for the same count", async () => {
    const a = agent();
    reset(2);
    const out = JSON.parse(await check(a)) as {
      decision: string;
      reason: string;
    };
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/^2 Hub comments wait on you: call hub_inbox/);
    expect(await check(a)).toBe("");
  });

  it("D52: asks Den's proxy (<den>/hub/api/inbox) with the agent's own Den token, never Hub's", async () => {
    const a = agent();
    reset(1);
    const out = await check(a);
    expect(out).toMatch(/1 Hub comment waits on you/);
    // Den's proxy sets the agent id; the hook sends only the bearer.
    expect(seen).toEqual([
      { auth: `Bearer ${denToken(n)}`, url: "/hub/api/inbox" },
    ]);
  });

  it("a new comment after the count dropped nudges again", async () => {
    const a = agent();
    reset(1);
    expect(await check(a)).not.toBe("");
    reset(0);
    expect(await check(a)).toBe("");
    reset(1);
    expect(await check(a)).not.toBe("");
  });

  it("keeps the count 0600 in the agent's files", async () => {
    const a = agent();
    reset(3);
    await check(a);
    const f = path.join(a.files, "hub-inbox.json");
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))).toEqual({ yours: 3 });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("nothing waiting: the agent stops", async () => {
    reset(0);
    expect(await check(agent())).toBe("");
  });

  it("fails open: Hub errors, bad answers, slow Hub, no Hub server, no token", async () => {
    reset(2, 502);
    expect(await check(agent())).toBe("");
    reset("2");
    expect(await check(agent())).toBe("");
    reset(2);
    delayMs = 500;
    expect(await check(agent(), { timeoutMs: 50 })).toBe("");
    reset(2);
    // Den isn't there.
    expect(await check(agent("http://127.0.0.1:1/hub"))).toBe("");
    // No Den token in the session (or a bad one): nothing to ask.
    expect(await inboxBlock(agent(), { env: {} })).toBe("");
    expect(
      await inboxBlock(agent(), { env: { DEN_ACTOR_TOKEN: "a b\nc" } }),
    ).toBe("");
    expect(seen).toEqual([]);
  });

  it("reads its flags; both are needed", () => {
    expect(inboxArgs(["--files", "/f", "--hub-inbox", "http://h/hub"])).toEqual(
      { base: "http://h/hub", files: "/f" },
    );
    expect(inboxArgs(["--hub-inbox", "http://h/hub"])).toBeNull();
    expect(inboxArgs(["--files", "/f"])).toBeNull();
  });
});

describe("D41: in the Stop hook", () => {
  const msg = (more: Record<string, unknown> = {}) =>
    JSON.stringify({ last_assistant_message: "Done.", ...more });

  it("asks only when nothing else blocks, and not on a stop it already blocked", async () => {
    const a = agent();
    const argv = ["--files", a.files, "--hub-inbox", a.base];
    const calls: InboxArgs[] = [];
    const fake = async (x: InboxArgs) => {
      calls.push(x);
      return "INBOX";
    };
    expect(await stopHook(msg(), argv, fake)).toBe("INBOX");
    expect(calls).toEqual([a]);
    expect(await stopHook(msg({ stop_hook_active: true }), argv, fake)).toBe(
      "",
    );
    expect(await stopHook(msg(), argv.slice(0, 2), fake)).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("--inbox-only: the inbox check alone", async () => {
    const a = agent();
    const argv = ["--inbox-only", "--files", a.files, "--hub-inbox", a.base];
    expect(await stopHook(msg(), argv, async () => "INBOX")).toBe("INBOX");
  });

  it("bad stdin: the agent stops", async () => {
    expect(await stopHook("{", ["--inbox-only"], async () => "INBOX")).toBe("");
  });
});

describe("D41: at launch", () => {
  function launch(persona = loadPersonas([]).get("planner")!, inbox = true) {
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
        hub: {
          name: "hub",
          url: "http://localhost:4100/hub/mcp",
          headersHelper: "printf {}",
          ...(inbox ? { inboxBase: "http://localhost:4100/hub" } : {}),
        },
      },
      filesDir: path.join(root, "files", persona.id),
      stateDir: path.join(root, "state"),
      env: {},
      bin: "/nowhere/claude",
    };
    const out = getRuntime("den-claude")!.launch(inp);
    const settings = JSON.parse(
      out.files![path.join(inp.filesDir, "settings.json")],
    ) as {
      hooks?: Record<string, { hooks: { command: string }[] }[]>;
    };
    return { hooks: settings.hooks, files: inp.filesDir };
  }

  it("D52: the Stop hook gets Den's proxy to Hub and its files dir, never a token", () => {
    const { hooks, files } = launch();
    const cmd = hooks!.Stop[0].hooks[0].command;
    expect(cmd).toContain("--hub-inbox http://localhost:4100/hub");
    expect(cmd).not.toContain("--mcp");
    expect(cmd).toContain(`--files ${files}`);
    expect(JSON.stringify(hooks)).not.toMatch(/den_at_|test-install-token/);
  });

  it("inbox_on_stop off: no inbox check", () => {
    expect(
      launch(undefined, false).hooks!.Stop[0].hooks[0].command,
    ).not.toContain("--hub-inbox");
  });

  it("a persona without Den's hooks gets the inbox check alone", () => {
    const dir = path.join(root, "pack");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "quiet.md"),
      "---\nname: quiet\nden_hooks: false\n---\nYou plan.\n",
    );
    const quiet = loadPersonas([dir]).get("quiet")!;
    const { hooks, files } = launch(quiet);
    expect(Object.keys(hooks!)).toEqual(["Stop"]);
    const cmd = hooks!.Stop[0].hooks[0].command;
    expect(cmd).toContain("--inbox-only");
    expect(cmd).toContain(`--files ${files}`);
    expect(launch(quiet, false).hooks).toBeUndefined();
  });
});
