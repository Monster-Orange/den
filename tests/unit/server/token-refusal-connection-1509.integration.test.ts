/**
 * Issue 1509: a refused agent token's audit row records the connection it
 * came on: the socket's remote address, the Host it dialed, the forwarded
 * client addresses a proxy said (as IPs only, never believed), and whether
 * the edge proved the request. Enough to find the caller afterwards when
 * no other log was on. Never the token.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { denAuth } from "./helpers/den-auth.js";
import { readAnswer, writeAnswerJs } from "./helpers/child-answer.js";
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

const XFF = "not-an-ip, 198.51.100.7, 203.0.113.9:4431";

/** A process outside the agent's session calls with its token. */
async function fromOrphan(): Promise<string> {
  const out = path.join(s.tmp, `orphan-${Date.now()}.txt`);
  const call = `fetch(${JSON.stringify(s.base + "/api/agents/self/attention")},{method:"POST",headers:{authorization:"Bearer "+${JSON.stringify(token)},"x-forwarded-for":${JSON.stringify(XFF)},"content-type":"application/json"},body:JSON.stringify({event:"finished"})}).then(async r=>{const b=await r.json().catch(()=>({}));return r.status+" "+(b.code||"")})`;
  const write = writeAnswerJs(out, "x");
  const grandchild = `const p0=Number(process.argv[1]);const go=()=>${call}.then(x=>{${write}});const w=()=>process.ppid!==p0?go():setTimeout(w,50);w()`;
  const parent = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)},String(process.pid)],{detached:true,stdio:"ignore"}).unref();`;
  const p = spawn(process.execPath, ["-e", parent], { stdio: "ignore" });
  await new Promise((r) => p.on("exit", r));
  return readAnswer(out, 20_000, "the orphan");
}

const audit = () =>
  fs
    .readFileSync(path.join(s.stateDir, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("issue 1509: a refused agent token's row keeps its connection", () => {
  it("token_elsewhere: remote address, Host, forwarded IPs, edge proof", async () => {
    expect(await fromOrphan()).toMatch(/^403 agent_token_elsewhere/);
    const row = audit().find((e) => e.verb === "agent-token");
    expect(row).toMatchObject({
      outcome: "refused",
      reason: "token_elsewhere",
      connection: {
        remote: "127.0.0.1",
        host: new URL(s.base).host,
        forwardedFor: ["198.51.100.7", "203.0.113.9"],
        edgeProved: false,
      },
    });
    expect(JSON.stringify(audit())).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain("not-an-ip");
  }, 40_000);
});
