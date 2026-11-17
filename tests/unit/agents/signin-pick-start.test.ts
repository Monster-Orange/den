/**
 * Issue 340: an agent's start under the always-on service gets the token
 * of the sign-in Den picks for it (pickAccount): its folder's (from a
 * source), else the active one, else the first in Den's order that is not
 * capped. The token reaches that agent's env only. Which sign-in it runs
 * on is kept on the agent (its label, never an email, never a token) and
 * said in its audit line.
 *
 * The store is in memory, keyed by ref name; invented tokens only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import type {
  SecretRef,
  SecretsProvider,
} from "../../../src/shared/secrets/types.js";
import {
  accountLabel,
  addAccount,
  type AccountSource,
} from "../../../src/shared/agents/signin-accounts.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const T1 = "fake-start-one-0123456789abcdef";
const T2 = "fake-start-two-0123456789abcdef";

class MemStore implements SecretsProvider {
  readonly name = "1password" as const;
  constructor(public values: Record<string, string> = {}) {}
  async isReady() {
    return true;
  }
  async get(ref: SecretRef): Promise<string> {
    return this.values[ref.item] ?? "";
  }
  async tryGet(ref: SecretRef): Promise<string | null> {
    return this.values[ref.item] ?? null;
  }
  async set(ref: SecretRef, v: string): Promise<void> {
    this.values[ref.item] = v;
  }
  async preflight() {
    return { ok: true };
  }
  runPrefix() {
    return [];
  }
}

async function alwaysOn(
  store: MemStore,
  over: {
    source?: AccountSource | null;
    capped?: (rt: string, id: string) => boolean;
  } = {},
): Promise<Rig> {
  const r = await rig({
    signInStore: (name: string) => ({
      provider: store,
      ref: { vault: "V", item: name, field: "pw" },
    }),
    ...(over.source !== undefined ? { signInSource: () => over.source! } : {}),
    ...(over.capped ? { signInCapped: over.capped } : {}),
  });
  fs.writeFileSync(
    path.join(r.stateDir, "sessions-host-job.json"),
    JSON.stringify({ label: "local.acme.sessions", mode: "always" }) + "\n",
  );
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, "planner.md"),
    "---\nname: planner\n---\nYou plan.\n",
  );
  r.config.personaPacks = ["personas"];
  return r;
}

const startIn = async (r: Rig, ws: string, id: string) => {
  expect(
    await cmdAgents(
      ["start", "-w", ws, "--persona", "planner", "--id", id],
      r.deps,
    ),
  ).toBe(0);
  return (r.made.at(-1)!.opts.env as Record<string, string>)
    .CLAUDE_CODE_OAUTH_TOKEN;
};

const BOTH = { agent_signin_token: T1, agent_signin_token__2: T2 };

describe("a start picks its sign-in", () => {
  it("no source: the first in the order; the agent says which, by label only", async () => {
    const r = await alwaysOn(new MemStore(BOTH));
    addAccount(r.stateDir, "den-claude");
    expect(await startIn(r, "north", "a1")).toBe(T1);
    const rec = readRecord(r.stateDir, "a1")!;
    expect(rec.signIn).toEqual({
      id: "1",
      label: accountLabel({ id: "1" }),
    });
    expect(JSON.stringify(rec)).not.toContain("fake-start");
    expect([...r.out, ...r.err].join("\n")).not.toContain("fake-start");
  });

  it("a capped sign-in is skipped", async () => {
    const r = await alwaysOn(new MemStore(BOTH), {
      capped: (_rt, id) => id === "1",
    });
    addAccount(r.stateDir, "den-claude");
    expect(await startIn(r, "north", "a1")).toBe(T2);
    expect(readRecord(r.stateDir, "a1")!.signIn?.id).toBe("2");
  });

  it("two agents in different projects run on different sign-ins", async () => {
    const seen: string[] = [];
    const source: AccountSource = {
      forFolder: (_rt, folder) => {
        seen.push(folder);
        return folder.endsWith(path.join("workspaces", "south")) ? "2" : null;
      },
      active: () => "1",
    };
    const r = await alwaysOn(new MemStore(BOTH), { source });
    addAccount(r.stateDir, "den-claude");
    expect(await startIn(r, "north", "n1")).toBe(T1);
    expect(await startIn(r, "south", "s1")).toBe(T2);
    expect(readRecord(r.stateDir, "n1")!.signIn?.id).toBe("1");
    expect(readRecord(r.stateDir, "s1")!.signIn?.id).toBe("2");
    // The source was asked with each agent's own folder.
    expect(seen).toHaveLength(2);
    // Each token reached its own agent only.
    const envs = r.made.map(
      (m) => (m.opts.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN,
    );
    expect(envs).toEqual([T1, T2]);
  });

  it("no sign-in with a token: it starts as today, with the warning, and no sign-in is kept on it", async () => {
    const r = await alwaysOn(new MemStore({}));
    addAccount(r.stateDir, "den-claude");
    expect(await startIn(r, "north", "a1")).toBeUndefined();
    expect(r.err.join("\n")).toMatch(
      /agents will not be able to sign in after logout/,
    );
    expect(readRecord(r.stateDir, "a1")!.signIn).toBeUndefined();
  });

  it("desktop sign-in (not always-on): nothing is picked or kept", async () => {
    const r = await alwaysOn(new MemStore(BOTH));
    fs.rmSync(path.join(r.stateDir, "sessions-host-job.json"));
    expect(await startIn(r, "north", "a1")).toBeUndefined();
    expect(readRecord(r.stateDir, "a1")!.signIn).toBeUndefined();
  });
});

describe("the agent's audit line", () => {
  it("a start from the page says which sign-in it runs on, by label", async () => {
    const r = await alwaysOn(new MemStore(BOTH), {
      capped: (_rt, id) => id === "1",
    });
    addAccount(r.stateDir, "den-claude");
    const server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, { agents: r.deps });
    });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "localhost", res));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://localhost:${port}/api/workspaces/north/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "planner", id: "web1" }),
      },
    );
    expect(res.status).toBeLessThan(300);
    const line = recentActions().find(
      (e) => e.verb === "agents" && e.detail.startsWith("start web1 "),
    );
    expect(line?.detail).toContain(`; on ${accountLabel({ id: "2" })}`);
    expect(JSON.stringify(recentActions())).not.toContain("fake-start");
  });
});
