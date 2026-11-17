/**
 * Issue 278 clause 2: at each agent start (and resume), Den measures the
 * instruction files Claude Code will load for the agent's folder (stat
 * only) against a share of its model's context. Over it: a warning in the
 * start's output, kept beside the agent's files for its row. The share
 * and the context are settings.
 *
 * The rig's scripted PTY; nothing runs. Temp dirs, invented names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { agentFilesDir } from "../../../src/shared/agents/records.js";
import {
  CONTEXT_WATCH_DEFAULTS,
  readInstructionCheck,
} from "../../../src/shared/agents/context-watch.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, loginPath: async () => {} });

function persona(r: Rig, name: string): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

function setHome(r: Rig): string {
  const home = path.join(r.dir, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  r.deps.env = { ...r.deps.env, HOME: home };
  r.deps.contextWatch = () => ({ ...CONTEXT_WATCH_DEFAULTS });
  return home;
}

describe("issue 278 clause 2: the instruction-size check at agent start", () => {
  it("a huge instruction file in the folder warns at start, naming it and its size", async () => {
    const r = await rig();
    persona(r, "scout");
    setHome(r);
    fs.writeFileSync(
      path.join(r.wsDir("north"), "CLAUDE.md"),
      "z".repeat(840 * 1024),
    );
    expect(await agents(r, "start", "-w", "north", "--persona", "scout")).toBe(
      0,
    );
    const said = r.err.join("\n");
    expect(said).toMatch(/instruction files are 840 KB/);
    expect(said).toContain("CLAUDE.md (840 KB)");
    const kept = readInstructionCheck(agentFilesDir(r.stateDir, "scout"));
    expect(kept).toMatchObject({
      over: true,
      sharePercent: 15,
      contextTokens: 200_000,
      largest: { path: "CLAUDE.md", bytes: 840 * 1024 },
    });
  });

  it("small files: measured and kept, no warning", async () => {
    const r = await rig();
    persona(r, "scout");
    setHome(r);
    fs.writeFileSync(path.join(r.wsDir("north"), "CLAUDE.md"), "small");
    expect(await agents(r, "start", "-w", "north", "--persona", "scout")).toBe(
      0,
    );
    expect(r.err.join("\n")).not.toMatch(/instruction files are/);
    expect(
      readInstructionCheck(agentFilesDir(r.stateDir, "scout")),
    ).toMatchObject({
      over: false,
      totalBytes: 5,
    });
  });

  it("the share is a setting", async () => {
    const r = await rig();
    persona(r, "scout");
    setHome(r);
    r.deps.contextWatch = () => ({
      ...CONTEXT_WATCH_DEFAULTS,
      sharePercent: 1,
    });
    // 10 KB is about 2,560 tokens: over 1% of 200k (2,000).
    fs.writeFileSync(
      path.join(r.wsDir("north"), "AGENTS.md"),
      "z".repeat(10 * 1024),
    );
    expect(await agents(r, "start", "-w", "north", "--persona", "scout")).toBe(
      0,
    );
    expect(r.err.join("\n")).toContain("AGENTS.md (10 KB)");
  });
});
