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
  forcesSubagentModel,
  subagentsBlock,
} from "../../../src/shared/agents/subagents.js";
import { subagentLines } from "../../../src/ui/cli/agents-command.js";
import {
  deprecatedKeys,
  userYmlOrgKeys,
} from "../../../src/ui/cli/doctor-command.js";
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
    ).toEqual({ model: "haiku", claudeAiConnectors: false, modelSet: true });
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

describe("dev.0 gate's nits", () => {
  it("an org that sets sonnet itself: from the org, not Den's default", () => {
    const set = readAgentsConfig(
      cfg({ subagents: { model: "sonnet" } }),
    ).subagents!;
    expect(effectiveSubagentModel({}, set)).toEqual({
      model: "sonnet",
      from: "org",
    });
    expect(
      effectiveSubagentModel({}, readAgentsConfig({} as DenConfig).subagents),
    ).toEqual({ model: "sonnet", from: "default" });
  });

  it("forced needs Claude Code 2.1.257+: doctor warns on an older one", () => {
    expect(forcesSubagentModel("2.1.322 (Claude Code)")).toBe(true);
    expect(forcesSubagentModel("2.1.257")).toBe(true);
    expect(forcesSubagentModel("2.1.256")).toBe(false);
    expect(forcesSubagentModel("1.9.999")).toBe(false);
    expect(forcesSubagentModel("3.0.0")).toBe(true);
    expect(forcesSubagentModel(undefined)).toBeNull();
    const rep = {
      model: "sonnet",
      from: "default" as const,
      claudeAiConnectors: false,
      personas: [],
      agents: [],
    };
    expect(subagentLines(rep, "2.1.200").join("\n")).toMatch(
      /⚠ forced {4}no: Claude Code 2\.1\.200 takes it only as a fallback.*2\.1\.257 or later/,
    );
    expect(subagentLines(rep, "2.1.322").join("\n")).not.toContain("⚠");
    expect(subagentLines(rep).join("\n")).not.toContain("⚠");
    expect(
      subagentLines({ ...rep, model: "inherit" }, "2.1.200").join("\n"),
    ).not.toContain("⚠");
  });

  it("agents.subagents or claude_ai_connectors in user.yml: doctor says it does nothing there", () => {
    expect(
      userYmlOrgKeys(() => ({
        agents: { subagents: { model: "haiku" }, claude_ai_connectors: true },
      })),
    ).toEqual([
      expect.stringMatching(
        /^config\/local\/user\.yml: agents\.subagents does nothing there; it is the org's, set in /,
      ),
      expect.stringMatching(/agents\.claude_ai_connectors does nothing there/),
    ]);
    expect(userYmlOrgKeys(() => ({ agents: { runtimes: {} } }))).toEqual([]);
    expect(userYmlOrgKeys(() => ({}))).toEqual([]);
    // doctor's config notes carry it.
    expect(
      deprecatedKeys(() => ({ agents: { claude_ai_connectors: true } })),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "agents.claude_ai_connectors does nothing there",
        ),
      ]),
    );
  });
});
