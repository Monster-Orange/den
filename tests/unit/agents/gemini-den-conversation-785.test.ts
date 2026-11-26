/**
 * Issue 785: Gemini resumes a conversation whose id Den chose. Den starts
 * it with `--session-id <uuid>` and resumes with `--resume <uuid>`, so
 * nothing the agent writes reaches its startup command. The catalog says
 * so with `resume.conversation: "den"` and the words that start under an
 * id (`resume.start`), held to the same rules as a resume template.
 */
import { describe, expect, it } from "@jest/globals";
import {
  BUILTIN_CATALOG,
  validateCatalog,
} from "../../../src/shared/agents/catalog.js";
import { catalogRuntime } from "../../../src/shared/agents/catalog-runtime.js";
import type { LaunchInput } from "../../../src/shared/agents/runtime.js";

const BIN = "/opt/tools/bin/gemini";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const gemini = () => BUILTIN_CATALOG.find((e) => e.id === "gemini")!;

const input = (o: Partial<LaunchInput> = {}): LaunchInput =>
  ({
    persona: { id: "planner" },
    workspace: { name: "north", dir: "/work/north" },
    agentId: "planner",
    worktree: "/work/north",
    mcp: { name: "acme", command: ["/x/acme", "mcp"], env: {}, scope: "north" },
    filesDir: "/state/files/planner",
    stateDir: "/state",
    env: {},
    bin: BIN,
    ...o,
  }) as LaunchInput;

const entry = (resume: unknown) => ({
  id: "acme-cli",
  vendor: "Acme",
  name: "Acme CLI",
  bins: ["acme"],
  version: { args: ["--version"], identity: { output: "acme" } },
  dirs: [],
  launch: { argv: ["{bin}"] },
  resume,
});

describe("issue 785: Gemini's conversation id is Den's", () => {
  it("the catalog: Den chooses the id; it starts under it and resumes by it", () => {
    expect(gemini().resume).toEqual({
      argv: ["{bin}", "--resume", "{conversation}"],
      conversation: "den",
      start: ["--session-id", "{conversation}"],
    });
    // Codex still resumes the conversation its agent reports.
    expect(
      BUILTIN_CATALOG.find((e) => e.id === "codex")!.resume?.conversation,
    ).toBeUndefined();
  });

  it("a launch picks a new id, starts under it, and keeps it", () => {
    const rt = catalogRuntime(gemini());
    const out = rt.launch(input());
    expect(out.resumeToken).toMatch(UUID);
    expect(out.argv).toEqual([BIN, "--session-id", out.resumeToken]);
    expect(rt.launch(input()).resumeToken).not.toBe(out.resumeToken);
    expect(rt.reportedResume).toBeFalsy();
  });

  it("a fresh start under the id it had keeps it; one that isn't Den's shape gets a new one", () => {
    const rt = catalogRuntime(gemini());
    const id = "6f1c2a9e-0b3d-4c5e-8f7a-1b2c3d4e5f60";
    expect(rt.launch(input({ resumeToken: id })).argv).toEqual([
      BIN,
      "--session-id",
      id,
    ]);
    for (const bad of ["--yolo", "a b", "x;rm"]) {
      const out = rt.launch(input({ resumeToken: bad }));
      expect(out.resumeToken).toMatch(UUID);
      expect(out.argv).not.toContain(bad);
    }
  });

  it("a resume is its template with the id Den kept; none or a bad one, nothing to resume", () => {
    const rt = catalogRuntime(gemini());
    const id = "6f1c2a9e-0b3d-4c5e-8f7a-1b2c3d4e5f60";
    expect(rt.resume!(input({ resumeToken: id }))?.argv).toEqual([
      BIN,
      "--resume",
      id,
    ]);
    expect(rt.resume!(input())).toBeNull();
    expect(rt.resume!(input({ resumeToken: "--yolo" }))).toBeNull();
  });

  it("an added entry's mode and start words are held to the rules", () => {
    const good = {
      argv: ["{bin}", "--resume", "{conversation}"],
      conversation: "den",
      start: ["--session-id", "{conversation}"],
    };
    expect(validateCatalog([entry(good)], "t")[0]?.resume).toEqual(good);
    expect(
      validateCatalog(
        [entry({ argv: good.argv, conversation: "reported" })],
        "t",
      )[0]?.resume,
    ).toEqual({ argv: good.argv });
    for (const bad of [
      { ...good, conversation: "agent" },
      { argv: good.argv, conversation: "den" }, // no start words
      { argv: good.argv, start: good.start }, // start words, not Den's id
      { ...good, start: ["--session-id"] },
      { ...good, start: ["--session-id={conversation}"] },
      { ...good, start: ["{conversation}", "{conversation}"] },
      { ...good, start: ["{bin}", "--session-id", "{conversation}"] },
      { ...good, start: ["-a", "-b", "-c", "-d", "{conversation}"] },
    ])
      expect(() => validateCatalog([entry(bad)], "t")).toThrow(/resume/);
  });
});
