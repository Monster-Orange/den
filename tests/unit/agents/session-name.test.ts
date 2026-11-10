/**
 * AG-4b: a session's name, for the pane header, its tab, the Agents list
 * and ⌘K.
 *
 *   - The Claude Code adapter reads `/rename`'s record from the session's
 *     transcript (<token>.jsonl): the latest {"type":"custom-title",
 *     "customTitle":…}. The format is undocumented (the catalog marks it
 *     unofficial), so it is read defensively: a fixture here, null on any
 *     failure, never a throw. It follows the file from its last offset,
 *     at most a bounded read per ask: never the whole file at once.
 *   - The most recent rename wins, Den's (a tab's displayName) or the
 *     runtime's, by when each was made (Den's) or first seen (the
 *     runtime's, kept beside the agent's files).
 *   - The terminal title (OSC 0/2) parser, for runtimes the catalog marks
 *     titleFromOsc (none yet).
 *
 * Temp dirs only; nothing runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentSessionName,
  followState,
  oscTitles,
  resetFollowers,
  transcriptTitle,
  FOLLOW_MAX_BYTES,
} from "../../../src/shared/agents/session-name.js";
import { denClaude } from "../../../src/shared/agents/den-claude.js";
import {
  listRecords,
  readRecord,
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import { agentRows } from "../../../src/ui/cli/agent-ops.js";

const dirs: string[] = [];
afterEach(() => {
  resetFollowers();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-sname-"));
  dirs.push(d);
  return d;
}

const TOKEN = "0b4c3f7e-1d2a-4c5b-9e8f-7a6b5c4d3e2f";

/** A transcript as Claude Code writes one: one JSON record per line. */
const FIXTURE = [
  {
    type: "user",
    message: { role: "user", content: "hello" },
    sessionId: TOKEN,
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  },
  { type: "custom-title", customTitle: "first try", sessionId: TOKEN },
  { type: "user", message: { role: "user", content: 'say "custom-title"' } },
  { type: "custom-title", customTitle: "api spike", sessionId: TOKEN },
  { type: "summary", summary: "a chat" },
]
  .map((x) => JSON.stringify(x))
  .join("\n")
  .concat("\n");

function claudeDir(root: string): { env: NodeJS.ProcessEnv; file: string } {
  const config = path.join(root, "claude-config");
  const dir = path.join(config, "projects", "-work-north");
  fs.mkdirSync(dir, { recursive: true });
  return {
    env: { CLAUDE_CONFIG_DIR: config, HOME: root },
    file: path.join(dir, `${TOKEN}.jsonl`),
  };
}

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "planner",
    persona: "planner",
    runtime: "den-claude",
    workspace: "north",
    cwd: "/work/north",
    session: { backend: "den-pty", id: "s1" },
    sessionName: "acme-north:planner",
    startedAt: "2026-11-07T09:00:00.000Z",
    resumeToken: TOKEN,
    ...over,
  };
}

describe("the Claude Code adapter (unofficial: /rename's custom-title)", () => {
  it("reads the latest custom-title from the transcript fixture", () => {
    const { env, file } = claudeDir(tmp());
    fs.writeFileSync(file, FIXTURE);
    expect(denClaude.sessionName?.(rec(), env)).toBe("api spike");
  });

  it("strips one matching pair of quotes /rename kept (display only)", () => {
    const { env, file } = claudeDir(tmp());
    const named = (t: string) => {
      fs.appendFileSync(
        file,
        JSON.stringify({ type: "custom-title", customTitle: t }) + "\n",
      );
      return denClaude.sessionName?.(rec(), env);
    };
    fs.writeFileSync(file, FIXTURE);
    expect(named('"api spike"')).toBe("api spike");
    expect(named("'x'")).toBe("x");
    // Not one pair around the whole name: unchanged.
    expect(named('"a" b')).toBe('"a" b');
    expect(named("\"mixed'")).toBe("\"mixed'");
    // Only one pair goes.
    expect(named('""twice""')).toBe('"twice"');
    // Nothing inside: no name.
    expect(named('""')).toBeNull();
  });

  it("follows the file from its last offset: an appended rename is read, nothing before it again", () => {
    const { file } = claudeDir(tmp());
    fs.writeFileSync(file, FIXTURE);
    expect(transcriptTitle(file)).toBe("api spike");
    expect(followState(file)?.offset).toBe(fs.statSync(file).size);
    const before = fs.statSync(file).size;
    fs.appendFileSync(
      file,
      JSON.stringify({ type: "custom-title", customTitle: "v2" }) + "\n",
    );
    expect(transcriptTitle(file)).toBe("v2");
    expect(followState(file)?.offset).toBeGreaterThan(before);
    // Half a line: kept until its newline comes.
    fs.appendFileSync(file, '{"type":"custom-title","custom');
    expect(transcriptTitle(file)).toBe("v2");
    fs.appendFileSync(file, 'Title":"v3"}\n');
    expect(transcriptTitle(file)).toBe("v3");
  });

  it("never reads a whole large file at once: a bounded read per ask", () => {
    const { file } = claudeDir(tmp());
    const line = JSON.stringify({ type: "assistant", text: "x".repeat(1000) });
    const n = Math.ceil((FOLLOW_MAX_BYTES * 2.5) / line.length);
    fs.writeFileSync(
      file,
      `${line}\n`.repeat(n) +
        JSON.stringify({ type: "custom-title", customTitle: "late" }) +
        "\n",
    );
    const size = fs.statSync(file).size;
    expect(transcriptTitle(file)).toBeNull();
    expect(followState(file)?.offset).toBeLessThanOrEqual(FOLLOW_MAX_BYTES);
    let got: string | null = null;
    for (let i = 0; i < 5 && followState(file)!.offset < size; i++)
      got = transcriptTitle(file);
    expect(got).toBe("late");
    expect(followState(file)?.offset).toBe(size);
  });

  it("null, never a throw: no transcript, no token, a bad token, broken records, a file cut short", () => {
    const root = tmp();
    const { env, file } = claudeDir(root);
    expect(denClaude.sessionName?.(rec(), env)).toBeNull();
    expect(
      denClaude.sessionName?.(rec({ resumeToken: undefined }), env),
    ).toBeNull();
    expect(
      denClaude.sessionName?.(rec({ resumeToken: "../../etc/passwd" }), env),
    ).toBeNull();
    fs.writeFileSync(
      file,
      [
        '{"type":"custom-title","customTitle":', // not JSON
        '{"type":"custom-title","customTitle":42}',
        '{"type":"custom-title"}',
        '{"type":"custom-title","customTitle":"   "}',
        "",
      ].join("\n"),
    );
    expect(denClaude.sessionName?.(rec(), env)).toBeNull();
    // Control characters never reach the page; the name is capped.
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: "custom-title",
        customTitle: `evil\u001b[31m\u202e ${"n".repeat(200)}`,
      }) + "\n",
    );
    const got = denClaude.sessionName?.(rec(), env) ?? "";
    expect(
      [...got].some((c) => c < " " || c === "\u007f" || c === "\u202e"),
    ).toBe(false);
    expect([...got].length).toBeLessThanOrEqual(80);
    // Truncated (a new file in its place): read again from the start.
    fs.writeFileSync(file, FIXTURE.split("\n").slice(0, 3).join("\n") + "\n");
    expect(denClaude.sessionName?.(rec(), env)).toBe("first try");
    // A directory where the file was: null.
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(denClaude.sessionName?.(rec(), env)).toBeNull();
  });

  it("the other runtimes have none", async () => {
    const { getRuntime } =
      await import("../../../src/shared/agents/runtimes.js");
    for (const id of ["codex", "gemini", "grok", "generic"])
      expect(getRuntime(id)?.sessionName).toBeUndefined();
  });
});

describe("the session name: the most recent rename wins", () => {
  it("Den's rename, the runtime's, by time; the runtime's is first seen, kept per token", () => {
    const root = tmp();
    const stateDir = path.join(root, "state");
    const { env, file } = claudeDir(root);
    let now = Date.parse("2026-11-07T10:00:00.000Z");
    const at = () => now;
    // Nothing anywhere: no name.
    expect(agentSessionName(rec(), stateDir, env, at)).toBeUndefined();
    // Den's only.
    const den = rec({
      displayName: "Night watch",
      displayNameAt: "2026-11-07T09:30:00.000Z",
    });
    expect(agentSessionName(den, stateDir, env, at)).toBe("Night watch");
    // /rename later: the runtime's wins.
    fs.writeFileSync(file, FIXTURE);
    expect(agentSessionName(den, stateDir, env, at)).toBe("api spike");
    // Asked again later, the same name: still first seen at 10:00.
    now += 60_000;
    expect(agentSessionName(den, stateDir, env, at)).toBe("api spike");
    // A Den rename after that wins.
    const later = rec({
      displayName: "Day shift",
      displayNameAt: "2026-11-07T10:00:30.000Z",
    });
    expect(agentSessionName(later, stateDir, env, at)).toBe("Day shift");
    // A new /rename after that wins again.
    now += 60_000;
    fs.appendFileSync(
      file,
      JSON.stringify({ type: "custom-title", customTitle: "round two" }) + "\n",
    );
    expect(agentSessionName(later, stateDir, env, at)).toBe("round two");
    // Start fresh (a new token): the old conversation's name is gone.
    expect(
      agentSessionName(
        { ...later, resumeToken: "1b4c3f7e-1d2a-4c5b-9e8f-7a6b5c4d3e2f" },
        stateDir,
        env,
        at,
      ),
    ).toBe("Day shift");
  });

  it("a runtime with no adapter (Codex): Den's name only; an adapter that throws breaks nothing", () => {
    const root = tmp();
    const stateDir = path.join(root, "state");
    expect(
      agentSessionName(rec({ runtime: "codex" }), stateDir, {}, () => 0),
    ).toBeUndefined();
    expect(
      agentSessionName(
        rec({ runtime: "codex", displayName: "x" }),
        stateDir,
        {},
        () => 0,
      ),
    ).toBe("x");
    expect(
      agentSessionName(rec({ runtime: "nope" }), stateDir, {}, () => 0),
    ).toBeUndefined();
  });
});

describe("the terminal title (OSC 0/2), for runtimes that opt in", () => {
  it("parses OSC 0 and 2, BEL or ST ended, across chunks; ignores other OSCs", () => {
    let r = oscTitles("a\u001b]0;hello\u0007b\u001b]2;world\u001b\\c", "");
    expect(r.titles).toEqual(["hello", "world"]);
    expect(r.carry).toBe("");
    r = oscTitles("x\u001b]2;spl", "");
    expect(r.titles).toEqual([]);
    r = oscTitles("it\u0007", r.carry);
    expect(r.titles).toEqual(["split"]);
    // OSC 8 (a link) and OSC 7 (the cwd) are not titles.
    expect(
      oscTitles(
        "\u001b]8;;https://x.test\u0007l\u001b]8;;\u0007\u001b]7;file:///a\u0007",
        "",
      ).titles,
    ).toEqual([]);
    // An unended one never grows past its cap.
    r = oscTitles("\u001b]0;" + "z".repeat(10_000), "");
    expect(r.carry.length).toBeLessThanOrEqual(1024);
  });
});

describe("sessionName is the session handle; sessionTitle is the name shown (0.4.13)", () => {
  /** A record as 0.4.12 wrote it, byte for byte the fields it had. */
  const OLD = {
    id: "planner",
    persona: "planner",
    runtime: "den-claude",
    workspace: "north",
    cwd: "/work/north",
    session: { backend: "den-pty", id: "s1" },
    sessionName: "acme-north:planner",
    startedAt: "2026-11-07T09:00:00.000Z",
    resumeToken: TOKEN,
    launched: true,
    grants: [],
    displayName: "Night watch",
    displayNameAt: "2026-11-07T09:30:00.000Z",
    stoppedAt: "2026-11-07T11:00:00.000Z",
  };

  it("a record 0.4.12 wrote reads whole: its sessionName handle and every other field stay, and a rewrite loses nothing", () => {
    const stateDir = path.join(tmp(), "state");
    fs.mkdirSync(path.join(stateDir, "agents"), { recursive: true });
    const file = path.join(stateDir, "agents", "planner.json");
    fs.writeFileSync(file, JSON.stringify(OLD, null, 2) + "\n");
    expect(readRecord(stateDir, "planner")).toEqual(OLD);
    expect(listRecords(stateDir)).toEqual([OLD]);
    writeRecord(stateDir, readRecord(stateDir, "planner")!);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual(OLD);
  });

  it("agents list --json and /api/sessions: the name shown is sessionTitle; sessionName (the handle) is never the display name", () => {
    const root = tmp();
    const stateDir = path.join(root, "state");
    const rows = agentRows([], [OLD as AgentRecord], stateDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionTitle).toBe("Night watch");
    expect(rows[0]).not.toHaveProperty("sessionName");
    // No name anywhere: no sessionTitle either.
    const plain = { ...OLD, displayName: undefined, displayNameAt: undefined };
    expect(
      agentRows([], [plain as AgentRecord], stateDir)[0],
    ).not.toHaveProperty("sessionTitle");
  });
});

describe("D24: the name peers see (Claude Code's session name)", () => {
  it("is <cli>-<workspace>:<the agent's name, else its id>", async () => {
    const { peerSessionName } =
      await import("../../../src/shared/agents/session-name.js");
    expect(peerSessionName("acme", "north", rec())).toBe("acme-north:planner");
    expect(
      peerSessionName("acme", "north", rec({ displayName: "Night watch" })),
    ).toBe("acme-north:Night watch");
    // Never a control character in a process argument.
    expect(
      peerSessionName("acme", "north", rec({ displayName: "a\u001b[2Jb\n" })),
    ).toBe("acme-north:a[2Jb");
  });

  it("Den's own --name, read back from the transcript, is not a rename", () => {
    const root = tmp();
    const stateDir = path.join(root, "state");
    const { env, file } = claudeDir(root);
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: "custom-title",
        customTitle: "acme-north:Night watch",
        sessionId: TOKEN,
      }) + "\n",
    );
    const r = rec({
      displayName: "Night watch",
      displayNameAt: "2026-11-07T09:30:00.000Z",
      peerName: "acme-north:Night watch",
    });
    expect(agentSessionName(r, stateDir, env, () => Date.now())).toBe(
      "Night watch",
    );
  });
});
