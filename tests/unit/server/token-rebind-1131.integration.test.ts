/**
 * Issue 1131: an agent's own calls must still be placed after its process
 * tree changes, and a call from outside its tree must still be refused.
 *
 *   - Restarted by Den (stop, then resume): the session is new, so is its
 *     token, bound to the new session. Its first call is placed; the token
 *     from before is no longer good; a process outside the tree is still
 *     refused.
 *   - A session that goes on in a new tree under the same agent (a fresh
 *     helper and its child, as after a conversation continues from a
 *     summary): placed. An orphan with the same token: refused.
 *
 * The real server, the demo distribution, the scripted PTY, whose session
 * root is this test process (fake-pty.ts). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import * as path from "path";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { denAuth } from "./helpers/den-auth.js";
import { readAnswer, writeAnswerJs } from "./helpers/child-answer.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

let s: AgentsPageServer;

beforeAll(async () => {
  s = await startAgentsPageServer();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

const person = () => ({
  ...denAuth(s.stateDir),
  "content-type": "application/json",
});

async function post(p: string, body?: unknown): Promise<number> {
  const r = await fetch(`${s.base}${p}`, {
    method: "POST",
    headers: person(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.status;
}

/** The call, as the agent's MCP server makes it: its own attention. */
const CALL = (tok: string) =>
  `fetch(${JSON.stringify(s.base + "/api/agents/self/attention")},{method:"POST",headers:{authorization:"Bearer "+${JSON.stringify(tok)},"content-type":"application/json"},body:JSON.stringify({event:"finished"})}).then(async r=>{const b=await r.json().catch(()=>({}));return r.status+" "+(b.code||"")})`;

/** From this process, the session's root. */
async function fromRoot(tok: string): Promise<number> {
  const r = await fetch(`${s.base}/api/agents/self/attention`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ event: "finished" }),
  });
  return r.status;
}

/**
 * A new tree under the session: a fresh helper that starts its own child,
 * and the child calls while the helper still runs.
 */
function fromNewTree(tok: string): string {
  const child = `${CALL(tok)}.then(x=>console.log(x))`;
  const helper = `const c=require("child_process").spawnSync(process.execPath,["-e",${JSON.stringify(child)}],{encoding:"utf8"});process.stdout.write(c.stdout)`;
  const r = spawnSync(process.execPath, ["-e", helper], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return r.stdout.trim();
}

/** A process outside this tree: orphaned, then it calls. */
async function fromOrphan(tok: string): Promise<string> {
  const out = path.join(s.tmp, `orphan-${Date.now()}.txt`);
  const write = writeAnswerJs(out, `x`);
  const grandchild = `const p0=Number(process.argv[1]);const go=()=>${CALL(tok)}.then(x=>{${write}});const w=()=>process.ppid!==p0?go():setTimeout(w,50);w()`;
  const parent = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)},String(process.pid)],{detached:true,stdio:"ignore"}).unref();`;
  const p = spawn(process.execPath, ["-e", parent], { stdio: "ignore" });
  await new Promise((r) => p.on("exit", r));
  return readAnswer(out, 20_000, "the orphan");
}

const settle = () => new Promise((r) => setTimeout(r, 200));

describe("issue 1131: an agent's calls after its process tree changes", () => {
  let first = "";
  let second = "";

  it("restarted by Den: placed on its first call, with its new token", async () => {
    expect(
      await post("/api/workspaces/north/agents", { persona: "planner" }),
    ).toBe(200);
    first = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
    expect(first).toBeTruthy();
    expect(await fromRoot(first)).toBe(200);

    // Stop waits for the session to end (202 while it still runs); the
    // scripted session ends when told.
    const stopping = post("/api/workspaces/north/agents/planner/stop");
    await settle();
    s.made.at(-1)!.exit(143);
    expect([200, 202]).toContain(await stopping);
    await settle();
    expect(await post("/api/workspaces/north/agents/planner/resume")).toBe(200);
    second = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    // Its first call after the restart.
    expect(await fromRoot(second)).toBe(200);
  }, 60_000);

  it("the token from before the restart is good no more", async () => {
    expect(await fromRoot(first)).not.toBe(200);
  }, 30_000);

  it("a new tree under the same agent (a fresh helper and its child): placed", () => {
    expect(fromNewTree(second)).toBe("200");
  }, 30_000);

  it("a process outside the agent's tree, with the same token: still refused", async () => {
    expect(await fromOrphan(second)).toBe("403 agent_token_elsewhere");
  }, 40_000);
});
