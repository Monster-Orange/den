import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEN_ROLES,
  categoryRegistry,
} from "../../../src/shared/agents/roles.js";
import {
  checkPersonaInput,
  writeLocalPersona,
  type PersonaChoices,
} from "../../../src/shared/agents/persona-store.js";
import { parsePersona } from "../../../src/shared/agents/personas.js";
import { DEN_CLAUDE_MODELS } from "../../../src/shared/agents/den-claude.js";

const CHOICES: PersonaChoices = {
  roles: DEN_ROLES.map((r) => r.id),
  categories: categoryRegistry().map((c) => c.id),
  runtimes: [{ id: "den-claude", models: DEN_CLAUDE_MODELS }],
};
const INPUT = {
  role: "reviewer",
  category: "marketing",
  description: "Checks copy.",
  instructions: "Read it.",
  runtime: "den-claude",
  version: "latest",
  permission: "ask",
  allowedCommands: [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function save(extra: Record<string, unknown>, state?: string) {
  const dir = state ?? fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-pe-"));
  if (!state) dirs.push(dir);
  const file = writeLocalPersona(
    dir,
    "checker",
    checkPersonaInput({ ...INPUT, ...extra }, CHOICES),
  );
  return {
    dir,
    file,
    persona: parsePersona(fs.readFileSync(file, "utf-8"), file, "local")!,
  };
}

describe("issue 1631: the persona editor's Skill packs", () => {
  it("off writes skill_packs: off, read back as the persona's off", () => {
    const s = save({ skillPacks: "off" });
    expect(fs.readFileSync(s.file, "utf-8")).toMatch(/^skill_packs: off$/m);
    expect(s.persona.skillPacks).toBe("off");
  });

  it("null puts the install's default back; leaving it out keeps the file's own", () => {
    const s = save({ skillPacks: "off" });
    expect(save({}, s.dir).persona.skillPacks).toBe("off");
    expect(
      save({ skillPacks: null }, s.dir).persona.skillPacks,
    ).toBeUndefined();
    expect(fs.readFileSync(s.file, "utf-8")).not.toMatch(/skill_packs/);
  });

  it("anything else is refused, naming the field", () => {
    expect(() =>
      checkPersonaInput({ ...INPUT, skillPacks: "maybe" }, CHOICES),
    ).toThrow(/skillPacks: off, or null for the install's/);
  });
});
