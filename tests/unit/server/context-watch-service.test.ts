/**
 * Issue 278, as the server runs it:
 *   1. a running agent whose automatic compactions loop rings the bell
 *      once per episode, with one log line naming it (and the likely
 *      cause, when its start's instruction check warned);
 *   3. with pause_after_loop on, it is among the agents Den doesn't type
 *      into (deliveries wait) until a person clears it; off, it never is.
 *
 * Temp dirs, invented names, synthetic compactions; nothing runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentFilesDir,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import {
  CONTEXT_WATCH_DEFAULTS,
  instructionCheck,
  readCompacting,
  writeInstructionCheck,
  type ContextWatchSettings,
} from "../../../src/shared/agents/context-watch.js";
import type { Compaction } from "../../../src/shared/agents/transcript-follow.js";
import {
  checkCompactions,
  clearAgentCompacting,
  pausedAgents,
} from "../../../src/ui/server/context-watch-service.js";
import { typingHeld } from "../../../src/ui/server/attention.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-ctxs-"));
  dirs.push(d);
  return d;
}

const T0 = Date.parse("2026-03-01T10:00:00.000Z");

function rec(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    persona: "scout",
    runtime: "den-claude",
    workspace: "north",
    cwd: "/work/north",
    session: { backend: "pty", id: `s-${id}` },
    sessionName: `den-north:${id}`,
    startedAt: new Date(T0).toISOString(),
    resumeToken: `tok-${id}`,
    ...extra,
  } as AgentRecord;
}

function rigOf(
  records: AgentRecord[],
  settings: Partial<ContextWatchSettings> = {},
) {
  const stateDir = tmp();
  const notes: {
    kind: string;
    subject: string;
    text: string;
    msg?: unknown;
  }[] = [];
  const logs: string[] = [];
  const comp = new Map<string, Compaction[]>();
  let now = T0;
  const deps = {
    stateDir: () => stateDir,
    records: () => records,
    settings: () => ({ ...CONTEXT_WATCH_DEFAULTS, ...settings }),
    compactions: (r: AgentRecord) => comp.get(r.id) ?? null,
    store: {
      add: (n: {
        kind: string;
        subject: string;
        text: string;
        msg?: unknown;
      }) => {
        notes.push(n);
        return null;
      },
    },
    nameOf: (r: AgentRecord) => r.displayName ?? r.id,
    log: (l: string) => logs.push(l),
    now: () => now,
  };
  return {
    stateDir,
    notes,
    logs,
    deps,
    /** An automatic compaction now (minutes from T0). */
    compact: (id: string, min: number, auto = true) => {
      now = T0 + min * 60_000;
      comp.set(id, [...(comp.get(id) ?? []), { at: now, auto }]);
    },
    at: (min: number) => (now = T0 + min * 60_000),
  };
}

describe("issue 278 clause 1: the compaction-loop bell", () => {
  it("rings once per episode, with a log line naming the agent", () => {
    const r = rigOf([rec("scout", { displayName: "Rita" }), rec("calm")]);
    for (const m of [0, 0.75, 1.5, 2.25, 3, 3.75, 4.5, 5.25]) {
      r.compact("scout", m);
      checkCompactions(r.deps);
    }
    r.compact("calm", 1, false);
    checkCompactions(r.deps);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({
      kind: "service",
      subject: "agent:scout",
      msg: { key: "bell.m.compacting", vars: { name: "Rita", m: 10 } },
    });
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(
      /Rita \(scout\) in north is compacting repeatedly/,
    );
    expect(readCompacting(agentFilesDir(r.stateDir, "scout"))).toMatchObject({
      active: true,
      count: 8,
    });
    // Quiet, then a new loop: a second bell.
    r.at(60);
    checkCompactions(r.deps);
    for (const m of [61, 62, 63, 64]) {
      r.compact("scout", m);
      checkCompactions(r.deps);
    }
    expect(r.notes).toHaveLength(2);
  });

  it("the log names the likely cause when the start's check warned", () => {
    const r = rigOf([rec("scout")]);
    writeInstructionCheck(
      agentFilesDir(r.stateDir, "scout"),
      instructionCheck(
        [{ path: "/work/north/CLAUDE.md", bytes: 840 * 1024 }],
        "/work/north",
        { sharePercent: 15, contextTokens: 200_000 },
      ),
    );
    for (const m of [0, 1, 2, 3]) {
      r.compact("scout", m);
      checkCompactions(r.deps);
    }
    expect(r.logs[0]).toContain("likely cause: instruction files are 840 KB");
    expect(r.logs[0]).toContain("CLAUDE.md (840 KB)");
  });

  it("a stopped agent is not looked at", () => {
    const r = rigOf([rec("scout", { stoppedAt: new Date(T0).toISOString() })]);
    for (const m of [0, 1, 2, 3, 4]) {
      r.compact("scout", m);
      checkCompactions(r.deps);
    }
    expect(r.notes).toHaveLength(0);
  });
});

describe("issue 278 clause 3: the optional pause", () => {
  const loop = (r: ReturnType<typeof rigOf>) => {
    for (const m of [0, 1, 2, 3]) {
      r.compact("scout", m);
      checkCompactions(r.deps);
    }
  };

  it("off (the default): deliveries are never held", () => {
    const records = [rec("scout")];
    const r = rigOf(records);
    loop(r);
    expect(r.notes).toHaveLength(1);
    const paused = pausedAgents(r.stateDir, () => records, T0 + 10 * 60_000);
    expect(typingHeld(new Map(), [], paused).has("scout")).toBe(false);
  });

  it("on: held from the bell until a person clears it", () => {
    const records = [rec("scout")];
    const r = rigOf(records, { pause: true });
    loop(r);
    expect(r.logs[0]).toContain("new deliveries wait until a person clears it");
    let paused = pausedAgents(r.stateDir, () => records, T0 + 10 * 60_000);
    expect(typingHeld(new Map(), [], paused).has("scout")).toBe(true);
    // The loop ends: still held for its person.
    r.at(60);
    checkCompactions(r.deps);
    paused = pausedAgents(r.stateDir, () => records, T0 + 70 * 60_000);
    expect(paused.has("scout")).toBe(true);
    clearAgentCompacting(r.stateDir, records[0]);
    paused = pausedAgents(r.stateDir, () => records, T0 + 70 * 60_000 + 1);
    expect(typingHeld(new Map(), [], paused).has("scout")).toBe(false);
  });
});
