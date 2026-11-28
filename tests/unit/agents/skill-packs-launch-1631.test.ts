import { afterEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Persona } from "../../../src/shared/agents/personas.js";
import {
  getRuntime,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-launch-")),
  );
  tmps.push(d);
  return d;
}

function claudeOnPath(): NodeJS.ProcessEnv {
  const bin = path.join(tmp(), "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  return { PATH: `${bin}:/usr/bin:/bin` };
}

const persona: Persona = {
  id: "builder",
  role: "Builds.",
  prompt: "You build.",
  standing: false,
  tools: [],
  context: [],
  source: "/pack/builder.md",
} as unknown as Persona;

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  const state = tmp();
  return {
    persona,
    workspace: { name: "north", dir: "/w/north" },
    agentId: "builder",
    worktree: "/w/north",
    mcp: {
      name: "acme",
      command: ["/dist/bin/acme", "mcp"],
      env: { PATH: "/usr/bin:/bin" },
      scope: "north",
    },
    filesDir: path.join(state, "agent-files", "builder"),
    stateDir: state,
    env: claudeOnPath(),
    ...over,
  };
}

const settingsOf = (
  inp: LaunchInput,
  out: { files?: Record<string, string> },
) =>
  JSON.parse(out.files![path.join(inp.filesDir, "settings.json")]!) as {
    permissions: { deny: string[] };
  };

describe("issue 1631: a Claude Code agent's launch loads its skill packs", () => {
  it("names each built folder with --plugin-dir, beside --settings", () => {
    const dir = path.join(tmp(), "pstack@41e400932eca", "abc");
    const inp = input({ skillPacks: [{ name: "pstack", dir }] });
    const out = getRuntime("den-claude")!.launch(inp);
    const at = out.argv.indexOf("--plugin-dir");
    expect(out.argv[at + 1]).toBe(dir);
    expect(out.argv[at - 2]).toBe("--settings");
  });

  it("an agent off the pack starts with no --plugin-dir", () => {
    const out = getRuntime("den-claude")!.launch(input({ skillPacks: [] }));
    expect(out.argv).not.toContain("--plugin-dir");
    expect(getRuntime("den-claude")!.launch(input()).argv).not.toContain(
      "--plugin-dir",
    );
  });

  it("the role prompt names the pack, its harness map, and that Den's rules win", () => {
    const dir = path.join(tmp(), "pstack@41e400932eca", "abc");
    const out = getRuntime("den-claude")!.launch(
      input({ skillPacks: [{ name: "pstack", dir }] }),
    );
    const prompt = out.argv[out.argv.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain(
      `The pstack skills are loaded as the plugin pstack. Before you use one, read ${dir}/docs/harness/claude-code.md once.`,
    );
    expect(prompt).toContain(
      "Den's rules win over a skill's: watch checks with github_watch, never merge or force-push, and hand a green PR to whoever merges.",
    );
    const off = getRuntime("den-claude")!.launch(input());
    expect(
      off.argv[off.argv.indexOf("--append-system-prompt") + 1],
    ).not.toContain("pstack");
  });

  it("the agent may read the built folder but never edit it", () => {
    const dir = path.join(tmp(), "pstack@41e400932eca", "abc");
    const inp = input({ skillPacks: [{ name: "pstack", dir }] });
    const deny = settingsOf(inp, getRuntime("den-claude")!.launch(inp))
      .permissions.deny;
    expect(deny).toContain(`Edit(/${dir}/**)`);
    expect(deny).not.toContain(`Read(/${dir}/**)`);
  });
});
