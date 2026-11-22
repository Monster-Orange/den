/**
 * Issue 1016: an agent knows its Den's address for people (web.url) and
 * gives full links on it, never a loopback one only this machine opens.
 *  - whoami (agentTools) returns web.url and the links under it;
 *  - with web.url unset: no links, and the note names Settings;
 *  - the start brief carries the address line, and no loopback address.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentTools,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { callTool } from "../../../src/ui/mcp/tools.js";
import { peopleWebUrl } from "../../../src/shared/agent-links.js";
import * as fs from "fs";
import * as path from "path";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  await cleanupRigs();
});

const ADDRESS = "https://den.example.test";
const LOOPBACK = /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])/;
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

async function started(webUrl: string | null): Promise<Rig> {
  const r = await rig({ webUrl: () => webUrl });
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  return r;
}

describe("issue 1016: whoami gives the address and full links", () => {
  it("web.url set: whoami returns it and the four links, all under it", async () => {
    const r = await started(ADDRESS);
    const t = await agentTools(resolveAgentsDeps(r.deps), "planner", "north");
    expect(t.webUrl).toBe(ADDRESS);
    expect(t.links).toEqual({
      agent: `${ADDRESS}/p/north/agents/planner`,
      project: `${ADDRESS}/agents?project=north`,
      notifications: `${ADDRESS}/settings#notifications`,
      allow: `${ADDRESS}/agents?project=north&agent=planner`,
    });
    for (const link of Object.values(t.links ?? {}))
      expect(link.startsWith(`${ADDRESS}/`)).toBe(true);
    expect(t.address).toBe(
      `Den's address for people: ${ADDRESS}. Give full links, never 127.0.0.1.`,
    );
    expect(JSON.stringify(t).replace("never 127.0.0.1", "")).not.toMatch(
      LOOPBACK,
    );
  });

  it("web.url unset: no links, and the note names Settings", async () => {
    const r = await started(null);
    const t = await agentTools(resolveAgentsDeps(r.deps), "planner", "north");
    expect(t.webUrl).toBeNull();
    expect(t.links).toBeUndefined();
    expect(t.address).toMatch(/not set/);
    expect(t.address).toMatch(
      /Settings › Server \(\/settings#server\.address\)/,
    );
    expect(JSON.stringify(t)).not.toMatch(/https?:\/\//);
  });

  it("the MCP whoami passes them through as the web server says them", async () => {
    const r = await started(ADDRESS);
    const view = await agentTools(
      resolveAgentsDeps(r.deps),
      "planner",
      "north",
    );
    const api: DenApi = {
      baseUrl: "http://localhost:4100",
      async get(path) {
        if (path === "/api/workspaces")
          return { active: ["north"], workspaces: { north: {} } };
        if (path === "/api/workspaces/north/agents/planner/tools") return view;
        throw new Error(`not faked: ${path}`);
      },
      async stream() {
        throw new Error("no streams here");
      },
    };
    const out = (await callTool(
      "whoami",
      {},
      {
        api,
        cfg: {
          actions: [],
          runTestsEnvs: ["local"],
          logsRemote: false,
          approvals: true,
        },
        cli: "acme",
        scope: { workspace: "north", actor: "agent:planner" },
      },
    )) as unknown;
    expect(JSON.stringify(out)).toContain(`${ADDRESS}/p/north/agents/planner`);
  });
});

describe("issue 1016: the start brief carries the address line", () => {
  it("web.url set: one line with it, and no loopback address anywhere", async () => {
    const r = await started(ADDRESS);
    const brief = argAfter(r.made[0].args, "--append-system-prompt");
    expect(brief).toContain(
      `Den's address for people: ${ADDRESS}. Give full links, never 127.0.0.1.`,
    );
    // The line names 127.0.0.1 only to forbid it: no address on it.
    expect(brief.replace("never 127.0.0.1", "")).not.toMatch(LOOPBACK);
  });

  it("web.url unset: the line says so and names Settings, with no address", async () => {
    const r = await started(null);
    const brief = argAfter(r.made[0].args, "--append-system-prompt");
    expect(brief).toContain("Den's address for people is not set");
    expect(brief).toContain("/settings#server.address");
    expect(brief.replace("never 127.0.0.1", "")).not.toMatch(LOOPBACK);
  });
});

describe("issue 1016: a loopback web.url counts as unset", () => {
  for (const stored of ["http://127.0.0.1:4000", "http://localhost:4000"])
    it(`${stored}: no links in whoami, and the brief has the unset line`, async () => {
      const r = await started(stored);
      const t = await agentTools(resolveAgentsDeps(r.deps), "planner", "north");
      expect(t.webUrl).toBeNull();
      expect(t.links).toBeUndefined();
      expect(t.address).toMatch(/not set/);
      expect(JSON.stringify(t)).not.toMatch(/https?:\/\//);
      const brief = argAfter(r.made[0].args, "--append-system-prompt");
      expect(brief).toContain("Den's address for people is not set");
      expect(brief).not.toContain(stored);
    });
});

describe("issue 1016: whoami and the brief read web.url through agent-links", () => {
  const stored = (url: string) => () => ({ web: { url } });
  it("peopleWebUrl: a loopback web.url in user.yml is no address", () => {
    expect(peopleWebUrl(stored("http://127.0.0.1:4000"))).toBeNull();
    expect(peopleWebUrl(stored("http://localhost:4000"))).toBeNull();
    expect(peopleWebUrl(stored(ADDRESS))).toBe(ADDRESS);
  });

  it("the start brief, from user.yml's http://127.0.0.1:4000: the unset line, no loopback link", async () => {
    const r = await started(null);
    r.deps.webUrl = () => peopleWebUrl(stored("http://127.0.0.1:4000"));
    expect(
      await cmdAgents(
        ["start", "-w", "north", "--persona", "planner", "--name", "two"],
        r.deps,
      ),
    ).toBe(0);
    const brief = argAfter(r.made[1].args, "--append-system-prompt");
    expect(brief).toContain("Den's address for people is not set");
    expect(brief).not.toContain("127.0.0.1:4000");
  });

  it("agent-ops never reads web.url but through agent-links (its default is peopleWebUrl)", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/ui/cli/agent-ops.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/readWebUrl/);
    expect(src).toContain("webUrl: d.webUrl ?? (() => peopleWebUrl())");
  });
});
