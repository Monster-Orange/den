/**
 * D41: before an agent stops, its Stop hook asks Hub how many comments wait
 * on it, and blocks once when that number went up: "N Hub comments wait on
 * you: call hub_inbox". The token comes from the agent's mcp.json, never
 * argv. Any failure lets the agent stop.
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

const TOKEN = "Bearer test-install-token";
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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
);

let n = 0;
/** A fresh agent: its files dir and an mcp.json with Hub's headers. */
function agent(hubUrl = base, headers: Record<string, string> | null = null) {
  const files = path.join(root, `a${++n}`);
  fs.mkdirSync(files, { recursive: true });
  const mcp = path.join(files, "mcp.json");
  fs.writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        den: { command: "/x/den", args: ["mcp"] },
        hub: {
          type: "http",
          url: `${hubUrl}/mcp`,
          headers: headers ?? {
            Authorization: TOKEN,
            "X-Den-Agent-Id": `agent-${n}`,
          },
        },
      },
    }),
  );
  return { base, mcp, files } satisfies InboxArgs;
}

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
    const out = JSON.parse(await inboxBlock(a)) as {
      decision: string;
      reason: string;
    };
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/^2 Hub comments wait on you: call hub_inbox/);
    expect(await inboxBlock(a)).toBe("");
  });

  it("asks Hub's /api/inbox with the token and agent id from mcp.json", async () => {
    const a = agent();
    reset(1);
    const out = await inboxBlock(a);
    expect(out).toMatch(/1 Hub comment waits on you/);
    expect(seen).toEqual([
      { auth: TOKEN, agent: `agent-${n}`, url: "/api/inbox" },
    ]);
  });

  it("a new comment after the count dropped nudges again", async () => {
    const a = agent();
    reset(1);
    expect(await inboxBlock(a)).not.toBe("");
    reset(0);
    expect(await inboxBlock(a)).toBe("");
    reset(1);
    expect(await inboxBlock(a)).not.toBe("");
  });

  it("keeps the count 0600 in the agent's files", async () => {
    const a = agent();
    reset(3);
    await inboxBlock(a);
    const f = path.join(a.files, "hub-inbox.json");
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))).toEqual({ yours: 3 });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("nothing waiting: the agent stops", async () => {
    reset(0);
    expect(await inboxBlock(agent())).toBe("");
  });

  it("fails open: Hub errors, bad answers, slow Hub, no Hub server, no token", async () => {
    reset(2, 502);
    expect(await inboxBlock(agent())).toBe("");
    reset("2");
    expect(await inboxBlock(agent())).toBe("");
    reset(2);
    delayMs = 500;
    expect(await inboxBlock(agent(), { timeoutMs: 50 })).toBe("");
    reset(2);
    // mcp.json's Hub is elsewhere: nothing to ask.
    expect(await inboxBlock(agent("http://127.0.0.1:1"))).toBe("");
    expect(await inboxBlock(agent(base, { "X-Den-Agent-Id": "x" }))).toBe("");
    expect(seen).toEqual([]);
    expect(
      await inboxBlock({ ...agent(), mcp: path.join(root, "nope.json") }),
    ).toBe("");
  });

  it("reads its flags; all three are needed", () => {
    expect(
      inboxArgs(["--files", "/f", "--hub-inbox", "http://h", "--mcp", "/m"]),
    ).toEqual({ base: "http://h", mcp: "/m", files: "/f" });
    expect(inboxArgs(["--hub-inbox", "http://h", "--mcp", "/m"])).toBeNull();
  });
});

describe("D41: in the Stop hook", () => {
  const msg = (more: Record<string, unknown> = {}) =>
    JSON.stringify({ last_assistant_message: "Done.", ...more });

  it("asks only when nothing else blocks, and not on a stop it already blocked", async () => {
    const a = agent();
    const argv = ["--files", a.files, "--hub-inbox", a.base, "--mcp", a.mcp];
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
    const argv = [
      "--inbox-only",
      "--files",
      a.files,
      "--hub-inbox",
      a.base,
      "--mcp",
      a.mcp,
    ];
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
          url: "https://hub.example/mcp",
          headers: { Authorization: TOKEN },
          ...(inbox ? { inboxBase: "https://hub.example" } : {}),
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

  it("the Stop hook gets Hub's URL and mcp.json, never the token", () => {
    const { hooks, files } = launch();
    const cmd = hooks!.Stop[0].hooks[0].command;
    expect(cmd).toContain("--hub-inbox https://hub.example");
    expect(cmd).toContain(`--mcp ${path.join(files, "mcp.json")}`);
    expect(cmd).toContain(`--files ${files}`);
    expect(JSON.stringify(hooks)).not.toContain("test-install-token");
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
