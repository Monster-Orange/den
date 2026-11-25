/**
 * Issue 110 (Coach Apply), slice 1: what Apply's persona_update needs.
 *
 *   (An edit keeping the keys the form doesn't manage is issue 978's, in
 *   persona-keep-keys-978.test.ts.)
 *   - persona_update takes subagentModel (the persona's subagent_model),
 *     checked as the persona file's own key is.
 *
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  checkPersonaUpdate,
  createPersona,
  resolveAgentsDeps,
  runPersonaUpdate,
} from "../../../src/ui/cli/agent-ops.js";
import { parsePersona } from "../../../src/shared/agents/personas.js";
import { PERSONA_KEYS } from "../../../src/shared/agents/persona-store.js";
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

describe("persona_update takes subagentModel", () => {
  it("is one of the fields; the Allow names it; on Allow the file says it", async () => {
    expect(PERSONA_KEYS).toContain("subagentModel");
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    createPersona(d, mine);
    const file = path.join(r.stateDir, "personas", "copy-checker.md");
    handEdit(file);
    const c = checkPersonaUpdate(d, {
      id: "copy-checker",
      subagentModel: "sonnet",
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.summary).toBe("change persona copy-checker: subagentModel");
    expect(c.details.join("\n")).toMatch(/subagentModel: sonnet/);
    // Nothing is written until the Allow runs it.
    expect(kept(file).subagentModel).toBe("haiku");
    await runPersonaUpdate(d, c.args);
    expect(kept(file)).toEqual({ ...ALL_KEPT, subagentModel: "sonnet" });
  });

  it("a bad value is refused before anything waits", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    createPersona(d, mine);
    const c = checkPersonaUpdate(d, {
      id: "copy-checker",
      subagentModel: "no spaces",
    });
    const why = c.ok ? "" : c.error;
    expect(why).toMatch(/subagent_?[mM]odel/);
    expect(why).not.toMatch(/unknown field/);
  });
});
