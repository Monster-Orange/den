/**
 * A usage fixture (den#6): eleven agent records and the transcripts their
 * runtimes left, the way Claude Code writes them
 * (<projects>/<cwd slug>/<conversation id>.jsonl, subagents under
 * <conversation id>/subagents/). Ten are den-claude agents with a
 * transcript; one is a codex agent, which no usage source reads. Invented
 * names, ids and URLs only.
 */
import * as fs from "fs";
import * as path from "path";
import {
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";

const T0 = Date.parse("2026-11-05T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
export const token = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function line(o: unknown): string {
  return JSON.stringify(o) + "\n";
}

/** One assistant call with usage, and optionally a Bash tool use. */
function call(
  i: number,
  at: number,
  model: string,
  bash?: { id: string; command: string },
): string {
  return line({
    type: "assistant",
    timestamp: iso(at),
    message: {
      id: `msg_${i}_${at}`,
      model,
      usage: {
        input_tokens: 10,
        output_tokens: 200,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 1_000,
      },
      content: bash
        ? [
            {
              type: "tool_use",
              id: bash.id,
              name: "Bash",
              input: { command: bash.command },
            },
          ]
        : [{ type: "text", text: "working" }],
    },
  });
}

function result(
  at: number,
  id: string,
  isError: boolean,
  text: string,
): string {
  return line({
    type: "user",
    timestamp: iso(at),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError,
          content: text,
        },
      ],
    },
  });
}

function prompt(at: number, text: string): string {
  return line({
    type: "user",
    timestamp: iso(at),
    message: { role: "user", content: text },
  });
}

export interface UsageFixture {
  projects: string;
  stateDir: string;
  records: AgentRecord[];
}

/** Write the fixture under `root`. */
export function writeUsageFixture(root: string): UsageFixture {
  const projects = path.join(root, "claude", "projects");
  const stateDir = path.join(root, "state");
  const slug = path.join(projects, "-work-north");
  fs.mkdirSync(slug, { recursive: true });
  const records: AgentRecord[] = [];
  for (let i = 1; i <= 10; i++) {
    const start = T0 + i * 3_600_000;
    let text = prompt(start, "plan the release");
    text += call(i, start + 60_000, "claude-opus-5-5");
    // Agents 1-6 run the tests: 1-4 green, 5-6 red.
    if (i <= 6) {
      const id = `toolu_t${i}`;
      text += call(i, start + 120_000, "claude-opus-5-5", {
        id,
        command: "npm test",
      });
      text += result(
        start + 180_000,
        id,
        i >= 5,
        i >= 5 ? "1 failing" : "all passed",
      );
    }
    // Agents 1-3 open a pull request; agent 1 merges it.
    if (i <= 3) {
      const id = `toolu_pr${i}`;
      text += call(i, start + 240_000, "claude-opus-5-5", {
        id,
        command: "gh pr create --fill",
      });
      text += result(
        start + 250_000,
        id,
        false,
        `https://github.com/acme/notes/pull/${100 + i}`,
      );
    }
    if (i === 1) {
      text += call(i, start + 300_000, "claude-opus-5-5", {
        id: "toolu_m1",
        command: "gh pr merge --squash",
      });
      text += result(start + 310_000, "toolu_m1", false, "merged");
    }
    // Agent 7 polls, and is corrected.
    if (i === 7) {
      text += call(i, start + 200_000, "claude-opus-5-5", {
        id: "toolu_p7",
        command: "sleep 30 && curl localhost",
      });
      text += prompt(start + 400_000, "that's wrong, stop polling");
    }
    text += line({
      type: "system",
      subtype: "compact_boundary",
      timestamp: iso(start + 500_000),
    });
    text += call(i, start + 900_000, "claude-opus-5-5");
    fs.writeFileSync(path.join(slug, `${token(i)}.jsonl`), text);
    // Agent 2 had a subagent, on Sonnet.
    if (i === 2) {
      const sub = path.join(slug, token(i), "subagents");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(
        path.join(sub, "agent-explore.jsonl"),
        call(99, start + 100_000, "claude-sonnet-5-5") +
          call(98, start + 110_000, "claude-sonnet-5-5"),
      );
    }
    const rec: AgentRecord = {
      id: `agent-${i}`,
      persona: "be-dev",
      runtime: "den-claude",
      workspace: "north",
      cwd: "/work/north",
      session: { backend: "den-pty", id: `s${i}` },
      sessionName: `acme-north:agent-${i}`,
      startedAt: iso(start),
      stoppedAt: iso(start + 1_000_000),
      resumeToken: token(i),
    };
    records.push(rec);
  }
  records.push({
    id: "coder",
    persona: "be-dev",
    runtime: "codex",
    workspace: "north",
    cwd: "/work/north",
    session: { backend: "den-pty", id: "s11" },
    sessionName: "acme-north:coder",
    startedAt: iso(T0),
  });
  for (const r of records) writeRecord(stateDir, r);
  return { projects, stateDir, records };
}
