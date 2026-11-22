/**
 * Issue 137, slice 1 (PERSONAS-SPEC PSN-2, and PSN-4's signal):
 *
 *   - every persona has a version: Den's content hash of its file, and an
 *     optional readable name, `persona_version` in its front matter;
 *   - the model's version key is `model_version`; the old `version` is
 *     still read, and `agents doctor` notes each persona that uses it;
 *     New persona and Edit write `model_version` and, while older Dens in a
 *     team still read `version`, `version` too, with the same value (a
 *     file with both, the same, is not noted; both, different, is);
 *   - an agent whose persona changed since it started says so in its row
 *     (`personaNewer`: the new version's name, else its short hash).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { parsePersona } from "../../../src/shared/agents/personas.js";
import { personaMarkdown } from "../../../src/shared/agents/persona-store.js";
import { personaVersionLines } from "../../../src/ui/cli/agents-command.js";
import {
  listAgents,
  resolveAgentsDeps,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const md = (fm: string, body = "Review the change.") =>
  `---\n${fm}\n---\n\n${body}\n`;

describe("PSN-2: a persona's version", () => {
  it("is the hash of its file, with persona_version as its readable name", () => {
    const text = md(
      "name: reviewer\ndescription: Reviews\npersona_version: v3",
    );
    const p = parsePersona(text, "/p/reviewer.md")!;
    expect(p.hash).toBe(sha(text));
    expect(p.personaVersion).toBe("v3");
    // None given: no readable name; the hash is still there.
    const q = parsePersona(md("name: reviewer"), "/p/reviewer.md")!;
    expect(q.personaVersion).toBeUndefined();
    expect(q.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a persona_version that isn't a short name is refused, naming the file", () => {
    for (const bad of ['"two words"', '""', "[1]", `"${"x".repeat(41)}"`])
      expect(() =>
        parsePersona(md(`name: r\npersona_version: ${bad}`), "/p/r.md"),
      ).toThrow(/\/p\/r\.md: persona_version must be/);
  });

  it("model_version pins the model; the old version key is still read, and noted", () => {
    const now = parsePersona(
      md("name: r\nmodel: opus\nmodel_version: claude-opus-5-5"),
      "/p/r.md",
    )!;
    expect([now.version, now.legacyVersionKey]).toEqual([
      "claude-opus-5-5",
      undefined,
    ]);
    const old = parsePersona(
      md("name: r\nmodel: opus\nversion: claude-opus-5-5"),
      "/p/r.md",
    )!;
    expect([old.version, old.legacyVersionKey]).toEqual([
      "claude-opus-5-5",
      true,
    ]);
    // Both, the same (what New persona and Edit write, so older Dens in a
    // team read the same pin): fine, not noted.
    const same = parsePersona(
      md("name: r\nmodel: opus\nmodel_version: a1\nversion: a1"),
      "/p/r.md",
    )!;
    expect([
      same.version,
      same.legacyVersionKey,
      same.versionKeysDiffer,
    ]).toEqual(["a1", undefined, undefined]);
    // Both, different: model_version wins here, but an older Den reads
    // version, so it's noted.
    const both = parsePersona(
      md("name: r\nmodel: opus\nmodel_version: a1\nversion: b2"),
      "/p/r.md",
    )!;
    expect([
      both.version,
      both.legacyVersionKey,
      both.versionKeysDiffer,
    ]).toEqual(["a1", undefined, true]);
    expect(() =>
      parsePersona(md('name: r\nmodel_version: "no spaces"'), "/p/r.md"),
    ).toThrow(/model_version must be "latest" or a version id/);
  });

  it("New persona and Edit write model_version and, for older Dens, version: the same value", () => {
    const text = personaMarkdown("r", {
      role: "reviewer",
      category: "engineering",
      description: "Reviews",
      runtime: "den-claude",
      model: "opus",
      version: "latest",
      permission: "default",
      allowedCommands: [],
      instructions: "Review.",
    } as never);
    expect(text).toMatch(/^model_version: latest$/m);
    expect(text).toMatch(/^version: latest$/m);
    // Read back: "latest" (no pin), and nothing for doctor to note.
    const back = parsePersona(text, "/p/r.md")!;
    expect([
      back.version,
      back.legacyVersionKey,
      back.versionKeysDiffer,
    ]).toEqual([undefined, undefined, undefined]);
    const pinned = personaMarkdown("r", {
      role: "reviewer",
      category: "engineering",
      description: "Reviews",
      runtime: "den-claude",
      model: "opus",
      version: "claude-opus-5-5",
      permission: "default",
      allowedCommands: [],
      instructions: "Review.",
    } as never);
    expect(pinned).toMatch(/^model_version: claude-opus-5-5$/m);
    expect(pinned).toMatch(/^version: claude-opus-5-5$/m);
    const pin = parsePersona(pinned, "/p/r.md")!;
    expect([pin.version, pin.legacyVersionKey, pin.versionKeysDiffer]).toEqual([
      "claude-opus-5-5",
      undefined,
      undefined,
    ]);
  });

  it("agents doctor notes each persona still on the old key, or whose two keys differ", () => {
    expect(personaVersionLines([])).toEqual([
      "Persona keys      every persona names its model's version model_version",
    ]);
    expect(
      personaVersionLines([
        { id: "reviewer", source: "/packs/reviewer.md" },
        { id: "planner", source: "/packs/planner.md" },
      ]),
    ).toEqual([
      "Persona keys      2 personas name their model's version `version:`, still read; `model_version:` is its name now:",
      "  reviewer (/packs/reviewer.md)",
      "  planner (/packs/planner.md)",
    ]);
    expect(
      personaVersionLines([], [{ id: "scribe", source: "/packs/scribe.md" }]),
    ).toEqual([
      "Persona keys      1 persona gives model_version and version different values; older Dens read `version:`, so they run another model version:",
      "  scribe (/packs/scribe.md)",
    ]);
  });
});

describe("PSN-4's signal: the agent's row says its persona is newer", () => {
  it("unchanged: nothing; edited after it started: the new version's name, else its short hash", async () => {
    const r = await rig();
    const dir = path.join(r.stateDir, "personas");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "scribe.md");
    fs.writeFileSync(
      file,
      md("name: scribe\nrole: reviewer\ndescription: Writes"),
    );
    const d = resolveAgentsDeps(r.deps);
    await startAgent(d, { workspace: "north", persona: "scribe" });
    const row = async () =>
      (await listAgents(d, "north")).find((x) => x.agent === "scribe")!;
    expect((await row()).personaNewer).toBeUndefined();

    const v2 = md("name: scribe\nrole: reviewer\ndescription: Writes well");
    fs.writeFileSync(file, v2);
    expect((await row()).personaNewer).toEqual({
      version: sha(v2).slice(0, 7),
      hash: sha(v2),
    });

    const v3 = md(
      "name: scribe\nrole: reviewer\ndescription: Writes\npersona_version: v3",
    );
    fs.writeFileSync(file, v3);
    expect((await row()).personaNewer).toEqual({
      version: "v3",
      hash: sha(v3),
    });
  });

  it("a persona that's gone, or an agent with no recorded hash: nothing", async () => {
    const r = await rig();
    const dir = path.join(r.stateDir, "personas");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "scribe.md");
    fs.writeFileSync(file, md("name: scribe\nrole: reviewer"));
    const d = resolveAgentsDeps(r.deps);
    await startAgent(d, { workspace: "north", persona: "scribe" });
    fs.rmSync(file);
    const rows = await listAgents(d, "north");
    expect(
      rows.find((x) => x.agent === "scribe")!.personaNewer,
    ).toBeUndefined();
  });
});
