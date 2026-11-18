/**
 * Issue 252: one agent's mode, set from the page or the CLI.
 *
 *   - The CLI says when a running agent takes it: Den restarts it at its
 *     next idle, on the same conversation (not "from its next start").
 *   - Each restart Den makes on its own to apply a mode is reported, so
 *     the web server writes an audit row: who (Den itself), which agent,
 *     the mode, and where the mode comes from.
 *
 * The rig's scripted PTY; nothing runs. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  modeCheck,
  modeRestartDetail,
  resolveAgentsDeps,
  type ModeRestarted,
} from "../../../src/ui/cli/agent-ops.js";
import { clearPermissionModesCache } from "../../../src/shared/agents/den-claude.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  clearPermissionModesCache();
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, loginPath: async () => {} });
const modeOf = (args: string[]) => args[args.indexOf("--permission-mode") + 1];
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;

function persona(r: Rig, name: string): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

/** A turn that ended: its transcript, so after-turn sees it idle. */
async function endedTurn(r: Rig, id: string): Promise<void> {
  const sid = (record(r, id).session as { id: string }).id;
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(sid, Buffer.from("go\r"));
  await settle();
  c.close();
  const token = record(r, id).resumeToken as string;
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "go" } },
      {
        type: "assistant",
        message: {
          model: "opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

/** Stop waits for the session to end; each scripted one ends on TERM. */
function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const made = r.made;
  const push = made.push.bind(made);
  made.push = (...ps) => {
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

/** Project north on auto; lead runs in it. */
async function oneAgent(): Promise<Rig> {
  const r = await rig();
  endOnTerm(r);
  persona(r, "lead");
  r.wsPermission.north = "auto";
  expect(await agents(r, "start", "-w", "north", "--persona", "lead")).toBe(0);
  return r;
}

describe("issue 252: the CLI says a running agent restarts at its next idle", () => {
  it("a mode of its own: restarts at its next idle, not from its next start", async () => {
    const r = await oneAgent();
    r.out.length = 0;
    expect(await agents(r, "permission", "lead", "edits")).toBe(0);
    const said = r.out.join("\n");
    expect(said).toBe(
      "lead: edits, its own setting. Den restarts it at its next idle, on the same conversation, to take it.",
    );
    expect(said).not.toMatch(/next start/);
  }, 30_000);

  it("--clear: follows its project's mode again, restarting at its next idle", async () => {
    const r = await oneAgent();
    expect(await agents(r, "permission", "lead", "edits")).toBe(0);
    r.out.length = 0;
    expect(await agents(r, "permission", "lead", "--clear")).toBe(0);
    expect(r.out.join("\n")).toBe(
      "lead: follows its project's mode, auto. Den restarts it at its next idle, on the same conversation, to take it.",
    );
  }, 30_000);
});

describe("issue 252: each restart for a mode is reported, for its audit row", () => {
  it("Den restarts it at idle in its own mode and says so: the agent, the mode, from its own setting", async () => {
    const r = await oneAgent();
    expect(await agents(r, "permission", "lead", "edits")).toBe(0);
    await endedTurn(r, "lead");
    const token = record(r, "lead").resumeToken;
    const seen: ModeRestarted[] = [];
    const mc = modeCheck(resolveAgentsDeps(r.deps), {
      pollMs: 20,
      onRestarted: (e) => seen.push(e),
    });
    expect(await mc.tick()).toEqual(["lead"]);
    await mc.pending();
    const last = r.made.at(-1)!;
    expect(last.args.slice(0, 2)).toEqual(["--resume", token]);
    expect(modeOf(last.args)).toBe("acceptEdits");
    expect(seen).toEqual([
      { agent: "lead", project: "north", mode: "edits", source: "own" },
    ]);
    expect(modeRestartDetail(seen[0])).toBe(
      "restarted lead in north at idle to take mode edits, from its own setting, by Den itself",
    );
  }, 30_000);

  it("Follow project: restarted in the project's mode, from its project", async () => {
    const r = await oneAgent();
    expect(await agents(r, "permission", "lead", "edits")).toBe(0);
    await endedTurn(r, "lead");
    const d = resolveAgentsDeps(r.deps);
    const first = modeCheck(d, { pollMs: 20 });
    await first.tick();
    await first.pending();
    expect(await agents(r, "permission", "lead", "--clear")).toBe(0);
    await endedTurn(r, "lead");
    const seen: ModeRestarted[] = [];
    const mc = modeCheck(resolveAgentsDeps(r.deps), {
      pollMs: 20,
      onRestarted: (e) => seen.push(e),
    });
    expect(await mc.tick()).toEqual(["lead"]);
    await mc.pending();
    expect(modeOf(r.made.at(-1)!.args)).toBe("auto");
    expect(seen).toEqual([
      { agent: "lead", project: "north", mode: "auto", source: "project" },
    ]);
    expect(modeRestartDetail(seen[0])).toBe(
      "restarted lead in north at idle to take mode auto, from its project, by Den itself",
    );
  }, 30_000);
});
