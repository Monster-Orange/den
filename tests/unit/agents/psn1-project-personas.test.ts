/**
 * PSN-1 and PSN-3 (0.4.48, den#135).
 *
 * PSN-1: a project's personas live in its repos, `.den/personas/*.md`, read
 * from what each repo has checked out (main, a branch, or a worktree the
 * repo points at). Per id: local > project > distribution > built-in; with
 * two repos naming one id, the first repo's. Only that project sees them.
 *
 * PSN-3: an agent's record keeps the persona id, origin and content hash
 * it started with (for the newer-version prompt, PSN-4).
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  listPersonas,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

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

function persona(dir: string, id: string, said: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(
    file,
    `---\nname: ${id}\nrole: reviewer\ndescription: ${said}\n---\n\n${said} Be brief.\n`,
  );
  return file;
}

const repoPersonas = (r: Rig, repo: string) =>
  path.join(r.wsDir("north"), repo, ".den", "personas");

describe("PSN-1: a project's personas, from its repos", () => {
  it("a repo's .den/personas are the project's: listed and startable there, never elsewhere", async () => {
    const r = await repoRig();
    persona(repoPersonas(r, "shop"), "translator", "Translates the shop.");
    const d = resolveAgentsDeps(r.deps);
    const north = listPersonas(d, "north").find((p) => p.id === "translator");
    expect(north).toMatchObject({ origin: "project" });
    expect(listPersonas(d).some((p) => p.id === "translator")).toBe(false);
    expect(listPersonas(d, "south").some((p) => p.id === "translator")).toBe(
      false,
    );
    expect(
      await agents(r, "start", "-w", "north", "--persona", "translator"),
    ).toBe(0);
    expect(readRecord(r.stateDir, "translator")?.persona).toBe("translator");
    expect(
      await agents(r, "start", "-w", "south", "--persona", "translator"),
    ).not.toBe(0);
  });

  it("per id: local over project over built-in; two repos: the first repo's", async () => {
    const r = await repoRig();
    persona(repoPersonas(r, "shop"), "planner", "The shop's planner.");
    persona(repoPersonas(r, "notes"), "planner", "The notes planner.");
    const d = resolveAgentsDeps(r.deps);
    const one = () => listPersonas(d, "north").find((p) => p.id === "planner");
    expect(one()).toMatchObject({
      origin: "project",
      description: "The notes planner.",
    });
    persona(path.join(r.stateDir, "personas"), "planner", "My own planner.");
    expect(one()).toMatchObject({
      origin: "local",
      description: "My own planner.",
    });
  });
});

describe("PSN-3: the record keeps the persona it started with", () => {
  it("its id, origin and the file's content hash", async () => {
    const r = await repoRig();
    const file = persona(
      repoPersonas(r, "shop"),
      "translator",
      "Translates the shop.",
    );
    expect(
      await agents(r, "start", "-w", "north", "--persona", "translator"),
    ).toBe(0);
    const rec = readRecord(r.stateDir, "translator")!;
    expect(rec).toMatchObject({
      persona: "translator",
      personaOrigin: "project",
      personaHash: createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex"),
    });
  });

  it("a built-in persona's too", async () => {
    const r = await repoRig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const rec = readRecord(r.stateDir, "planner")!;
    expect(rec.personaOrigin).toBe("builtin");
    expect(rec.personaHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
