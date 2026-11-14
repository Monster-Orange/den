/**
 * Restart --now on a brand-new agent: started, someone pressed Enter (the
 * runtime's first-run question), nothing saved yet. Its session counts as
 * prompted, so the restart tries the runtime's resume; the runtime says no
 * conversation, and Den starts it fresh under the same id, once. It comes
 * up either way.
 *
 * A real host on a temp socket and a scripted PTY: the test plays what the
 * runtime prints. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const head = (r: Rig, i: number) => r.made[i].args.slice(0, 2);

/** Each program ends shortly after a TERM, as a real one does. */
function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const push = r.made.push.bind(r.made);
  r.made.push = (...ps) => {
    for (const p of ps) {
      const kill = p.kill.bind(p);
      p.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => p.exit(143), 5);
      };
    }
    return push(...ps);
  };
}

/** A person presses Enter in the agent's terminal (no conversation yet). */
async function pressEnter(r: Rig): Promise<void> {
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  try {
    const s = (await c.list()).find((x) => !x.exited)!;
    c.write(s.ref.id, Buffer.from("\r", "utf-8"));
    await c.list();
  } finally {
    c.close();
  }
}

/** When launch number `i` appears, it prints `text` and exits 1. */
function answers(r: Rig, i: number, text: string): Promise<void> {
  return (async () => {
    for (let n = 0; n < 200 && r.made.length <= i; n++) await settle(10);
    r.made[i].emit(`${text}\r\n`);
    r.made[i].exit(1);
  })();
}

describe("restart --now on a new agent with nothing saved", () => {
  it("comes up: a resume told no conversation starts fresh under the same id", async () => {
    const r = await rig();
    r.deps.exitWatchMs = 300;
    endOnTerm(r);
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const token = readRecord(r.stateDir, "planner")!.resumeToken!;
    await pressEnter(r);
    const said = answers(r, 1, "No conversation found with session ID: x");
    const code = await agents(r, "restart", "planner", "--now");
    await said;
    expect({ code, err: r.err.join("\n") }).toEqual({ code: 0, err: "" });
    expect(head(r, 1)).toEqual(["--resume", token]);
    expect(head(r, 2)).toEqual(["--session-id", token]);
    expect(r.made).toHaveLength(3);
  }, 20_000);
});
