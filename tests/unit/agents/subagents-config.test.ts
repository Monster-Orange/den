/**
 * den#3 (3a): `agents.subagents.model` (default sonnet), a persona's
 * `subagent_model` (wins), `inherit` (none of Den's), and
 * `agents.claude_ai_connectors` (default false). A bad key or value fails
 * naming it.
 */
import { describe, expect, it } from "@jest/globals";
import { DEN_CLAUDE_ID } from "../../../src/shared/agents/den-claude.js";
import { parsePersona } from "../../../src/shared/agents/personas.js";
import { getRuntime, runtimeIds } from "../../../src/shared/agents/runtimes.js";
import {
  SUBAGENT_DEFAULTS,
  effectiveSubagentModel,
  subagentsBlock,
} from "../../../src/shared/agents/subagents.js";
import {
  AGENTS_RESERVED_KEYS,
  readAgentsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";

const cfg = (agents: Record<string, unknown>) =>
  ({ agents }) as unknown as DenConfig;

describe("agents.subagents and agents.claude_ai_connectors", () => {
  it("unset: sonnet, connectors off", () => {
    expect(SUBAGENT_DEFAULTS).toEqual({
      model: "sonnet",
      claudeAiConnectors: false,
    });
    expect(readAgentsConfig({} as DenConfig).subagents).toEqual(
      SUBAGENT_DEFAULTS,
    );
    expect(subagentsBlock(null, null)).toEqual(SUBAGENT_DEFAULTS);
  });

  it("each key on its own; a full model id and inherit are models too", () => {
    expect(
      readAgentsConfig(cfg({ subagents: { model: "haiku" } })).subagents,
    ).toEqual({ model: "haiku", claudeAiConnectors: false });
    expect(
      readAgentsConfig(cfg({ claude_ai_connectors: true })).subagents,
    ).toEqual({ model: "sonnet", claudeAiConnectors: true });
    for (const m of ["claude-sonnet-5-5", "inherit", " opus "])
      expect(subagentsBlock({ model: m }, undefined).model).toBe(m.trim());
  });

  it("reserved: neither is an agent's id", () => {
    expect(AGENTS_RESERVED_KEYS).toEqual(
      expect.arrayContaining(["subagents", "claude_ai_connectors"]),
    );
  });

  it("a bad key or value fails naming it", () => {
    expect(() => readAgentsConfig(cfg({ subagents: "sonnet" }))).toThrow(
      /agents\.subagents: must be a mapping/,
    );
    expect(() =>
      readAgentsConfig(cfg({ subagents: { model: "sonnet", skills: [] } })),
    ).toThrow(/agents\.subagents\.skills: unknown key/);
    for (const bad of [3, "", "has space", "-x", "a;b"])
      expect(() =>
        readAgentsConfig(cfg({ subagents: { model: bad } })),
      ).toThrow(/agents\.subagents\.model: must be a model/);
    expect(() =>
      readAgentsConfig(cfg({ claude_ai_connectors: "yes" })),
    ).toThrow(/agents\.claude_ai_connectors: must be true or false/);
  });
});

describe("a persona's subagent_model", () => {
  const p = (extra: string) =>
    parsePersona(`---\nname: x\n${extra}---\nbody\n`, "/pack/x.md");

  it("is read, and a bad one fails naming the file", () => {
    expect(p("subagent_model: haiku\n").subagentModel).toBe("haiku");
    expect(p("").subagentModel).toBeUndefined();
    expect(() => p("subagent_model: [a]\n")).toThrow(
      /\/pack\/x\.md: subagent_model: must be a model/,
    );
  });
});

describe("effectiveSubagentModel", () => {
  const org = (model: string) => ({ model, claudeAiConnectors: false });

  it("the persona's wins, else the org's, else the default; each says where from", () => {
    expect(
      effectiveSubagentModel({ subagentModel: "opus" }, org("haiku")),
    ).toEqual({ model: "opus", from: "persona" });
    expect(effectiveSubagentModel({}, org("haiku"))).toEqual({
      model: "haiku",
      from: "org",
    });
    expect(effectiveSubagentModel({}, org("sonnet"))).toEqual({
      model: "sonnet",
      from: "default",
    });
    expect(effectiveSubagentModel({}, undefined)).toEqual({
      model: "sonnet",
      from: "default",
    });
  });

  it("inherit at the level that decides: no model (the runtime decides)", () => {
    expect(
      effectiveSubagentModel({ subagentModel: "inherit" }, org("haiku")),
    ).toEqual({ from: "persona" });
    expect(effectiveSubagentModel({}, org("inherit"))).toEqual({ from: "org" });
    expect(
      effectiveSubagentModel({ subagentModel: "haiku" }, org("inherit")),
    ).toEqual({ model: "haiku", from: "persona" });
  });
});

describe("past the scrub (Runtime.launchEnv)", () => {
  it("den-claude names only its subagent model; no other runtime names any", () => {
    expect(getRuntime(DEN_CLAUDE_ID)?.launchEnv).toEqual([
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
    ]);
    for (const id of runtimeIds().filter((i) => i !== DEN_CLAUDE_ID))
      expect([id, getRuntime(id)?.launchEnv ?? []]).toEqual([id, []]);
  });
});
