/**
 * den#48: auto, Claude Code's own permission mode, as a Den mode. A Den
 * agent can then run in the same mode as peers that do: Claude Code holds
 * a message from a session in another mode.
 *
 *   - a persona's `permission_mode: auto`, or the workspace's
 *     `agents.permission`, starts it with `--permission-mode auto`;
 *   - the workspace's mode is over the persona's, for a start that names
 *     none; a start's own choice is over both;
 *   - where this Claude Code's --help doesn't list auto, the start and a
 *     resume are refused, naming the modes it takes;
 *   - `agents permission` shows and sets the workspace's mode (a person's
 *     only), and `agents doctor` says what each mode means and whether this
 *     Claude Code takes auto.
 *
 * The rig's `claude` (helpers/rig.ts) answers --version and --help only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  clearPermissionModesCache,
  parseModes,
} from "../../../src/shared/agents/den-claude.js";
import { clearVersionCache } from "../../../src/shared/agents/runtime-search.js";
import { ACTOR_TOKEN_ENV } from "../../../src/shared/actor-token.js";
import {
  CLAUDE_SHIM,
  cleanupRigs,
  rig,
  settle,
  type Rig,
} from "./helpers/rig.js";

afterEach(async () => {
  clearPermissionModesCache();
  clearVersionCache();
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, loginPath: async () => {} });
const modeOf = (args: string[]) => args[args.indexOf("--permission-mode") + 1];
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;

function persona(r: Rig, name: string, extra: string): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n${extra}---\nYou plan.\n`,
  );
  r.config.personaPacks = ["personas"];
}

/** This Claude Code's --help lists `modes` (null: no such line). */
function claudeTakes(r: Rig, modes: string[] | null): void {
  fs.writeFileSync(r.claude, CLAUDE_SHIM(r.ran, "9.9.9", modes), {
    mode: 0o755,
  });
  clearPermissionModesCache();
}

const OLD_MODES = ["acceptEdits", "bypassPermissions", "default", "plan"];

describe("parseModes", () => {
  it("reads --permission-mode's choices, and only its own", () => {
    expect(
      parseModes(
        [
          "Options:",
          '  --model <model>   (choices: "opus", "sonnet")',
          "  --permission-mode <mode>   Permission mode to use for the session",
          '                             (choices: "acceptEdits", "auto",',
          '                             "bypassPermissions", "plan")',
          '  --output-format <f>   (choices: "text", "json")',
        ].join("\n"),
      ),
    ).toEqual(["acceptEdits", "auto", "bypassPermissions", "plan"]);
    // Choices further down are another option's.
    expect(
      parseModes(
        '  --permission-mode <mode>  the mode\n  --x <f>  (choices: "a", "b")',
      ),
    ).toBe(null);
    expect(parseModes("Usage: claude [options]")).toBe(null);
  });
});

describe("den#48: auto mode", () => {
  it("a persona's permission_mode: auto starts it with --permission-mode auto, tagged auto", async () => {
    const r = await rig();
    persona(r, "peer", "permission_mode: auto\n");
    expect(await agents(r, "start", "-w", "north", "--persona", "peer")).toBe(
      0,
    );
    expect(modeOf(r.made[0].args)).toBe("auto");
  });

  it("the workspace's mode is over the persona's, for a start that names none; other workspaces keep the persona's", async () => {
    const r = await rig();
    persona(r, "careful", "permission_mode: ask\n");
    r.wsPermission.north = "auto";
    expect(
      await agents(r, "start", "-w", "north", "--persona", "careful"),
    ).toBe(0);
    expect(modeOf(r.made[0].args)).toBe("auto");
    const rec = record(r, "careful");
    expect(rec.permission).toBe("auto");
    // The project's, not chosen for the agent: it follows the project later.
    expect(rec.overrides ?? []).not.toContain("permission");
    expect(
      await agents(r, "start", "-w", "south", "--persona", "careful"),
    ).toBe(0);
    expect(modeOf(r.made[1].args)).toBe("default");
  });

  it("a bad workspace mode is refused, naming its key: never quietly ask", async () => {
    const r = await rig();
    r.wsPermission.north = "yolo";
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).not.toBe(0);
    expect(r.err.join("\n")).toContain("workspaces.north.agents.permission");
    expect(r.made).toHaveLength(0);
  });

  it("a Claude Code whose --help doesn't list auto: the start is refused, naming the modes it takes", async () => {
    const r = await rig();
    claudeTakes(r, OLD_MODES);
    persona(r, "peer", "permission_mode: auto\n");
    expect(
      await agents(r, "start", "-w", "north", "--persona", "peer"),
    ).not.toBe(0);
    const err = r.err.join("\n");
    expect(err).toContain("has no auto permission mode");
    expect(err).toContain(OLD_MODES.join(", "));
    expect(err).toContain("Update Claude Code");
    expect(r.made).toHaveLength(0);
    // Another mode still starts on it.
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
  });

  it("…and its resume too, after Claude Code went back to a version without auto", async () => {
    const r = await rig();
    // Its conversation is on disk, so this is a resume, not a fresh start.
    const cc = path.join(r.dir, "cc");
    r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: cc };
    persona(r, "peer", "permission_mode: auto\n");
    expect(await agents(r, "start", "-w", "north", "--persona", "peer")).toBe(
      0,
    );
    const token = String(record(r, "peer").resumeToken);
    fs.mkdirSync(path.join(cc, "projects", "w"), { recursive: true });
    fs.writeFileSync(path.join(cc, "projects", "w", `${token}.jsonl`), "{}\n");
    r.made[0].exit(0);
    await settle();
    claudeTakes(r, OLD_MODES);
    r.err.length = 0;
    expect(await agents(r, "resume", "peer")).not.toBe(0);
    expect(r.err.join("\n")).toContain("has no auto permission mode");
    expect(r.made).toHaveLength(1);
    // With auto back, it resumes the same conversation.
    claudeTakes(r, ["auto", "plan"]);
    expect(await agents(r, "resume", "peer")).toBe(0);
    expect(r.made[1].args).toContain("--resume");
    expect(modeOf(r.made[1].args)).toBe("auto");
  });

  it("where the modes can't be read, it starts, with a warning", async () => {
    const r = await rig();
    claudeTakes(r, null);
    persona(r, "peer", "permission_mode: auto\n");
    expect(await agents(r, "start", "-w", "north", "--persona", "peer")).toBe(
      0,
    );
    expect(modeOf(r.made[0].args)).toBe("auto");
    expect([...r.out, ...r.err].join("\n")).toContain(
      "couldn't read the permission modes",
    );
  });
});

describe("den#48: agents permission", () => {
  it("shows, sets and clears the workspace's mode", async () => {
    const r = await rig();
    expect(await agents(r, "permission", "-w", "north")).toBe(0);
    expect(r.out.at(-1)).toContain("no default");
    expect(await agents(r, "permission", "-w", "north", "auto")).toBe(0);
    expect(r.wsPermission.north).toBe("auto");
    expect(r.out.at(-1)).toContain("agents now start in auto");
    expect(await agents(r, "permission", "-w", "north")).toBe(0);
    expect(r.out.at(-1)).toContain("agents start in auto");
    expect(await agents(r, "permission", "-w", "north", "--clear")).toBe(0);
    expect(r.wsPermission.north).toBeUndefined();
  });

  // Vision 11-13: there was no way to set one agent's mode.
  it("one agent's: shows where it comes from; a person sets it, and it stays; --clear follows the project again", async () => {
    const r = await rig();
    persona(r, "careful", "permission_mode: ask\n");
    expect(
      await agents(r, "start", "-w", "north", "--persona", "careful"),
    ).toBe(0);
    expect(await agents(r, "permission", "careful")).toBe(0);
    expect(r.out.at(-1)).toContain(
      "careful: follows its persona's mode (ask when it last started)",
    );
    r.wsPermission.north = "auto";
    expect(await agents(r, "permission", "careful")).toBe(0);
    expect(r.out.at(-1)).toContain("careful: follows its project's mode, auto");
    // An agent's own token can't widen its mode.
    const env = r.deps.env;
    r.deps.env = { ...env, [ACTOR_TOKEN_ENV]: "x" };
    expect(await agents(r, "permission", "careful", "all")).not.toBe(0);
    expect(record(r, "careful").overrides ?? []).not.toContain("permission");
    r.deps.env = env;
    expect(await agents(r, "permission", "careful", "edits")).toBe(0);
    expect(record(r, "careful")).toMatchObject({ permission: "edits" });
    expect(record(r, "careful").overrides).toContain("permission");
    expect(await agents(r, "permission", "careful")).toBe(0);
    expect(r.out.at(-1)).toContain("careful: edits, chosen for it");
    // It stays over the project's at the next start.
    expect(await agents(r, "stop", "careful")).toBe(0);
    r.made[0].exit(0);
    await settle();
    expect(await agents(r, "resume", "careful")).toBe(0);
    expect(modeOf(r.made.at(-1)!.args)).toBe("acceptEdits");
    // Cleared: the project's again.
    expect(await agents(r, "permission", "careful", "--clear")).toBe(0);
    expect(record(r, "careful").overrides ?? []).not.toContain("permission");
    expect(await agents(r, "stop", "careful")).toBe(0);
    r.made.at(-1)!.exit(0);
    await settle();
    expect(await agents(r, "resume", "careful")).toBe(0);
    expect(modeOf(r.made.at(-1)!.args)).toBe("auto");
    expect(await agents(r, "permission", "nobody", "auto")).not.toBe(0);
  });

  // 0.4.44 on a consumer install: `agents permission shift -w shift`, from an
  // agent's own session, was refused as "only a person can change
  // rotation": the id read as the project's mode, the wrong word named.
  it("<id> with -w: an agent may ask which mode it runs in; a change says permission mode, never rotation", async () => {
    const r = await rig();
    persona(r, "careful", "permission_mode: ask\n");
    expect(
      await agents(r, "start", "-w", "north", "--persona", "careful"),
    ).toBe(0);
    r.wsPermission.north = "auto";
    const env = r.deps.env;
    r.deps.env = { ...env, [ACTOR_TOKEN_ENV]: "x" };
    expect(await agents(r, "permission", "careful", "-w", "north")).toBe(0);
    expect(r.out.at(-1)).toContain("careful: follows its project's mode, auto");
    expect(await agents(r, "permission", "careful")).toBe(0);
    expect(await agents(r, "permission", "-w", "north")).toBe(0);
    expect(await agents(r, "permission", "careful", "edits")).not.toBe(0);
    expect(
      await agents(r, "permission", "careful", "edits", "-w", "north"),
    ).not.toBe(0);
    expect(await agents(r, "permission", "-w", "north", "ask")).not.toBe(0);
    const errs = r.err.join("\n");
    expect(errs).toContain(
      "only a person can change an agent's permission mode",
    );
    expect(errs).toContain(
      "only a person can change a project's permission mode",
    );
    expect(errs).not.toContain("rotation");
    expect(record(r, "careful").overrides ?? []).not.toContain("permission");
    expect(r.wsPermission.north).toBe("auto");
    // -w that isn't the agent's project: said, not guessed.
    r.deps.env = env;
    expect(await agents(r, "permission", "careful", "-w", "south")).not.toBe(0);
    expect(r.err.join("\n")).toContain(
      "careful is in project north, not south",
    );
  });

  it("refuses a mode Den doesn't have, a missing workspace, and an agent's session", async () => {
    const r = await rig();
    expect(await agents(r, "permission", "-w", "north", "yolo")).not.toBe(0);
    expect(r.err.join("\n")).toContain("ask, edits, auto, all");
    expect(await agents(r, "permission", "auto")).not.toBe(0);
    expect(await agents(r, "permission", "-w", "nowhere", "auto")).not.toBe(0);
    r.deps.env = { ...r.deps.env, [ACTOR_TOKEN_ENV]: "x" };
    expect(await agents(r, "permission", "-w", "north", "auto")).not.toBe(0);
    expect(r.wsPermission.north).toBeUndefined();
  });
});

describe("den#48: agents doctor", () => {
  it("says what each mode means, that this Claude Code takes auto, and the workspace's mode", async () => {
    const r = await rig();
    r.wsPermission.north = "auto";
    await agents(r, "doctor", "-w", "north");
    const at = r.out.indexOf("permission modes (den-claude)");
    expect(at).toBeGreaterThan(-1);
    const block = r.out.slice(at, at + 6).join("\n");
    expect(block).toMatch(
      / auto\s+Claude Code's own check runs routine actions and blocks risky ones, without asking {2}✓ this Claude Code takes it/,
    );
    expect(block).toContain("north: agents start in auto");
    r.out.length = 0;
    await agents(r, "doctor", "-w", "north", "--json");
    expect(
      (JSON.parse(r.out.join("\n")) as { permissionModes: unknown })
        .permissionModes,
    ).toEqual({ auto: true, workspace: "auto" });
  });

  it("a Claude Code without auto: says to update it", async () => {
    const r = await rig();
    claudeTakes(r, OLD_MODES);
    await agents(r, "doctor");
    expect(r.out.join("\n")).toContain(
      "✗ this Claude Code (9.9.9) doesn't: update it to use auto",
    );
  });
});
