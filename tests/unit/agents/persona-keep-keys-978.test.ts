/**
 * Issue 978: an edit (the Personas page's Edit, or a held persona_update)
 * rewrites only the fields the form has. Every other front-matter key
 * (subagent_model, persona_version, tools, context, den_hooks …) is kept:
 * before, any edit dropped them. Local and project personas alike.
 *
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkPersonaUpdate,
  createPersona,
  personaDetail,
  resolveAgentsDeps,
  runPersonaUpdate,
  updatePersona,
} from "../../../src/ui/cli/agent-ops.js";
import { parsePersona } from "../../../src/shared/agents/personas.js";
import { writeProjectPersona } from "../../../src/shared/agents/persona-store.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const mine = {
  displayName: "Copy checker",
  role: "reviewer",
  category: "marketing",
  description: "Checks copy for tone and typos.",
  instructions: "Read the changed copy.",
  runtime: "den-claude",
  model: "sonnet",
  version: "latest",
  permission: "ask",
  allowedCommands: [],
};

const EXTRA =
  "subagent_model: haiku\npersona_version: v3\ntools: Read, Grep\ncontext:\n  - docs/specs\nden_hooks: false\n";

/** Add keys the page doesn't manage to `file`'s front matter, by hand. */
function handEdit(file: string): void {
  const s = fs.readFileSync(file, "utf-8");
  fs.writeFileSync(file, s.replace(/^---\n/, `---\n${EXTRA}`));
}

const kept = (file: string) => {
  const text = fs.readFileSync(file, "utf-8");
  const p = parsePersona(text, file)!;
  return {
    subagentModel: p.subagentModel,
    personaVersion: p.personaVersion,
    tools: /^tools: Read, Grep$/m.test(text),
    context: /^context:\n {2}- docs\/specs$/m.test(text),
    denHooks: /^den_hooks: false$/m.test(text),
  };
};
const ALL_KEPT = {
  subagentModel: "haiku",
  personaVersion: "v3",
  tools: true,
  context: true,
  denHooks: true,
};

describe("an edit keeps the keys it doesn't manage", () => {
  it("the Personas page's Edit", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    createPersona(d, mine);
    const file = path.join(r.stateDir, "personas", "copy-checker.md");
    handEdit(file);
    updatePersona(d, "copy-checker", { ...mine, description: "Checks copy." });
    expect(kept(file)).toEqual(ALL_KEPT);
    expect(personaDetail(d, "copy-checker").description).toBe("Checks copy.");
  });

  it("persona_update, on Allow", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    createPersona(d, mine);
    const file = path.join(r.stateDir, "personas", "copy-checker.md");
    handEdit(file);
    const c = checkPersonaUpdate(d, {
      id: "copy-checker",
      description: "Checks copy.",
    });
    if (!c.ok) throw new Error(c.error);
    await runPersonaUpdate(d, c.args);
    expect(kept(file)).toEqual(ALL_KEPT);
  });

  it("a project's persona file, too", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-pk-"));
    try {
      const file = writeProjectPersona(dir, "scribe", mine as never);
      handEdit(file);
      writeProjectPersona(dir, "scribe", {
        ...mine,
        description: "Writes.",
      } as never);
      expect(kept(file)).toEqual(ALL_KEPT);
      expect(
        parsePersona(fs.readFileSync(file, "utf-8"), file)!.description,
      ).toBe("Writes.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
