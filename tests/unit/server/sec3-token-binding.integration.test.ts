/**
 * #70 (SEC-3 T8), the red-team case: an agent's token is good only from
 * its own agent's processes. Another process that has the token (copied
 * from ps, or a file) calls Den with it and is refused (403
 * agent_token_elsewhere), with an audit row; nothing runs. The agent's
 * own processes, and their children, still get in.
 *
 * The real server, the demo distribution, the scripted PTY, whose session
 * root is this test process (fake-pty.ts): calls from here are the
 * agent's. "Another process" is one outside this tree: a grandchild left
 * orphaned (its parent exits, so init adopts it). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { denAuth } from "./helpers/den-auth.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

let s: AgentsPageServer;
let token = "";

beforeAll(async () => {
  s = await startAgentsPageServer();
  const r = await fetch(`${s.base}/api/workspaces/north/agents`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ persona: "planner" }),
  });
  expect(r.status).toBe(200);
  token = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
  expect(token).toBeTruthy();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

/** The call, as the agent's MCP server makes it: its own attention. */
const CALL = (base: string, tok: string) =>
  `fetch(${JSON.stringify(base + "/api/agents/self/attention")},{method:"POST",headers:{authorization:"Bearer "+${JSON.stringify(tok)},"content-type":"application/json"},body:JSON.stringify({event:"finished"})}).then(async r=>{const b=await r.json().catch(()=>({}));return r.status+" "+(b.code||"")})`;

/** A child of this test process makes the call. */
function fromChild(): string {
  const r = spawnSync(
    process.execPath,
    ["-e", `${CALL(s.base, token)}.then(x=>console.log(x))`],
    { encoding: "utf8", timeout: 20_000 },
  );
  return r.stdout.trim();
}

/** A process outside this tree: orphaned, then it calls; its answer in a file. */
async function fromOrphan(): Promise<string> {
  const out = path.join(s.tmp, `orphan-${Date.now()}.txt`);
  const grandchild = `const p0=Number(process.argv[1]);const go=()=>${CALL(s.base, token)}.then(x=>require("fs").writeFileSync(${JSON.stringify(out)},x+" ppid="+process.ppid));const w=()=>process.ppid!==p0?go():setTimeout(w,50);w()`;
  const parent = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)},String(process.pid)],{detached:true,stdio:"ignore"}).unref();`;
  const p = spawn(process.execPath, ["-e", parent], { stdio: "ignore" });
  await new Promise((r) => p.on("exit", r));
  const end = Date.now() + 20_000;
  while (!fs.existsSync(out)) {
    if (Date.now() > end) throw new Error("the orphan never answered");
    await new Promise((r) => setTimeout(r, 100));
  }
  return fs.readFileSync(out, "utf8");
}

const audit = () =>
  fs
    .readFileSync(path.join(s.stateDir, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(
      (l) =>
        JSON.parse(l) as {
          verb: string;
          outcome?: string;
          reason?: string;
          detail: string;
        },
    );

describe("#70: an agent's token only from its own processes", () => {
  it("from the agent's own session (this process) and its children: allowed", async () => {
    const r = await fetch(`${s.base}/api/agents/self/attention`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "finished" }),
    });
    expect(r.status).toBe(200);
    expect(fromChild()).toBe("200");
  }, 30_000);

  it("the same token from a process outside its session: refused, and audited", async () => {
    const said = await fromOrphan();
    expect(said).toMatch(/^403 agent_token_elsewhere ppid=/);
    const row = audit().find((e) => e.verb === "agent-token");
    expect(row).toMatchObject({
      outcome: "refused",
      reason: "token_elsewhere",
    });
    expect(row!.detail).toMatch(
      /agent:planner's token from outside its session \(pid \d+\): POST \/api\/agents\/self\/attention/,
    );
    // The token itself is never in the trail.
    expect(JSON.stringify(audit())).not.toContain(token);
  }, 40_000);

  it("agents.token_binding: false (the distribution's choice): any process here", async () => {
    const den = path.join(s.tmp, "dist", "config", "acme.yml");
    fs.appendFileSync(den, "\nagents:\n  token_binding: false\n");
    // Read at most every 5 s.
    await new Promise((r) => setTimeout(r, 5_500));
    expect(await fromOrphan()).toMatch(/^200 /);
  }, 40_000);
});
