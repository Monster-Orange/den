/**
 * Issue 225: one rule for an agent's mode and where it comes from: its
 * own setting, its project's, the mode for every agent, its persona's,
 * else Den's default. Every start, resume, restart and page reads it.
 *
 * And the held write project_mode: when agents keep a mode of their own
 * that is stricter than the project's, the Allow's offer to make them
 * follow widens them, so the ask is the person's own Allow (issue 160).
 *
 * The rig's scripted PTY; nothing runs. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { resolveMode } from "../../../src/shared/agents/effective-mode.js";
import {
  checkProjectMode,
  effectiveMode,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { getRuntime } from "../../../src/shared/agents/runtime.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { clearPermissionModesCache } from "../../../src/shared/agents/den-claude.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  clearPermissionModesCache();
  await cleanupRigs();
});

describe("issue 225: resolveMode, each source", () => {
  it("its own setting wins over everything", () => {
    expect(
      resolveMode({
        own: "ask",
        project: "all",
        install: "auto",
        persona: "edits",
      }),
    ).toEqual({ mode: "ask", source: "own" });
  });

  it("else the project's", () => {
    expect(
      resolveMode({ project: "auto", install: "all", persona: "edits" }),
    ).toEqual({ mode: "auto", source: "project" });
  });

  it("else the mode for every agent", () => {
    expect(resolveMode({ install: "all", persona: "edits" })).toEqual({
      mode: "all",
      source: "install",
    });
  });

  it("else the persona's, Claude Code's own names read as intents", () => {
    expect(resolveMode({ persona: "edits" })).toEqual({
      mode: "edits",
      source: "persona",
    });
    expect(resolveMode({ persona: "acceptEdits" })).toEqual({
      mode: "edits",
      source: "persona",
    });
    // A mode Den doesn't know: no intent, still the persona's.
    expect(resolveMode({ persona: "plan" })).toEqual({
      mode: undefined,
      source: "persona",
    });
  });

  it("else Den's default, ask", () => {
    expect(resolveMode({})).toEqual({ mode: "ask", source: "default" });
  });
});

const agents = (r: Rig, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, loginPath: async () => {} });

function persona(r: Rig, name: string, extra = ""): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n${extra}---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

describe("issue 225: effectiveMode on a record", () => {
  it("names the source as the project, install and own setting change", async () => {
    const r = await rig();
    persona(r, "scout", "permission_mode: edits\n");
    expect(await agents(r, "start", "-w", "north", "--persona", "scout")).toBe(
      0,
    );
    const d = resolveAgentsDeps(r.deps);
    const rt = getRuntime("den-claude")!;
    const p = { permissionMode: "edits" } as never;
    const now = () => effectiveMode(d, readRecord(r.stateDir, "scout")!, p, rt);
    expect(now()).toEqual({ mode: "edits", source: "persona" });
    r.deps.installPermission = () => "auto";
    expect(
      effectiveMode(
        resolveAgentsDeps(r.deps),
        readRecord(r.stateDir, "scout")!,
        p,
        rt,
      ),
    ).toEqual({ mode: "auto", source: "install" });
    r.wsPermission.north = "all";
    expect(now()).toEqual({ mode: "all", source: "project" });
    expect(await agents(r, "permission", "scout", "ask")).toBe(0);
    expect(now()).toEqual({ mode: "ask", source: "own" });
    // What it would follow without its own setting.
    expect(
      effectiveMode(d, readRecord(r.stateDir, "scout")!, p, rt, {
        ignoreOwn: true,
      }),
    ).toEqual({ mode: "all", source: "project" });
  }, 30_000);
});

describe("issue 225: project_mode with agents that have their own setting", () => {
  it("an own mode stricter than the project's: the person's own Allow", async () => {
    const r = await rig();
    persona(r, "pinned");
    expect(await agents(r, "start", "-w", "north", "--persona", "pinned")).toBe(
      0,
    );
    expect(await agents(r, "permission", "pinned", "ask")).toBe(0);
    r.wsPermission.north = "auto";
    const d = resolveAgentsDeps(r.deps);
    // auto → edits narrows the project, but pinned (ask) would widen.
    const c = checkProjectMode(d, { project: "north", mode: "edits" });
    expect(c.ok && c.personOnly).toBe(true);
    expect(c.ok && c.choices).toEqual(["follow"]);
  }, 30_000);

  it("own modes no stricter than the project's: routine, as before", async () => {
    const r = await rig();
    persona(r, "pinned");
    expect(await agents(r, "start", "-w", "north", "--persona", "pinned")).toBe(
      0,
    );
    expect(await agents(r, "permission", "pinned", "all")).toBe(0);
    r.wsPermission.north = "auto";
    const c = checkProjectMode(resolveAgentsDeps(r.deps), {
      project: "north",
      mode: "edits",
    });
    expect(c.ok).toBe(true);
    expect(c.ok && c.personOnly).toBeFalsy();
  }, 30_000);
});
