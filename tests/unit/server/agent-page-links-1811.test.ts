import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  agentLinks,
  agentPagePath,
  allowPath,
} from "../../../src/shared/agent-links.js";
import { agentLink } from "../../../src/shared/alerts.js";
import {
  SERVER_AGENT_ID,
  SERVER_SCOPE,
} from "../../../src/shared/agents/server-agent.js";

const SRC = path.resolve(__dirname, "../../../src");
const HELPER = path.join(SRC, "shared", "agent-links.ts");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(ts|mts|js|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts"))
      out.push(p);
  }
  return out;
}

describe("issue 1811: one helper writes every link to an agent's page", () => {
  it("a project agent's page is /agents with its project and id", () => {
    expect(agentPagePath("north", "planner")).toBe(
      "/agents?project=north&agent=planner",
    );
    expect(agentPagePath("north", undefined)).toBe("/agents?project=north");
    expect(agentPagePath("", "planner")).toBe("/agents");
  });

  it("the server agent's page is /server-agent, never its reserved scope", () => {
    expect(agentPagePath(SERVER_SCOPE, SERVER_AGENT_ID)).toBe("/server-agent");
    expect(agentLink(SERVER_SCOPE, SERVER_AGENT_ID)).toBe("/server-agent");
    expect(allowPath(SERVER_AGENT_ID, SERVER_SCOPE)).toBe("/server-agent");
  });

  it("the server agent's whoami links never name its reserved scope", () => {
    const l = agentLinks("https://den.example.test", SERVER_SCOPE, "server");
    expect(l?.agent).toBe("https://den.example.test/server-agent");
    expect(l?.allow).toBe("https://den.example.test/server-agent");
    expect(JSON.stringify(l)).not.toContain(SERVER_SCOPE);
  });

  it("the alert link and the Allow link for a project agent are unchanged", () => {
    expect(agentLink("north", "planner")).toBe(
      "/agents?project=north&agent=planner",
    );
    expect(allowPath("planner", "north")).toBe(
      "/agents?project=north&agent=planner",
    );
    expect(allowPath("planner", undefined)).toBe("/agents?agent=planner");
    expect(allowPath(undefined, "north")).toBe("/agents");
  });

  it("no source writes an agent page link by hand outside the helper", () => {
    const hand = /\/agents\?project=\$\{[^}]+\}&agent=/;
    const found = sources(SRC)
      .filter((f) => f !== HELPER)
      .flatMap((f) =>
        fs
          .readFileSync(f, "utf-8")
          .split("\n")
          .map((line, i) => ({ f, i, line }))
          .filter((x) => hand.test(x.line))
          .map((x) => `${path.relative(SRC, x.f)}:${x.i + 1}`),
      );
    expect(found).toEqual([]);
  });
});
