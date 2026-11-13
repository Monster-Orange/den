/**
 * D56: bring in a conversation started outside the project (its folder is
 * ~, say), and resume it only where it started; never two writers on one
 * conversation.
 *
 *   - Bring-in lists conversations started outside every project as
 *     "outside"; one inside another project's folder stays refused (409).
 *   - Bringing one in is one explicit ask that names its folder
 *     (`--outside <folder>`); the record says `outside: true`.
 *   - Never `/`, a system folder, Den's state folder, or inside them.
 *   - The gate: a conversation whose folder is ~ comes in, stops, and
 *     resumes in ~ on the same conversation.
 *   - Every resume checks its folder still exists and is the one the
 *     conversation ran in; else it refuses and says why.
 *   - Two writers: a live process with the conversation open (its runtime
 *     session record: pid alive, same start time) refuses bring-in and
 *     resume; a dead pid or another start time doesn't.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs), temp
 * folders for ~ and the runtime's config. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { claudeSlug } from "../../../src/shared/agents/conversations.js";
import { procStartOf } from "../../../src/shared/agents/open-check.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  listConversations,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const TOKEN = "0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19";

interface Setup {
  r: Rig;
  home: string;
  claude: string;
}

async function setup(): Promise<Setup> {
  const r = await rig();
  const home = path.join(r.dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const claude = path.join(r.dir, "claude-config");
  fs.mkdirSync(path.join(claude, "projects"), { recursive: true });
  r.deps.env = { ...r.deps.env, HOME: home, CLAUDE_CONFIG_DIR: claude };
  // Its PTY ends on TERM, as a real one does.
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
  return { r, home, claude };
}

/** A conversation that ran in `cwd`, its last turn ended a while ago. */
function conversation(s: Setup, cwd: string, token = TOKEN): string {
  const dir = path.join(s.claude, "projects", claudeSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd, message: { content: "Plan the week" } },
      {
        type: "assistant",
        message: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Planned." }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, t, t);
  return file;
}

/** The runtime's own session record for a process holding `token`. */
function sessionRecord(
  s: Setup,
  pid: number,
  token = TOKEN,
  procStart = procStartOf(pid) ?? "Thu Jan  1 00:00:00 1970",
): void {
  const dir = path.join(s.claude, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: token, cwd: s.home, procStart }),
  );
}

const bring = (s: Setup, ...more: string[]) =>
  agents(
    s.r,
    "import",
    "-w",
    "north",
    "--session",
    TOKEN,
    "--persona",
    "planner",
    ...more,
  );

describe("D56: a conversation started in ~", () => {
  it("is listed as outside, and comes in only with an ask that names its folder", async () => {
    const s = await setup();
    conversation(s, s.home);
    const d = resolveAgentsDeps(s.r.deps);
    const l = listConversations(d, "north");
    expect(l.conversations.map((c) => c.id)).not.toContain(TOKEN);
    expect(l.outside.map((c) => [c.id, c.cwd])).toEqual([[TOKEN, s.home]]);
    // No ask: refused, and the hint names the folder to ask with.
    expect(await bring(s)).toBe(1);
    expect(s.r.err.join("\n")).toContain(
      `started outside project north, in ${s.home}`,
    );
    expect(s.r.err.join("\n")).toContain(`--outside ${s.home}`);
    expect(readRecord(s.r.stateDir, "planner")).toBeNull();
    // An ask that names another folder isn't this one's.
    expect(await bring(s, "--outside", path.join(s.home, "other"))).toBe(1);
    expect(readRecord(s.r.stateDir, "planner")).toBeNull();
  });

  it("the gate: brought in from ~, stopped, resumed in ~ on the same conversation", async () => {
    const s = await setup();
    conversation(s, s.home);
    expect(await bring(s, "--outside", s.home)).toBe(0);
    const rec = readRecord(s.r.stateDir, "planner")!;
    expect(rec).toMatchObject({
      cwd: s.home,
      outside: true,
      resumeToken: TOKEN,
    });
    expect(s.r.made[0].opts.cwd).toBe(s.home);
    expect(s.r.made[0].args.slice(0, 2)).toEqual(["--resume", TOKEN]);
    expect(await agents(s.r, "stop", "planner")).toBe(0);
    await settle();
    expect(await agents(s.r, "resume", "planner")).toBe(0);
    const again = s.r.made[s.r.made.length - 1];
    expect(again.opts.cwd).toBe(s.home);
    expect(again.args.slice(0, 2)).toEqual(["--resume", TOKEN]);
    // The row says where it started.
    s.r.out.length = 0;
    expect(await agents(s.r, "list", "-w", "north", "--json")).toBe(0);
    const rows = JSON.parse(s.r.out.join("\n")) as Array<{
      agent: string;
      outside?: boolean;
    }>;
    expect(rows.find((x) => x.agent === "planner")?.outside).toBe(true);
  });
});

describe("D56: folders never brought in", () => {
  it.each([
    ["the root", "/"],
    ["a system folder", "/usr/local/share"],
  ])("%s", async (_n, cwd) => {
    const s = await setup();
    conversation(s, cwd);
    expect(await bring(s, "--outside", cwd)).toBe(1);
    expect(s.r.err.join("\n")).toMatch(/can't be an agent's folder/);
    expect(readRecord(s.r.stateDir, "planner")).toBeNull();
  });

  it("Den's state folder, or inside it", async () => {
    const s = await setup();
    const inside = path.join(s.r.stateDir, "agent-files");
    fs.mkdirSync(inside, { recursive: true });
    conversation(s, inside);
    expect(await bring(s, "--outside", inside)).toBe(1);
    expect(s.r.err.join("\n")).toMatch(/Den's own state/);
  });

  it("inside another project's folder: still refused as that project's", async () => {
    const s = await setup();
    conversation(s, s.r.wsDir("south"));
    const d = resolveAgentsDeps(s.r.deps);
    expect(listConversations(d, "north").outside).toEqual([]);
    expect(await bring(s, "--outside", s.r.wsDir("south"))).toBe(1);
    expect(s.r.err.join("\n")).toMatch(/belongs to/);
  });
});

describe("D56: resume only where it started", () => {
  it("refuses when its folder is gone", async () => {
    const s = await setup();
    const dir = path.join(s.home, "proj");
    fs.mkdirSync(dir);
    conversation(s, dir);
    expect(await bring(s, "--outside", dir)).toBe(0);
    expect(await agents(s.r, "stop", "planner")).toBe(0);
    await settle();
    fs.rmSync(dir, { recursive: true });
    s.r.err.length = 0;
    expect(await agents(s.r, "resume", "planner")).toBe(1);
    expect(s.r.err.join("\n")).toContain(`its folder ${dir} is gone`);
  });

  it("refuses when the conversation ran somewhere else (moved)", async () => {
    const s = await setup();
    const file = conversation(s, s.home);
    expect(await bring(s, "--outside", s.home)).toBe(0);
    expect(await agents(s.r, "stop", "planner")).toBe(0);
    await settle();
    const moved = path.join(s.home, "moved");
    fs.mkdirSync(moved);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf-8").split(s.home).join(moved),
    );
    s.r.err.length = 0;
    expect(await agents(s.r, "resume", "planner")).toBe(1);
    expect(s.r.err.join("\n")).toContain(
      `the conversation ran in ${moved}, not in ${s.home}`,
    );
  });
});

describe("D56 item 8: never two writers on one conversation", () => {
  it("a live process with it open refuses bring-in and resume, naming its pid", async () => {
    const s = await setup();
    conversation(s, s.home);
    sessionRecord(s, process.pid);
    expect(await bring(s, "--outside", s.home)).toBe(1);
    expect(s.r.err.join("\n")).toContain(
      `This conversation is open in another process (pid ${process.pid}). Close it first.`,
    );
    // Not open: in; then a process opens it while the agent is stopped.
    fs.rmSync(path.join(s.claude, "sessions"), { recursive: true });
    expect(await bring(s, "--outside", s.home)).toBe(0);
    expect(await agents(s.r, "stop", "planner")).toBe(0);
    await settle();
    sessionRecord(s, process.pid);
    s.r.err.length = 0;
    expect(await agents(s.r, "resume", "planner")).toBe(1);
    expect(s.r.err.join("\n")).toContain(`(pid ${process.pid})`);
  });

  it("a dead pid, or a pid reused by another process (its start time differs), doesn't count", async () => {
    const s = await setup();
    conversation(s, s.home);
    const gone = spawnSync(process.execPath, ["-e", "process.pid"]).pid!;
    sessionRecord(s, gone, TOKEN, "Thu Jan  1 00:00:00 1970");
    sessionRecord(s, process.pid, TOKEN, "Thu Jan  1 00:00:00 1970");
    expect(await bring(s, "--outside", s.home)).toBe(0);
  });

  it("procStartOf is the process's start time as the runtime writes it", () => {
    expect(procStartOf(process.pid)).toMatch(
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/,
    );
    expect(procStartOf(2 ** 22 + 12345)).toBeNull();
  });
});
