import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  resolveAgentsDeps,
  skillPackCheck,
  skillPackRestartDetail,
  type SkillPackRestarted,
} from "../../../src/ui/cli/agent-ops.js";
import { clearPermissionModesCache } from "../../../src/shared/agents/den-claude.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  clearPermissionModesCache();
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, loginPath: async () => {} });
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

async function oneAgent(): Promise<Rig> {
  const r = await rig();
  endOnTerm(r);
  persona(r, "lead");
  expect(await agents(r, "start", "-w", "north", "--persona", "lead")).toBe(0);
  return r;
}

const pluginDirs = (args: string[]) =>
  args.flatMap((a, i) => (args[i - 1] === "--plugin-dir" ? [a] : []));

describe("issue 1631: a skill_packs change reaches a running agent on its own", () => {
  it("nothing changed: no restart", async () => {
    const r = await oneAgent();
    expect(pluginDirs(r.made.at(-1)!.args)).toHaveLength(1);
    await endedTurn(r, "lead");
    const c = skillPackCheck(resolveAgentsDeps(r.deps), { pollMs: 20 });
    expect(await c.tick()).toEqual([]);
  }, 30_000);

  it("its packs turned off in config: Den restarts it after its turn with none, and says so once", async () => {
    const r = await oneAgent();
    r.config.agents.lead = {
      ...(r.config.agents.lead ?? { grants: [] }),
      skillPacks: "off",
    };
    await endedTurn(r, "lead");
    const token = record(r, "lead").resumeToken;
    const seen: SkillPackRestarted[] = [];
    const c = skillPackCheck(resolveAgentsDeps(r.deps), {
      pollMs: 20,
      onRestarted: (e) => seen.push(e),
    });
    expect(await c.tick()).toEqual(["lead"]);
    await c.pending();
    const last = r.made.at(-1)!;
    expect(last.args.slice(0, 2)).toEqual(["--resume", token]);
    expect(pluginDirs(last.args)).toEqual([]);
    expect(seen).toEqual([{ agent: "lead", project: "north" }]);
    expect(skillPackRestartDetail(seen[0]!)).toBe(
      "restarted lead in north at idle to take its skill packs, by Den itself",
    );
    await endedTurn(r, "lead");
    expect(await c.tick()).toEqual([]);
  }, 30_000);

  it("the install's skill list changed: restarted with the new folder", async () => {
    const r = await oneAgent();
    const before = pluginDirs(r.made.at(-1)!.args);
    r.config.skillPacks = {
      den: undefined,
      user: { pstack: { exclude: ["tdd"] } },
    };
    await endedTurn(r, "lead");
    const c = skillPackCheck(resolveAgentsDeps(r.deps), { pollMs: 20 });
    expect(await c.tick()).toEqual(["lead"]);
    await c.pending();
    const after = pluginDirs(r.made.at(-1)!.args);
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
    expect(fs.existsSync(path.join(after[0]!, "skills", "tdd"))).toBe(false);
  }, 30_000);

  it("Den's record holds the pack folders each launch passed", async () => {
    const r = await oneAgent();
    expect(record(r, "lead").skillPackDirs).toEqual(
      pluginDirs(r.made.at(-1)!.args),
    );
  }, 30_000);

  it("its settings file gone or edited: Den's record still shows the drift, and it restarts", async () => {
    const r = await oneAgent();
    const files = path.join(r.stateDir, "agent-files", "lead", "settings.json");
    fs.rmSync(files, { force: true });
    r.config.agents.lead = {
      ...(r.config.agents.lead ?? { grants: [] }),
      skillPacks: "off",
    };
    await endedTurn(r, "lead");
    const c = skillPackCheck(resolveAgentsDeps(r.deps), { pollMs: 20 });
    expect(await c.tick()).toEqual(["lead"]);
    await c.pending();
    expect(pluginDirs(r.made.at(-1)!.args)).toEqual([]);
    expect(record(r, "lead").skillPackDirs).toEqual([]);
  }, 30_000);

  it("no record of its packs and no settings file: packs now off still restarts it", async () => {
    const r = await oneAgent();
    const file = path.join(r.stateDir, "agents", "lead.json");
    const rec = record(r, "lead");
    delete rec.skillPackDirs;
    fs.writeFileSync(file, JSON.stringify(rec));
    fs.rmSync(path.join(r.stateDir, "agent-files", "lead", "settings.json"), {
      force: true,
    });
    r.config.agents.lead = {
      ...(r.config.agents.lead ?? { grants: [] }),
      skillPacks: "off",
    };
    await endedTurn(r, "lead");
    const c = skillPackCheck(resolveAgentsDeps(r.deps), { pollMs: 20 });
    expect(await c.tick()).toEqual(["lead"]);
  }, 30_000);
});
