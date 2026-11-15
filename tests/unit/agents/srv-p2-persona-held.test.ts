/**
 * SRV-P2 (0.4.48): agents ask to add or change a persona (persona_create,
 * persona_update), held for the person's Allow. The check says what the
 * Allow writes, the instructions in full; the run is the Personas page's
 * own write. Only a local persona changes; a built-in or a distribution's
 * is refused before anything waits. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  checkPersonaCreate,
  checkPersonaUpdate,
  createPersona,
  personaDetail,
  resolveAgentsDeps,
  runPersonaUpdate,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const mine = {
  displayName: "Copy checker",
  role: "reviewer",
  category: "marketing",
  description: "Checks copy for tone and typos.",
  instructions: "Read the changed copy.\nReport tone and typo problems.",
  runtime: "den-claude",
  model: "sonnet",
  version: "latest",
  permission: "ask",
  allowedCommands: ["git diff"],
};

describe("SRV-P2: persona_create", () => {
  it("says what it adds, its instructions in full; on Allow writes it as the Personas page does", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    const c = checkPersonaCreate(d, mine);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.summary).toBe("add persona Copy checker (copy-checker)");
    expect(c.params).toEqual({ name: "Copy checker", id: "copy-checker" });
    const review = c.details.join("\n");
    expect(review).toMatch(/Role: reviewer/);
    expect(review).toMatch(/Mode: ask/);
    expect(review).toMatch(
      /Read the changed copy\.\nReport tone and typo problems\./,
    );
    // Nothing is written by the check.
    expect(
      fs.existsSync(path.join(r.stateDir, "personas", "copy-checker.md")),
    ).toBe(false);
    const made = createPersona(d, c.args);
    expect(made).toMatchObject({ id: "copy-checker", origin: "local" });
  });

  it("a bad persona is refused before anything waits, in the page's words", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    const c = checkPersonaCreate(d, { ...mine, role: "pirate" });
    expect(c.ok ? "" : c.error).toMatch(/role: "pirate" is not one of/);
    const empty = checkPersonaCreate(d, { ...mine, instructions: "" });
    expect(empty.ok ? "" : empty.error).toMatch(/instructions are required/);
  });
});

describe("SRV-P2: persona_update", () => {
  it("changes only the fields given; the Allow lists them; on Allow writes them", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    createPersona(d, mine);
    const c = checkPersonaUpdate(d, {
      id: "copy-checker",
      description: "Checks copy.",
      permission: "edits",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.summary).toBe(
      "change persona copy-checker: description, permission",
    );
    expect(c.params).toEqual({
      id: "copy-checker",
      fields: "description, permission",
    });
    expect(c.details.join("\n")).toMatch(/description: Checks copy\./);
    await runPersonaUpdate(d, c.args);
    const after = personaDetail(d, "copy-checker");
    expect(after).toMatchObject({
      description: "Checks copy.",
      permission: "edits",
      model: "sonnet",
    });
    expect(after.instructions).toBe(mine.instructions);
  });

  it("a built-in persona, an unknown one, or no change is refused before anything waits", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    const why = (a: Record<string, unknown>) => {
      const c = checkPersonaUpdate(d, a);
      return c.ok ? "" : c.error;
    };
    expect(why({ id: "planner", description: "x" })).toMatch(
      /planner is built in: duplicate it/,
    );
    expect(why({ id: "nobody", description: "x" })).toMatch(
      /no persona "nobody"/,
    );
    createPersona(d, mine);
    expect(why({ id: "copy-checker" })).toMatch(/nothing to change/);
    expect(why({ id: "copy-checker", description: mine.description })).toMatch(
      /nothing to change/,
    );
  });
});
