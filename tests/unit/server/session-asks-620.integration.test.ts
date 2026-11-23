/**
 * Issue 620, on the real server: a session that isn't a Den agent files a
 * yes/no with the person token (its MCP server's credential). The ask is
 * bound to the process that filed it: a second process with the same
 * label is told there is no such ask. Only the person's signed-in browser
 * answers it (never the person token the asker holds, never an agent).
 * It shows in Needs you, and leaves when answered or when its process is
 * gone. Answering runs nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import { readAnswer, END } from "./helpers/child-answer.js";
import { signedIn, type SignedIn } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

let s: AgentsPageServer;
let person: SignedIn;
let agentToken = "";

beforeAll(async () => {
  s = await startAgentsPageServer();
  person = await signedIn(s.stateDir, s.base);
  const r = await fetch(`${s.base}/api/workspaces/north/agents`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ persona: "planner" }),
  });
  expect(r.status).toBe(200);
  agentToken = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

/**
 * A child process, as a session's MCP server: it runs `body` (async JS
 * with `base` and `auth` in scope) and leaves what it returns in a file.
 */
function child(body: string, name: string): { answer: string } {
  const answer = path.join(s.tmp, `${name}-${Date.now()}.out`);
  const js = `
    const base = ${JSON.stringify(s.base)};
    const auth = ${JSON.stringify(denAuth(s.stateDir))};
    const j = (r) => r.json().then((b) => ({ status: r.status, ...b }));
    (async () => { ${body} })().then(
      (v) => require("fs").writeFileSync(${JSON.stringify(answer)}, JSON.stringify(v) + ${JSON.stringify(END)}),
      (e) => require("fs").writeFileSync(${JSON.stringify(answer)}, JSON.stringify({ error: String(e) }) + ${JSON.stringify(END)}),
    );
  `;
  spawn(process.execPath, ["-e", js], { stdio: "ignore" });
  return { answer };
}
const result = async (c: { answer: string }) =>
  JSON.parse(await readAnswer(c.answer, 30_000)) as Record<string, unknown>;

const FILE = `
  const made = await fetch(base + "/api/session-asks", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ question: "Ship 0.4.87?", session: "builder" }),
  }).then(j);
`;

describe("issue 620: a session's ask, bound to its process", () => {
  it("the filer reads its own ask; another process with the same label gets 404; the person's browser answers", async () => {
    const idFile = path.join(s.tmp, `620-id-${Date.now()}`);
    // A: files, says its id, then waits for its answer (as a session does).
    const a = child(
      `${FILE}
      require("fs").writeFileSync(${JSON.stringify(idFile)}, String(made.id ?? "") + ${JSON.stringify(END)});
      const mine = await fetch(base + "/api/session-asks/" + made.id, { headers: auth }).then(j);
      for (let i = 0; i < 150; i++) {
        const r = await fetch(base + "/api/session-asks/" + made.id, { headers: auth }).then(j);
        if (r.state !== "open") return { made, mine, final: r };
        await new Promise((ok) => setTimeout(ok, 200));
      }
      return { made, mine, final: "timed out" };`,
      "a",
    );
    const id = await readAnswer(idFile, 30_000);
    expect(id).toMatch(/^sa_[0-9a-f]{24}$/);

    // B: another process, same label: no such ask.
    const b = await result(
      child(
        `return await fetch(base + "/api/session-asks/${id}", { headers: auth }).then(j);`,
        "b",
      ),
    );
    expect(b.status).toBe(404);

    // Needs you shows it, with what Den found beside the label.
    const n = (await (
      await fetch(`${s.base}/api/notifications`, { headers: person.headers })
    ).json()) as { waiting: Record<string, unknown>[] };
    const row = n.waiting.find((w) => w.id === id);
    expect(row).toMatchObject({
      kind: "session_ask",
      question: "Ship 0.4.87?",
      choices: ["yes", "no"],
      session: "builder",
    });
    expect((row!.caller as { pid: number }).pid).toBeGreaterThan(0);

    // The person token (what the asker holds) never answers.
    const byToken = await fetch(`${s.base}/api/session-asks/${id}/answer`, {
      method: "POST",
      headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
      body: JSON.stringify({ choice: "yes" }),
    });
    expect(byToken.status).toBe(403);

    // The person's signed-in browser does.
    const ok = await fetch(`${s.base}/api/session-asks/${id}/answer`, {
      method: "POST",
      headers: { ...person.headers, "content-type": "application/json" },
      body: JSON.stringify({ choice: "yes" }),
    });
    expect(ok.status).toBe(200);

    const got = await result(a);
    expect(got.made).toMatchObject({ status: 200 });
    expect(got.mine).toMatchObject({ status: 200, state: "open" });
    expect(got.final).toMatchObject({ state: "answered", answer: "yes" });

    // Answered: out of Needs you.
    const after = (await (
      await fetch(`${s.base}/api/notifications`, { headers: person.headers })
    ).json()) as { waiting: Record<string, unknown>[] };
    expect(after.waiting.some((w) => w.id === id)).toBe(false);
  }, 90_000);

  it("an ask whose process is gone leaves Needs you, and can't be answered", async () => {
    const made = await result(child(`${FILE} return made;`, "gone"));
    expect(made.status).toBe(200);
    // The child has exited: its ask is lost.
    const n = (await (
      await fetch(`${s.base}/api/notifications`, { headers: person.headers })
    ).json()) as { waiting: Record<string, unknown>[] };
    expect(n.waiting.some((w) => w.id === made.id)).toBe(false);
    const r = await fetch(`${s.base}/api/session-asks/${made.id}/answer`, {
      method: "POST",
      headers: { ...person.headers, "content-type": "application/json" },
      body: JSON.stringify({ choice: "yes" }),
    });
    expect(r.status).toBe(409);
  }, 60_000);

  it("an agent's token files none: agents use their own ask_human", async () => {
    const r = await fetch(`${s.base}/api/session-asks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "Q" }),
    });
    expect(r.status).toBe(403);
  });

  it("a bad ask is refused, and writes nothing", async () => {
    const r = await fetch(`${s.base}/api/session-asks`, {
      method: "POST",
      headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
      body: JSON.stringify({ question: "Q", choices: ["only"] }),
    });
    expect(r.status).toBe(400);
  });

  it("the audit names the session, its caller and the answer", () => {
    const audit = fs.readFileSync(
      path.join(s.stateDir, "audit.jsonl"),
      "utf-8",
    );
    const lines = audit
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as { verb?: string; outcome?: string; detail?: string },
      )
      .filter((e) => e.verb === "session-ask");
    expect(lines.map((e) => e.outcome)).toEqual(
      expect.arrayContaining(["asked", "answered", "refused"]),
    );
    const answered = lines.find((e) => e.outcome === "answered")!;
    expect(answered.detail).toMatch(/builder.*pid \d+.*yes/);
  });
});
