/**
 * 0.4.46 MODE-UI slice 1: an agent's mode, without a person pampering it.
 *
 *   (1) One install-wide mode a person sets once (agents.default_mode in
 *       user.yml, Settings' row), for every agent, the server agent too.
 *       Order: the agent's own (chosen for it), its project's, this, its
 *       persona's.
 *   (2) A change applies on its own: a running agent whose mode now
 *       differs is restarted after its turn, the same conversation.
 *   (3) Den's own restarts (reconnect, restore after a restart, the
 *       after-turn restart) never drop a mode.
 *
 * The rig's scripted PTY; nothing runs. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { agentsDefaultMode } from "../../../src/shared/den-config.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  markInterrupted,
  modeCheck,
  resolveAgentsDeps,
  restartAgent,
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

function persona(r: Rig, name: string, extra = ""): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n${extra}---\nYou work.\n`,
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

describe("0.4.46: one mode for the install, applied on its own, kept through Den's restarts", () => {
  it("(1) the install's mode is under the agent's own and its project's, over the persona's", async () => {
    const r = await rig();
    persona(r, "server");
    persona(r, "careful", "permission_mode: ask\n");
    let install: unknown = "auto";
    r.deps.installPermission = () => install;
    expect(await agents(r, "start", "-w", "north", "--persona", "server")).toBe(
      0,
    );
    expect(modeOf(r.made[0].args)).toBe("auto");
    expect(record(r, "server").overrides ?? []).not.toContain("permission");
    // Over the persona's own mode.
    expect(
      await agents(r, "start", "-w", "north", "--persona", "careful"),
    ).toBe(0);
    expect(modeOf(r.made[1].args)).toBe("auto");
    // The project's is over it.
    r.wsPermission.south = "edits";
    expect(await agents(r, "start", "-w", "south", "--persona", "server")).toBe(
      0,
    );
    expect(modeOf(r.made[2].args)).toBe("acceptEdits");
    // Unset: the persona's, as before.
    install = undefined;
    expect(
      await agents(r, "start", "-w", "south", "--persona", "careful"),
    ).toBe(0);
    expect(modeOf(r.made[3].args)).toBe("acceptEdits");
    r.wsPermission.south = undefined as unknown as string;
    expect(await agents(r, "stop", "server", "-w", "north")).toBe(0);
    r.made[0].exit(0);
    await settle();
    expect(
      await agents(
        r,
        "start",
        "-w",
        "south",
        "--persona",
        "careful",
        "--id",
        "c2",
      ),
    ).toBe(0);
    expect(modeOf(r.made[4].args)).toBe("default");
  }, 30_000);

  it("(2) a change applies on its own after the turn, the same conversation; a mode chosen for an agent stays", async () => {
    const r = await rig();
    endOnTerm(r);
    persona(r, "server");
    persona(r, "pinned");
    expect(await agents(r, "start", "-w", "north", "--persona", "server")).toBe(
      0,
    );
    expect(await agents(r, "start", "-w", "north", "--persona", "pinned")).toBe(
      0,
    );
    expect(await agents(r, "permission", "pinned", "edits")).toBe(0);
    await endedTurn(r, "server");
    await endedTurn(r, "pinned");
    const d = resolveAgentsDeps(r.deps);
    const mc = modeCheck(d, { pollMs: 20 });
    expect(await mc.tick()).toEqual([]);
    const token = record(r, "server").resumeToken;
    // The person sets the install's mode once.
    r.deps.installPermission = () => "auto";
    const d2 = resolveAgentsDeps(r.deps);
    const mc2 = modeCheck(d2, { pollMs: 20 });
    expect(await mc2.tick()).toEqual(["server"]);
    await mc2.pending();
    const last = r.made.at(-1)!;
    expect(last.args.slice(0, 2)).toEqual(["--resume", token]);
    expect(modeOf(last.args)).toBe("auto");
    expect(record(r, "server").permission).toBe("auto");
    expect(await mc2.tick()).toEqual([]);
  }, 30_000);

  it("(3) Den's after-turn restart and its restore after a restart keep the mode", async () => {
    const r = await rig();
    endOnTerm(r);
    persona(r, "server");
    persona(r, "pinned");
    r.deps.installPermission = () => "auto";
    expect(await agents(r, "start", "-w", "north", "--persona", "server")).toBe(
      0,
    );
    expect(await agents(r, "start", "-w", "north", "--persona", "pinned")).toBe(
      0,
    );
    expect(await agents(r, "permission", "pinned", "edits")).toBe(0);
    await endedTurn(r, "server");
    await endedTurn(r, "pinned");
    const d = resolveAgentsDeps(r.deps);
    await restartAgent(d, "server", "north", "after-turn", { pollMs: 20 });
    expect(modeOf(r.made.at(-1)!.args)).toBe("auto");
    await restartAgent(d, "pinned", "north", "after-turn", { pollMs: 20 });
    expect(modeOf(r.made.at(-1)!.args)).toBe("acceptEdits");
    await r.restartHost();
    const before = r.made.length;
    await markInterrupted(resolveAgentsDeps(r.deps), { restoreAll: true });
    const back = r.made
      .slice(before)
      .map((p) => modeOf(p.args))
      .sort();
    expect(back).toEqual(["acceptEdits", "auto"]);
  }, 30_000);

  it("agents.default_mode is a setting: unset, or one of ask, edits, auto, all", () => {
    expect(agentsDefaultMode(() => ({}))).toBeUndefined();
    expect(
      agentsDefaultMode(() => ({ agents: { default_mode: "auto" } })),
    ).toBe("auto");
    expect(() =>
      agentsDefaultMode(() => ({ agents: { default_mode: "yolo" } })),
    ).toThrow("agents.default_mode");
  });
});
