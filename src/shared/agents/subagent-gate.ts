export const SUBAGENT_RESERVE_MS = 120_000;
export const SUBAGENT_START_SKEW_MS = 5_000;

export interface SubagentGateDeps {
  maxSubagents: () => number;
  respectLoadHold: () => boolean;
  loadCeiling: () => number | undefined;
  load1: () => number;
  running: () => readonly { agent: string; startedAt?: number }[];
  now?: () => number;
}

export type SubagentDecision =
  | { ok: true }
  | { ok: false; reason: "max_subagents" | "load_hold"; message: string };

export class SubagentGate {
  private readonly reserved = new Map<string, number[]>();

  constructor(private readonly deps: SubagentGateDeps) {}

  private live(now: number): void {
    for (const [agent, times] of this.reserved) {
      const kept = times.filter((t) => now - t < SUBAGENT_RESERVE_MS);
      if (kept.length) this.reserved.set(agent, kept);
      else this.reserved.delete(agent);
    }
  }

  count(
    now: number,
    running: readonly {
      agent: string;
      startedAt?: number;
    }[] = this.deps.running(),
  ): number {
    this.live(now);
    const byAgent = new Map<string, number[]>();
    for (const r of running) {
      const list = byAgent.get(r.agent) ?? [];
      list.push(r.startedAt ?? 0);
      byAgent.set(r.agent, list);
    }
    let total = 0;
    for (const agent of new Set([...byAgent.keys(), ...this.reserved.keys()])) {
      const starts = byAgent.get(agent) ?? [];
      const held = this.reserved.get(agent) ?? [];
      if (!held.length) {
        total += starts.length;
        continue;
      }
      const since = Math.min(...held) - SUBAGENT_START_SKEW_MS;
      const before = starts.filter((t) => t < since).length;
      total += before + Math.max(held.length, starts.length - before);
    }
    return total;
  }

  decide(
    agent: string,
    running: readonly {
      agent: string;
      startedAt?: number;
    }[] = this.deps.running(),
  ): SubagentDecision {
    const now = (this.deps.now ?? Date.now)();
    const ceiling = this.deps.loadCeiling();
    if (this.deps.respectLoadHold() && ceiling !== undefined) {
      const load = this.deps.load1();
      if (load > ceiling)
        return {
          ok: false,
          reason: "load_hold",
          message: `The machine is under load (load ${load.toFixed(1)} over ${ceiling}, agents.subagents_respect_load_hold); wait, or start fewer.`,
        };
    }
    const max = this.deps.maxSubagents();
    const count = this.count(now, running);
    if (count >= max)
      return {
        ok: false,
        reason: "max_subagents",
        message: `Den's subagent limit is reached (${Math.min(count, max)} of ${max} running, agents.max_subagents); start fewer, or wait.`,
      };
    this.reserved.set(agent, [...(this.reserved.get(agent) ?? []), now]);
    return { ok: true };
  }
}
