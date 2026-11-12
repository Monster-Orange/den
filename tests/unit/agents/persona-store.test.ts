/**
 * The Start dialog's building blocks: permissions as intent (AG-13), the
 * role and category registries (AG-10.5, AG-11), a person's own personas
 * (AG-10.7) and how den-claude says each choice (AG-12, AG-13). Temp dirs
 * only; nothing runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkCommands,
  checkIntent,
  commandProblem,
  intentOf,
} from "../../../src/shared/agents/permissions.js";
import {
  categoryRegistry,
  checkCategoriesConfig,
  checkRolesConfig,
  DEN_ROLES,
  roleRegistry,
  rolePreset,
} from "../../../src/shared/agents/roles.js";
import {
  checkModelChoice,
  checkPersonaInput,
  deleteLocalPersona,
  newPersonaId,
  personaMarkdown,
  writeLocalPersona,
  type PersonaChoices,
} from "../../../src/shared/agents/persona-store.js";
import {
  loadPersonas,
  parsePersona,
} from "../../../src/shared/agents/personas.js";
import {
  allowRules,
  DEN_CLAUDE_MODELS,
} from "../../../src/shared/agents/den-claude.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-personas-"));
  tmps.push(d);
  return d;
};

describe("permissions as intent (AG-13)", () => {
  it("Den's three intents; Claude Code's own modes read as the intent they meant", () => {
    expect(intentOf(undefined)).toBe("ask");
    expect(intentOf("edits")).toBe("edits");
    expect(intentOf("default")).toBe("ask");
    expect(intentOf("acceptEdits")).toBe("edits");
    expect(intentOf("bypassPermissions")).toBe("all");
    expect(intentOf("plan")).toBeUndefined();
    expect(checkIntent("all", "p")).toBe("all");
    expect(() => checkIntent("yolo", "p")).toThrow(
      /p: "yolo" must be one of ask, edits, auto, all/,
    );
  });

  it("an extra command is a plain prefix: no shell syntax, no patterns, capped", () => {
    expect(checkCommands([" npm test ", "npm test", "make lint"], "x")).toEqual(
      ["npm test", "make lint"],
    );
    expect(checkCommands(undefined, "x")).toEqual([]);
    for (const c of [
      "npm test; rm -rf /",
      "a && b",
      "a`b`",
      "a > f",
      "'q'",
      "a\nb",
      "-x",
      "a  b",
    ])
      expect([c, commandProblem(c)]).toEqual([c, "invalid"]);
    // $ and | are shell syntax and pattern characters both: never a prefix.
    for (const c of ["echo $HOME", "a | b"])
      expect(commandProblem(c)).not.toBeNull();
    for (const c of ["npm *", "git [a]", "x?"])
      expect([c, commandProblem(c)]).toEqual([c, "pattern"]);
    expect(commandProblem("a".repeat(121))).toBe("long");
    expect(() => checkCommands("npm test", "x")).toThrow(/x: must be a list/);
    expect(() => checkCommands([1], "x")).toThrow(/x\[0\]: must be a string/);
    expect(() => checkCommands(Array(33).fill("a"), "x")).toThrow(/at most 32/);
  });
});

describe("roles and categories (AG-10.5, AG-11)", () => {
  it("Den's six roles, each with a read-only preset; Den's five categories", () => {
    expect(DEN_ROLES.map((r) => r.id)).toEqual([
      "planner",
      "orchestrator",
      "sde",
      "reviewer",
      "tester",
      "designer",
    ]);
    for (const r of DEN_ROLES)
      for (const c of r.preset)
        expect(c).toMatch(
          /^(git (status|diff|log)|gh (issue|pr) (list|view|diff))$/,
        );
    expect(categoryRegistry().map((c) => c.id)).toEqual([
      "engineering",
      "design",
      "product",
      "marketing",
      "operations",
    ]);
  });

  it("a distribution adds roles and categories, and may only extend a Den role's preset", () => {
    const cats = checkCategoriesConfig([{ id: "legal", label: "Legal" }]);
    expect(cats).toEqual([
      { id: "legal", label: "Legal", source: "distribution" },
    ]);
    const cfg = checkRolesConfig(
      {
        copywriter: {
          description: "Writes copy.",
          category: "legal",
          preset: ["vale"],
        },
        reviewer: { preset: ["semgrep"] },
      },
      categoryRegistry(cats).map((c) => c.id),
    );
    const roles = roleRegistry(cfg);
    expect(roles.find((r) => r.id === "copywriter")).toMatchObject({
      source: "distribution",
      mode: "ask",
      preset: ["vale"],
    });
    expect(roles.find((r) => r.id === "reviewer")).toMatchObject({
      extendedBy: "distribution",
      extension: ["semgrep"],
    });
    expect(rolePreset(roles, "reviewer")).toContain("semgrep");
    expect(rolePreset(roles, "reviewer")).toContain("git diff");
    expect(() => checkRolesConfig({ reviewer: { description: "x" } })).toThrow(
      /reviewer is Den's role: a distribution may only extend its preset/,
    );
    expect(() => checkRolesConfig({ Bad: {} })).toThrow(
      /a role id must be lowercase/,
    );
    expect(() => checkCategoriesConfig([{ id: "design", label: "D" }])).toThrow(
      /already a category/,
    );
    expect(() =>
      checkRolesConfig({ x: { description: "d", mode: "bypassPermissions" } }),
    ).toThrow(/mode: "bypassPermissions" must be one of ask, edits, auto, all/);
  });
});

const CHOICES: PersonaChoices = {
  roles: DEN_ROLES.map((r) => r.id),
  categories: categoryRegistry().map((c) => c.id),
  runtimes: [
    { id: "den-claude", models: DEN_CLAUDE_MODELS },
    { id: "generic", models: [] },
  ],
};
const INPUT = {
  displayName: "Copy checker",
  role: "reviewer",
  category: "marketing",
  description: "Checks copy.",
  instructions: "Read it.\r\nReport problems.",
  runtime: "den-claude",
  model: "opus",
  version: "claude-opus-4-8",
  permission: "edits",
  allowedCommands: ["git diff"],
};

describe("a person's own personas (AG-10.7)", () => {
  it("checks a model and version against the runtime's catalog", () => {
    const rt = CHOICES.runtimes[0];
    expect(checkModelChoice(rt, "opus", undefined)).toEqual({
      model: "opus",
      version: "latest",
    });
    expect(checkModelChoice(rt, "", "")).toEqual({ version: "latest" });
    expect(() => checkModelChoice(rt, "opus", "claude-sonnet-4-6")).toThrow(
      /not "latest" or one of opus's/,
    );
    expect(() =>
      checkModelChoice(CHOICES.runtimes[1], "opus", undefined),
    ).toThrow(/generic takes no model choice/);
  });

  it("a checked persona round-trips through its file, read as the person's own", () => {
    const input = checkPersonaInput(INPUT, CHOICES);
    expect(input.instructions).toBe("Read it.\nReport problems.");
    const dir = tmp();
    writeLocalPersona(dir, "copy-checker", input);
    const file = path.join(dir, "personas", "copy-checker.md");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const p = parsePersona(fs.readFileSync(file, "utf-8"), file, "local")!;
    expect(p).toMatchObject({
      id: "copy-checker",
      displayName: "Copy checker",
      role: "reviewer",
      category: "marketing",
      description: "Checks copy.",
      runtime: "den-claude",
      model: "opus",
      version: "claude-opus-4-8",
      permissionMode: "edits",
      allowedCommands: ["git diff"],
      origin: "local",
      prompt: "Read it.\nReport problems.",
    });
    expect(deleteLocalPersona(dir, "copy-checker")).toBe(true);
    expect(deleteLocalPersona(dir, "copy-checker")).toBe(false);
  });

  it("a front matter value can't smuggle keys or lines in (it is YAML, quoted as needed)", () => {
    const input = checkPersonaInput(
      { ...INPUT, description: "a: b --- standing: true", displayName: "x: y" },
      CHOICES,
    );
    const p = parsePersona(personaMarkdown("p", input), "/x/p.md", "local")!;
    expect(p.description).toBe("a: b --- standing: true");
    expect(p.displayName).toBe("x: y");
    expect(p.standing).toBe(false);
  });

  it("a local persona is read after the packs, with its origin", () => {
    const dir = tmp();
    writeLocalPersona(dir, "mine", checkPersonaInput(INPUT, CHOICES));
    const all = loadPersonas(
      [],
      undefined,
      undefined,
      path.join(dir, "personas"),
    );
    expect(all.get("mine")?.origin).toBe("local");
    expect(all.get("planner")?.origin).toBe("builtin");
  });

  it("a new persona's id comes from its name, made unique", () => {
    expect(
      newPersonaId(
        { displayName: "Copy Checker!", role: "reviewer" },
        new Set(),
      ),
    ).toBe("copy-checker");
    expect(newPersonaId({ role: "reviewer" }, new Set(["reviewer"]))).toBe(
      "reviewer-2",
    );
    expect(newPersonaId({ displayName: "日本", role: "sde" }, new Set())).toBe(
      "persona",
    );
  });

  it("an id that isn't one never reaches the file system", () => {
    expect(() => deleteLocalPersona(tmp(), "../x")).toThrow(
      /is not a persona id/,
    );
  });
});

describe("den-claude's translation (AG-13.3)", () => {
  it("one prefix is two allow rules: the command alone and with arguments", () => {
    expect(allowRules(["npm test", "git diff"])).toEqual([
      "Bash(npm test)",
      "Bash(npm test *)",
      "Bash(git diff)",
      "Bash(git diff *)",
    ]);
  });
});
