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
  listPersonas,
  resolveAgentsDeps,
  runPersonaCreate,
  runPersonaUpdate,
} from "../../../src/ui/cli/agent-ops.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

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

/** north has notes (first) and shop; south has none. */
async function repoRig(): Promise<Rig> {
  let wsDir: (ws: string) => string = () => "";
  const r = await rig({
    workspaceServices: (ws) =>
      ws === "north"
        ? [
            { address: "notes/api", path: path.join(wsDir("north"), "notes") },
            { address: "shop", path: path.join(wsDir("north"), "shop") },
          ]
        : [],
  });
  wsDir = r.wsDir;
  for (const repo of ["notes", "shop"])
    fs.mkdirSync(path.join(r.wsDir("north"), repo), { recursive: true });
  return r;
}

const lead = { agent: "lead", project: "north" };

describe("SRV-P2 + PSN-1: a project's agent writes its project's personas", () => {
  it("persona_create from a project's agent is a file in its project's repo, shown in the Allow", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const c = checkPersonaCreate(d, mine, lead);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const file = path.join(
      r.wsDir("north"),
      "notes",
      ".den",
      "personas",
      "copy-checker.md",
    );
    expect(c.summary).toBe(
      "add persona Copy checker (copy-checker) to project north › notes",
    );
    expect(c.params).toEqual({
      name: "Copy checker",
      id: "copy-checker",
      where: "north › notes",
      inProject: "1",
    });
    expect(c.details[0]).toBe(
      `File: ${file} (new; commit it so the project's other Dens get it)`,
    );
    expect(fs.existsSync(file)).toBe(false);
    await runPersonaCreate(d, c.args);
    expect(fs.readFileSync(file, "utf-8")).toMatch(
      /^---\nname: copy-checker\n/,
    );
    expect(
      listPersonas(d, "north").find((p) => p.id === "copy-checker")?.origin,
    ).toBe("project");
    // Not this machine's own: nothing under the state dir.
    expect(
      fs.existsSync(path.join(r.stateDir, "personas", "copy-checker.md")),
    ).toBe(false);
  });

  it("a repo can be named; another project, or a project with no repo, is refused", async () => {
    const r = await repoRig();
    fs.mkdirSync(r.wsDir("south"), { recursive: true });
    const d = resolveAgentsDeps(r.deps);
    const shop = checkPersonaCreate(d, { ...mine, repo: "shop" }, lead);
    expect(shop.ok && shop.params.where).toBe("north › shop");
    const other = checkPersonaCreate(d, { ...mine, project: "south" }, lead);
    expect(other.ok ? "" : other.error).toBe(
      "lead works in project north: it can add personas there only, not to project south",
    );
    const bare = checkPersonaCreate(d, { ...mine, project: "south" }, {});
    expect(bare.ok ? "" : bare.error).toMatch(
      /project south has no repo to keep personas in/,
    );
  });

  it("the server agent or a person: this machine's own persona, unless they name a project", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const own = checkPersonaCreate(d, mine, {
      agent: "server",
      project: SERVER_SCOPE,
    });
    expect(own.ok && own.summary).toBe(
      "add persona Copy checker (copy-checker)",
    );
    expect(own.ok && own.details[0]).toBe(
      "File: this machine's own personas (not shared with the project)",
    );
    const named = checkPersonaCreate(d, { ...mine, project: "north" }, {});
    expect(named.ok && named.params.where).toBe("north › notes");
  });

  it("persona_update from a project's agent: its project's personas only; the file is rewritten", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const made = checkPersonaCreate(d, mine, lead);
    if (!made.ok) throw new Error(made.error);
    await runPersonaCreate(d, made.args);
    const c = checkPersonaUpdate(
      d,
      { id: "copy-checker", description: "Checks copy." },
      lead,
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.params.where).toBe("north › notes");
    await runPersonaUpdate(d, c.args);
    expect(
      listPersonas(d, "north").find((p) => p.id === "copy-checker")
        ?.description,
    ).toBe("Checks copy.");
    createPersona(d, { ...mine, displayName: "Mine only" });
    const local = checkPersonaUpdate(
      d,
      { id: "mine-only", description: "x" },
      lead,
    );
    expect(local.ok ? "" : local.error).toBe(
      "mine-only is this machine's own persona: a project's agent changes only its project's personas (its repos' .den/personas)",
    );
  });
});
