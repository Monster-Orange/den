import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

let s: AgentsPageServer;
const tokens: Record<string, string> = {};

async function start(ws: string): Promise<void> {
  const r = await fetch(`${s.base}/api/workspaces/${ws}/agents`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ persona: "planner" }),
  });
  expect(r.status).toBe(200);
  const pty = s.made.at(-1)!;
  tokens[ws] = actorTokenOf(pty.opts.env) ?? "";
  pty.emit("> ");
}

async function needs(headers: Record<string, string>): Promise<number> {
  const r = await fetch(`${s.base}/api/sessions/helpers`, { headers });
  expect(r.status).toBe(200);
  return ((await r.json()) as { needs: number }).needs;
}

beforeAll(async () => {
  s = await startAgentsPageServer({ userYml: "install_mode: strict\n" });
  await start("north");
  await start("south");
  const r = await fetch(`${s.base}/api/agents/self/attention`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.south}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event: "waiting",
      why: "permission",
      hooked: true,
    }),
  });
  expect(r.status).toBe(200);
}, 90_000);

afterAll(async () => {
  await s?.stop();
});

describe("the helpers count's needs on a strict install", () => {
  it("an agent counts only its own projects' waits; the person counts them all", async () => {
    const person = denAuth(s.stateDir);
    const end = Date.now() + 15_000;
    while ((await needs(person)) < 1 && Date.now() < end)
      await new Promise((r) => setTimeout(r, 200));
    expect(await needs(person)).toBe(1);
    expect(await needs({ authorization: `Bearer ${tokens.north}` })).toBe(0);
    expect(await needs({ authorization: `Bearer ${tokens.south}` })).toBe(1);
  }, 60_000);
});
