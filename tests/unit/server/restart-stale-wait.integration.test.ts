/**
 * Issue 369: a "needs your permission" bell row from before a server
 * restart stayed in the bell for good (one 21 h old, for an agent stopped
 * the day before). The #327 sweep walks only the waits in memory, and a
 * row kept across a restart has none. At start, and on the attention
 * check after it, Den looks at each such row's agent: stopped, removed or
 * exited, or no permission dialog on its screen, and the row goes; still
 * showing the dialog, the row stays and is a live wait again.
 * The real server on the demo distribution, the scripted PTY. Invented
 * names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { NotificationStore } from "../../../src/shared/notifications.js";

let s: AgentsPageServer;

beforeAll(async () => {
  s = await startAgentsPageServer();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** What the bell says about agent `id`: its wait, and its rows. */
async function bellFor(id: string) {
  const { json } = await call("GET", "/api/notifications");
  const waiting = (json.waiting as { agent: string; why: string }[]).find(
    (w) => w.agent === id,
  );
  const groups = json.groups as {
    subjects: { subject: string; items: { text: string }[] }[];
  }[];
  const rows = groups
    .flatMap((g) => g.subjects)
    .filter((x) => x.subject === `agent:${id}`)
    .flatMap((x) => x.items.map((i) => i.text));
  return { why: waiting?.why ?? null, rows };
}

/** Claude Code's permission dialog, as its terminal draws it. */
const DIALOG = [
  "\x1b[2J\x1b[H",
  "Bash command\r\n",
  "  npm test\r\n",
  "  Run the tests\r\n\r\n",
  "Do you want to proceed?\r\n",
  "\x1b[36m❯\x1b[0m 1. Yes\r\n",
  "  2. Yes, and don't ask again for npm test commands in /work/north/notes\r\n",
  "  3. No, and tell Claude what to do differently (esc)\r\n",
].join("");

async function start(id: string) {
  const r = await call("POST", "/api/workspaces/north/agents", {
    persona: "planner",
    id,
  });
  expect(r.status).toBe(200);
  return s.made.at(-1)!;
}

describe("issue 369: a wait from before a restart doesn't stay in the bell", () => {
  it("withdraws a stopped agent's row and a not-waiting agent's row; keeps a real wait", async () => {
    // (a) stopped since before the restart.
    const gone = await start("p-stopped");
    gone.emit("> ");
    const stop = call("POST", "/api/workspaces/north/agents/p-stopped/stop");
    setTimeout(() => gone.exit(0), 300);
    expect((await stop).status).toBe(200);
    // (b) running, at its prompt: no dialog.
    const idle = await start("p-idle");
    idle.emit("\x1b[2J\x1b[H> ");
    // (c) running, its permission dialog still open.
    const asks = await start("p-asks");
    asks.emit(DIALOG);
    await pause(300);

    await s.webDown();
    // The rows the old server kept, an hour before.
    const before = new NotificationStore(
      s.stateDir,
      () => new Date(Date.now() - 3_600_000),
    );
    for (const id of ["p-stopped", "p-idle", "p-asks"])
      before.add({
        kind: "waiting",
        subject: `agent:${id}`,
        scope: "workspace/north",
        text: `${id} needs your permission: Bash`,
        msg: {
          key: "bell.m.permissionWhat",
          vars: { name: id, what: "Bash" },
        },
        link: `/agents?project=north&agent=${id}`,
      });
    await s.webUp();

    // At start, or the 2 s check after it.
    let a = await bellFor("p-stopped");
    let b = await bellFor("p-idle");
    for (let i = 0; i < 20 && (a.rows.length || b.rows.length); i++) {
      await pause(500);
      a = await bellFor("p-stopped");
      b = await bellFor("p-idle");
    }
    expect(a).toEqual({ why: null, rows: [] });
    expect(b).toEqual({ why: null, rows: [] });
    // (c) still waits: its row stays, and it is a live wait again.
    expect(await bellFor("p-asks")).toEqual({
      why: "permission",
      rows: ["p-asks needs your permission: Bash"],
    });
  }, 90_000);
});
