/**
 * Personas (AG-2a): markdown files with YAML front matter, read from a
 * persona-pack directory. A Claude Code agent file (name, description,
 * model, tools) is read as it is; Den's own keys (id, role, runtime,
 * standing, context, argv) sit beside them. Den's default pack is always
 * there, and a distribution's pack overrides it by id.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_PACK_DIR,
  loadPersonas,
  parsePersona,
  readPack,
  resolvePackDirs,
} from "../../../src/shared/agents/personas.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function pack(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-pack-"));
  tmps.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

/** A Claude Code subagent file, exactly as Claude Code documents them. */
const CLAUDE_CODE_AGENT = [
  "---",
  "name: code-reviewer",
  "description: Reviews code for quality and security. Use after every change.",
  "tools: Read, Grep, Glob, Bash",
  "model: sonnet",
  "color: red",
  "---",
  "",
  "You are a senior code reviewer.",
  "",
  "Check every change for correctness.",
  "",
].join("\n");

describe("parsePersona", () => {
  it("reads a Claude Code agent file as it is", () => {
    const p = parsePersona(CLAUDE_CODE_AGENT, "/pack/code-reviewer.md");
    expect(p).toEqual({
      id: "code-reviewer",
      // Claude Code's description is the one line a list shows (AG-10.2).
      description:
        "Reviews code for quality and security. Use after every change.",
      category: "engineering",
      allowedCommands: [],
      origin: "builtin",
      prompt:
        "You are a senior code reviewer.\n\nCheck every change for correctness.",
      model: "sonnet",
      standing: false,
      tools: ["Read", "Grep", "Glob", "Bash"],
      context: [],
      source: "/pack/code-reviewer.md",
    });
  });

  it("reads Den's own keys: id, role, runtime, model, standing, context, argv", () => {
    const p = parsePersona(
      [
        "---",
        "id: planner",
        "name: Planner",
        "role: Writes stories and acceptance criteria.",
        "runtime: generic",
        "model: some-model",
        "standing: true",
        "tools: [read, search]",
        "context: [docs/specs, the design system]",
        'argv: ["aider", "--model", "{model}"]',
        "---",
        "Plan the work.",
      ].join("\n"),
      "/pack/x.md",
    );
    expect(p).toMatchObject({
      id: "planner",
      // A role that is a sentence (before AG-11) is its description.
      description: "Writes stories and acceptance criteria.",
      runtime: "generic",
      model: "some-model",
      standing: true,
      tools: ["read", "search"],
      context: ["docs/specs", "the design system"],
      argv: ["aider", "--model", "{model}"],
      prompt: "Plan the work.",
    });
  });

  it("model: inherit means no model of its own (Claude Code's default)", () => {
    const p = parsePersona(
      "---\nname: a\ndescription: d\nmodel: inherit\n---\nbody\n",
      "/p/a.md",
    );
    expect(p?.model).toBeUndefined();
  });

  it("the file name is the id when the front matter names none", () => {
    const p = parsePersona("---\ndescription: d\n---\nbody\n", "/p/fe-dev.md");
    expect(p?.id).toBe("fe-dev");
  });

  it("a file without front matter is not a persona (a pack's README)", () => {
    expect(parsePersona("# About this pack\n", "/p/README.md")).toBeNull();
  });

  it("bad front matter is an error naming the file and the key", () => {
    expect(() =>
      parsePersona("---\nname: a\nstanding: yes please\n---\nb", "/p/a.md"),
    ).toThrow(/\/p\/a\.md: standing must be true or false/);
    expect(() => parsePersona("---\nname: a b\n---\nb", "/p/a.md")).toThrow(
      /\/p\/a\.md: id "a b" must be letters, digits/,
    );
    expect(() =>
      parsePersona("---\nname: [unclosed\n---\nb", "/p/a.md"),
    ).toThrow(/\/p\/a\.md: front matter is not YAML/);
    expect(() =>
      parsePersona("---\nname: a\nargv: aider\n---\nb", "/p/a.md"),
    ).toThrow(/\/p\/a\.md: argv must be a list of strings/);
  });
});

describe("packs", () => {
  it("Den's default pack has the eight role personas, runtime-neutral", () => {
    const ids = readPack(DEFAULT_PACK_DIR).map((p) => p.id);
    expect(ids.sort()).toEqual(
      [
        "be-dev",
        "devops",
        "fe-dev",
        "orchestrator",
        "planner",
        "reviewer",
        "tester",
        "ux-designer",
      ].sort(),
    );
    const byId = new Map(readPack(DEFAULT_PACK_DIR).map((p) => [p.id, p]));
    expect(byId.get("planner")?.standing).toBe(true);
    expect(byId.get("orchestrator")?.standing).toBe(true);
    expect(byId.get("reviewer")?.standing).toBe(false);
    for (const p of byId.values()) {
      expect(p.prompt.length).toBeGreaterThan(40);
      expect(p.runtime).toBeUndefined();
      expect(p.prompt).not.toMatch(/claude/i);
    }
  });

  it("a pack pointing at a Claude Code plugin reads its agents/ directory", () => {
    const dir = pack({
      "agents/code-reviewer.md": CLAUDE_CODE_AGENT,
      ".claude-plugin/plugin.json": "{}",
      "README.md": "# plugin\n",
    });
    expect(readPack(dir).map((p) => p.id)).toEqual(["code-reviewer"]);
  });

  it("two files with one id in a pack is an error naming both", () => {
    const dir = pack({
      "a.md": "---\nname: twin\n---\nx\n",
      "b.md": "---\nid: twin\n---\ny\n",
    });
    expect(() => readPack(dir)).toThrow(/a\.md and .*b\.md both define "twin"/);
  });

  it("a distribution's pack overrides the default by id and adds its own", () => {
    const dir = pack({
      "planner.md": "---\nname: planner\ndescription: Ours.\n---\nOur plan.\n",
      "code-reviewer.md": CLAUDE_CODE_AGENT,
    });
    const all = loadPersonas([dir]);
    expect(all.get("planner")?.prompt).toBe("Our plan.");
    expect(all.get("planner")?.source).toBe(path.join(dir, "planner.md"));
    expect(all.get("code-reviewer")?.model).toBe("sonnet");
    // The rest of the default pack is still there.
    expect(all.get("orchestrator")?.standing).toBe(true);
  });
});

describe("agents.persona_packs", () => {
  it("paths are relative to the distribution root", () => {
    const root = pack({ "personas/a.md": "---\nname: a\n---\nx\n" });
    expect(resolvePackDirs(["personas"], root)).toEqual([
      path.join(root, "personas"),
    ]);
  });

  it("a pack that is not a directory is an error naming the key", () => {
    const root = pack({ "file.md": "x" });
    expect(() => resolvePackDirs(["nope"], root)).toThrow(
      /agents\.persona_packs\[0\]: .*nope is not a directory/,
    );
    expect(() => resolvePackDirs(["file.md"], root)).toThrow(
      /agents\.persona_packs\[0\]/,
    );
  });

  it("must be a list of paths, naming the key", () => {
    const cfg = (v: unknown) => ({
      environments: [],
      agents: { persona_packs: v as string[] },
    });
    expect(readAgentsConfig(cfg(["a", "b"])).personaPacks).toEqual(["a", "b"]);
    expect(readAgentsConfig({ environments: [] }).personaPacks).toEqual([]);
    expect(() => readAgentsConfig(cfg("a"))).toThrow(
      /agents\.persona_packs: must be a list of paths/,
    );
    expect(() => readAgentsConfig(cfg(["a", 3]))).toThrow(
      /agents\.persona_packs\[1\]: must be a non-empty path/,
    );
  });

  it("agents.<id>.grants is a list of workspace names, naming the key", () => {
    const cfg = (agents: unknown) => ({
      environments: [],
      agents: agents as Record<string, never>,
    });
    expect(
      readAgentsConfig(cfg({ planner: { grants: ["south"] } })).agents,
    ).toEqual({ planner: { grants: ["south"] } });
    expect(() =>
      readAgentsConfig(cfg({ planner: { grants: "south" } })),
    ).toThrow(/agents\.planner\.grants: must be a list of project names/);
    expect(() =>
      readAgentsConfig(cfg({ planner: { grants: ["../x"] } })),
    ).toThrow(/agents\.planner\.grants\[0\]: "\.\.\/x" is not a project name/);
    expect(() => readAgentsConfig(cfg({ planner: { grant: ["x"] } }))).toThrow(
      /agents\.planner\.grant: unknown key \(an agent takes grants\)/,
    );
    expect(() => readAgentsConfig(cfg({ "a b": { grants: [] } }))).toThrow(
      /agents\.a b: unknown key/,
    );
  });
});
