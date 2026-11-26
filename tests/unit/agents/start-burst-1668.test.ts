import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import {
  markInterrupted,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { restartQueue } from "../../../src/ui/server/restart-queue-service.js";

const AGENTS = 40;
let dir = "";
const savedHome = process.env.DEN_HOME;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1668s-")));
  process.env.DEN_HOME = dir;
  for (let i = 0; i < AGENTS; i++)
    writeRecord(dir, {
      id: `a${i}`,
      persona: "builder",
      runtime: "den-claude",
      workspace: "north",
      cwd: dir,
      session: { backend: "den-pty", id: `gone-${i}` },
      sessionName: `acme-north:a${i}`,
      startedAt: "2026-11-01T09:59:00.000Z",
    } as Parameters<typeof writeRecord>[1]);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.DEN_HOME;
  else process.env.DEN_HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

const turnsDuring = async (fn: () => Promise<unknown>): Promise<number> => {
  let turns = 0;
  let on = true;
  const spin = () => {
    if (!on) return;
    turns++;
    setImmediate(spin);
  };
  setImmediate(spin);
  await fn();
  on = false;
  return turns;
};

describe("a start with many interrupted agents never holds the server", () => {
  it("markInterrupted lets the event loop turn between agents", async () => {
    const d = resolveAgentsDeps({
      stateDir: () => dir,
      connectExisting: async () => null,
    } as Parameters<typeof resolveAgentsDeps>[0]);
    let found: Awaited<ReturnType<typeof markInterrupted>> | undefined;
    const turns = await turnsDuring(async () => {
      found = await markInterrupted(d, { autoResume: false });
    });
    expect(found?.interrupted).toHaveLength(AGENTS);
    expect(turns).toBeGreaterThanOrEqual(AGENTS);
  });

  it("many adds in one turn write the bell once, with the last count", async () => {
    const adds: string[] = [];
    const q = restartQueue({
      store: () => ({
        add: (n: { text: string }) => {
          adds.push(n.text);
          return n as never;
        },
        remove: () => 0 as never,
      }),
    });
    adds.length = 0;
    for (let i = 0; i < AGENTS; i++)
      void q.add({
        id: `b${i}`,
        why: "resume",
        run: () => new Promise(() => undefined),
      });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(adds.length).toBeLessThanOrEqual(2);
    expect(adds.at(-1)).toMatch(/agents waiting to restart/);
  });
});
