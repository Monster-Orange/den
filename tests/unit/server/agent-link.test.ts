/**
 * Issue 103, the deep link's checks (agent-link-routes.ts) and Settings ›
 * Embedding's link limit (embed-settings.ts): a link names a project and
 * an agent record of that project (an id alone may repeat across
 * projects); its context is an http or https URL no longer than the
 * setting. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentLinkOf,
  agentLinkProblem,
} from "../../../src/ui/server/agent-link-routes.js";
import {
  contextUrlProblem,
  embedSettings,
  patchEmbed,
} from "../../../src/ui/server/embed-settings.js";
import { writeRecord } from "../../../src/shared/agents/records.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "den-link-"));
afterAll(() => fs.rmSync(state, { recursive: true, force: true }));
writeRecord(state, {
  id: "scout",
  persona: "builder",
  runtime: "den-claude",
  workspace: "north",
  cwd: state,
  session: { backend: "den-pty", id: "s1" },
  sessionName: "acme-north:scout",
  startedAt: "2026-11-06T09:30:00.000Z",
});
const deps = (max = 8192) => ({
  stateDir: () => state,
  workspaceExists: (ws: string) => ws === "north" || ws === "south",
  urlMax: () => max,
  contextProblem: contextUrlProblem,
});

describe("the deep link's path", () => {
  it("names a project and an agent, decoded", () => {
    expect(agentLinkOf("/p/north/agents/scout")).toEqual({
      project: "north",
      agent: "scout",
    });
    expect(agentLinkOf("/p/north/agents/scout/")).toEqual({
      project: "north",
      agent: "scout",
    });
    expect(agentLinkOf("/p/north/agents")).toBeNull();
    expect(agentLinkOf("/p/north/agents/scout/x")).toBeNull();
    expect(agentLinkOf("/p/%E0%A4%A/agents/scout")).toBeNull();
  });
});

describe("what a deep link opens", () => {
  it("the project's own agent, with or without a context", () => {
    const l = { project: "north", agent: "scout" };
    expect(agentLinkProblem(l, null, deps())).toBeNull();
    expect(
      agentLinkProblem(l, "https://example.test/a?b=1#c", deps()),
    ).toBeNull();
    expect(agentLinkProblem(l, "http://127.0.0.1:9/x", deps())).toBeNull();
  });

  it("a project that isn't there: 404 project", () => {
    const p = agentLinkProblem(
      { project: "west", agent: "scout" },
      null,
      deps(),
    );
    expect(p).toMatchObject({ status: 404, reason: "project" });
    expect(p!.message).toContain("west");
  });

  it("another project's agent, or none: 404 agent, never the other one", () => {
    expect(
      agentLinkProblem({ project: "south", agent: "scout" }, null, deps()),
    ).toMatchObject({ status: 404, reason: "agent" });
    expect(
      agentLinkProblem({ project: "north", agent: "ghost" }, null, deps()),
    ).toMatchObject({ status: 404, reason: "agent" });
    expect(
      agentLinkProblem({ project: "north", agent: "../x" }, null, deps()),
    ).toMatchObject({ status: 404, reason: "agent" });
  });

  it("a context that isn't http or https: 400 context_scheme", () => {
    const l = { project: "north", agent: "scout" };
    for (const c of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/hosts",
      "ftp://example.test/",
      "example.test/page",
      "",
      "https://",
    ])
      expect([c, agentLinkProblem(l, c, deps())?.reason]).toEqual([
        c,
        "context_scheme",
      ]);
  });

  it("a context past the setting: 400 context_long, naming the limit", () => {
    const l = { project: "north", agent: "scout" };
    const long = `https://example.test/${"a".repeat(80)}`;
    expect(agentLinkProblem(l, long, deps(64))).toMatchObject({
      status: 400,
      reason: "context_long",
      max: 64,
    });
    expect(agentLinkProblem(l, long, deps(200))).toBeNull();
  });
});

describe("Settings › Embedding: the link limit", () => {
  it("defaults to 8192, takes a whole number in bounds, null resets", () => {
    const u: UserConfig = {};
    expect(embedSettings(u).url_max_chars).toBe(8192);
    expect(patchEmbed(u, { url_max_chars: 100 })).toEqual({ ok: true });
    expect(embedSettings(u).url_max_chars).toBe(100);
    expect(patchEmbed(u, { url_max_chars: null })).toEqual({ ok: true });
    expect(u.embed).toBeUndefined();
    expect(embedSettings(u).url_max_chars).toBe(8192);
  });

  it("refuses what isn't one", () => {
    const u: UserConfig = {};
    for (const v of [
      { url_max_chars: 1 },
      { url_max_chars: 1.5 },
      { url_max_chars: "100" },
      { other: 1 },
      [],
      "x",
    ])
      expect(patchEmbed(u, v).ok).toBe(false);
    expect(u.embed).toBeUndefined();
  });

  it("a hand-broken value reads as the default", () => {
    expect(
      embedSettings({ embed: { url_max_chars: "big" } }).url_max_chars,
    ).toBe(8192);
  });
});
