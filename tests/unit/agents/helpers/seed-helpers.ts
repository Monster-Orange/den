/**
 * D32 test data: Claude Code's files for an agent's helpers, written under
 * a test's own HOME (never this machine's), and the agent's record.
 *
 *   <home>/.claude/projects/-work-north/<token>.jsonl             the conversation
 *   <home>/.claude/projects/-work-north/<token>/subagents/agent-<id>.{meta.json,jsonl}
 *
 * Invented ids, workspaces and prompts only.
 */
import * as fs from "fs";
import * as path from "path";
import { writeRecord } from "../../../../src/shared/agents/records.js";

export const TOKEN = "00000000-0000-4000-8000-0000000000e1";
export const EARLIER_TOKEN = "00000000-0000-4000-8000-0000000000e0";
export const H1 = "a3f0c0ffee0000003";
export const H0 = "a4f0c0ffee0000004";

const AT = Date.parse("2026-11-01T10:00:00.000Z");

/** One finished helper of conversation `token`: a prompt, then `lines - 1` steps. */
export function writeHelper(
  home: string,
  token: string,
  id: string,
  description: string,
  lines = 3,
): void {
  const proj = path.join(home, ".claude", "projects", "-work-north");
  const sub = path.join(proj, token, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(proj, `${token}.jsonl`), "{}\n");
  fs.writeFileSync(
    path.join(sub, `agent-${id}.meta.json`),
    JSON.stringify({
      agentType: "Explore",
      description,
      spawnDepth: 1,
      finished: true,
    }),
  );
  const out: object[] = [
    {
      type: "user",
      isSidechain: true,
      timestamp: new Date(AT).toISOString(),
      message: { role: "user", content: description },
    },
  ];
  for (let i = 1; i < lines; i++)
    out.push({
      type: "assistant",
      isSidechain: true,
      timestamp: new Date(AT + i * 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `step ${i}` }],
      },
    });
  fs.writeFileSync(
    path.join(sub, `agent-${id}.jsonl`),
    out.map((o) => JSON.stringify(o)).join("\n") + "\n",
  );
}

/**
 * A stopped agent "scout" in north with helper H1 ("Count the notes") in
 * its conversation; with `earlier`, it relaunched once, and its earlier
 * conversation had helper H0 ("Sort the notes").
 */
export function seedScout(
  stateDir: string,
  cwd: string,
  home: string,
  opts: { lines?: number; earlier?: boolean } = {},
): void {
  writeHelper(home, TOKEN, H1, "Count the notes", opts.lines);
  if (opts.earlier) writeHelper(home, EARLIER_TOKEN, H0, "Sort the notes");
  writeRecord(stateDir, {
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    cwd,
    session: { backend: "den-pty", id: "gone-scout" },
    sessionName: "acme-north:scout",
    startedAt: "2026-11-01T09:59:00.000Z",
    resumeToken: TOKEN,
    ...(opts.earlier
      ? {
          rotations: [
            {
              at: "2026-11-01T09:58:00.000Z",
              reason: "compactions" as const,
              compactions: 3,
              conversation: EARLIER_TOKEN,
            },
          ],
        }
      : {}),
  });
}
