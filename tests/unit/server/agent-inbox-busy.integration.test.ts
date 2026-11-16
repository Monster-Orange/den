/**
 * Issue 242: an agent's Hub inbox call (GET /hub/api/inbox, how Hub's
 * Approve and Request changes reach it) with its own token succeeds right
 * after it restarts on the same conversation, even when Den is busy at
 * that moment. Before, each call's caller was looked up in the request,
 * one at a time, holding Den's loop; a burst (agents restarting together)
 * outran the 2 s the agent's hook waits.
 *
 * The real server on the demo distribution, the scripted PTY (its session
 * root is this test process, so calls from here are the agent's), a fake
 * Hub. "Busy": the server is paused (SIGSTOP) while the burst connects,
 * then goes on. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

const HUB_TOKEN = "hubi_TESTONLY_inbox_busy_242";
/** As many calls at once as agents restarting together. */
const BURST = 40;
/** The agent hook's own patience. */
const HOOK_ABORT_MS = 2_000;

let hub: http.Server;
let s: AgentsPageServer;
let tokenDir = "";

beforeAll(async () => {
  hub = http.createServer((req, res) => {
    const ok =
      req.headers.authorization === `Bearer ${HUB_TOKEN}` &&
      new URL(req.url ?? "/", "http://x").pathname === "/api/inbox";
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    res.end(ok ? '{"items":[]}' : '{"error":"not_found"}');
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  const hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-242-"));
  const tokenFile = path.join(tokenDir, "hub-token");
  fs.writeFileSync(tokenFile, HUB_TOKEN, { mode: 0o600 });
  s = await startAgentsPageServer({
    userYml: `hub:\n  url: ${hubUrl}\n  token: "file:${tokenFile}"\n`,
  });
}, 90_000);

afterAll(async () => {
  await s?.stop();
  hub?.closeAllConnections();
  await new Promise((r) => (hub ? hub.close(r) : r(undefined)));
  if (tokenDir) fs.rmSync(tokenDir, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: {
      ...denAuth(s.stateDir),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    json: (await r.json()) as Record<string, unknown>,
  };
}

/** Its conversation's transcript, with a turn that ended. */
function endedTurn(conv: string, cwd: string): void {
  const dir = path.join(s.tmp, "home", ".claude", "projects", "-north");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${conv}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd, message: { content: "Plan it" } },
      {
        type: "assistant",
        message: {
          model: "opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Planned." }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
}

async function until(f: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The agent's inbox call, as its hook makes it: own connection, 2 s abort. */
async function inbox(token: string): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HOOK_ABORT_MS);
  try {
    const r = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${s.base}/hub/api/inbox`);
      const q = http.get(
        {
          host: "127.0.0.1",
          port: u.port,
          path: u.pathname,
          headers: { authorization: `Bearer ${token}`, host: u.host },
          agent: false,
          signal: ac.signal,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      q.on("error", reject);
    });
    return String(r);
  } catch {
    return "gave up";
  } finally {
    clearTimeout(t);
  }
}

describe("issue 242: an agent's Hub inbox right after it restarts, Den busy", () => {
  it("every call of a burst gets its inbox, none refused as from an unknown process", async () => {
    const start = await call("POST", "/api/workspaces/north/agents", {
      persona: "planner",
    });
    expect(start.status).toBe(200);
    const first = s.made.at(-1)!;
    first.emit("> ");
    // It had a conversation (a turn that ended): the restart resumes it.
    expect(first.args[0]).toBe("--session-id");
    endedTurn(first.args[1], first.opts.cwd);
    const before = s.made.length;
    const restarting = call(
      "POST",
      "/api/workspaces/north/agents/planner/restart",
      { when: "now" },
    );
    // Den stops it (the scripted PTY only records the signal): it exits.
    await until(() => first.signals.length > 0);
    first.exit(143);
    expect((await restarting).status).toBe(200);
    await until(() => s.made.length > before);
    const next = s.made.at(-1)!;
    expect(next.args.slice(0, 2)).toEqual(["--resume", first.args[1]]);
    const token = actorTokenOf(next.opts.env) ?? "";
    expect(token).toBeTruthy();
    // Settled: one call alone gets in.
    expect(await inbox(token)).toBe("200");

    // Busy: the burst connects while Den is paused, then Den goes on.
    const pid = s.serverPid()!;
    process.kill(-pid, "SIGSTOP");
    let said: string[];
    try {
      const calls = Array.from({ length: BURST }, () => inbox(token));
      await new Promise((res) => setTimeout(res, 300));
      process.kill(-pid, "SIGCONT");
      said = await Promise.all(calls);
    } finally {
      process.kill(-pid, "SIGCONT");
    }
    // Counted, so a failure says how many.
    const counts: Record<string, number> = {};
    for (const x of said) counts[x] = (counts[x] ?? 0) + 1;
    expect(counts).toEqual({ "200": BURST });
    const audit = fs.existsSync(path.join(s.stateDir, "audit.jsonl"))
      ? fs.readFileSync(path.join(s.stateDir, "audit.jsonl"), "utf8")
      : "";
    expect(audit).not.toContain("token_unknown");
  }, 90_000);
});
