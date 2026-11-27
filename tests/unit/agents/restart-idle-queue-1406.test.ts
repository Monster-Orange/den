import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { AddressInfo } from "net";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

async function restartIdle(r: Rig) {
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, {
      agents: r.deps,
      personaWait: { pollMs: 20 },
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return async (body: unknown) => {
    const res = await fetch(
      `http://localhost:${port}/api/agents/restart-idle`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
}

async function twoAgentsMidTurn() {
  const r = await rig();
  for (const id of ["planner", "reviewer"]) {
    const code = await cmdAgents(
      ["start", "-w", "north", "--persona", id],
      r.deps,
    );
    expect({ code, err: r.err.slice(-2) }).toEqual({ code: 0, err: [] });
    await settle();
  }
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  for (const id of ["planner", "reviewer"])
    fs.writeFileSync(
      path.join(dir, `${readRecord(r.stateDir, id)!.resumeToken!}.jsonl`),
      JSON.stringify({
        type: "user",
        cwd: r.wsDir("north"),
        message: { content: "Go" },
      }) + "\n",
    );
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  return r;
}

const ids = (x: unknown) =>
  ((x as { id: string }[] | undefined) ?? []).map((a) => a.id).sort();

describe("issue 1406: Restart idle joins the restart queue's wave", () => {
  it("a second press while the wave runs restarts no agent twice", async () => {
    const r = await twoAgentsMidTurn();
    const call = await restartIdle(r);
    const first = await call({ project: "north" });
    expect(first.status).toBe(202);
    expect(ids(first.json.agents)).toEqual(["planner", "reviewer"]);
    expect(first.json.run).toEqual({ total: 2, done: 0 });
    const second = await call({ project: "north" });
    expect(second.status).toBe(202);
    expect(ids(second.json.agents)).toEqual([]);
    await settle(300);
  });

  it("two presses at the same moment take each agent once", async () => {
    const r = await twoAgentsMidTurn();
    const call = await restartIdle(r);
    const both = await Promise.all([
      call({ project: "north" }),
      call({ project: "north" }),
    ]);
    expect(both.map((b) => b.status)).toEqual([202, 202]);
    expect(both.flatMap((b) => ids(b.json.agents)).sort()).toEqual([
      "planner",
      "reviewer",
    ]);
    await settle(300);
  });
});
