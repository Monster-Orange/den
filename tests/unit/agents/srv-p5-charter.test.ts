/**
 * SRV-P5 (0.4.48): Den's own agent's charter (server-pack/server.md) says
 * it works alongside the person, and lists its tools. Every tool Den
 * registers is in its "Your tools" list; no tool it names anywhere is one
 * Den doesn't register (a charter once said "call doctor": there is no
 * such tool).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { MCP_ACTIONS } from "../../../src/shared/den-config.js";
import { toolsFor } from "../../../src/ui/mcp/tools.js";

const CHARTER = path.join(
  __dirname,
  "../../../src/shared/agents/server-pack/server.md",
);
const text = fs.readFileSync(CHARTER, "utf-8");
const body = text.replace(/^---[\s\S]*?\n---\n/, "");

/** Every tool Den can register: reads, held writes, and each action. */
const registered = new Set(
  toolsFor({ approvals: true, actions: [...MCP_ACTIONS] } as never).map(
    (t) => t.name,
  ),
);

/** Settings and file names the charter may name: not tools. */
const NOT_TOOLS = new Set([
  "server_agent",
  "self_update",
  "update_check_minutes",
]);

function section(title: string): string {
  const at = body.indexOf(`\n## ${title}\n`);
  if (at < 0) return "";
  const rest = body.slice(at + title.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("SRV-P5: the charter lists the tools", () => {
  it("says it works alongside the person", () => {
    expect(body).toMatch(/alongside the person/);
  });

  it("every tool Den registers is in its Your tools list", () => {
    const listed = new Set(
      [...section("Your tools").matchAll(/`([a-z][a-z0-9_]*)`/g)].map(
        (m) => m[1],
      ),
    );
    const missing = [...registered].filter((t) => !listed.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it("its read-first context names only Den's tools", () => {
    const ctx = /^context: \[(.*)\]$/m.exec(text)?.[1] ?? "";
    const items = ctx.split(",").map((x) => x.trim());
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter((x) => !registered.has(x))).toEqual([]);
  });

  it("names no tool Den doesn't register", () => {
    const named = new Set<string>();
    // snake_case words (not a setting's key after a dot)
    for (const m of body.matchAll(/(?<![.\w])([a-z]+(?:_[a-z0-9]+)+)\b/g))
      if (!NOT_TOOLS.has(m[1])) named.add(m[1]);
    // "call X": the word after it is a tool.
    for (const m of body.matchAll(/\bcall\s+`?([a-z]+)`?\b/g))
      if (!["it", "the", "a", "an", "one", "its"].includes(m[1]))
        named.add(m[1]);
    const unknown = [...named].filter((t) => !registered.has(t)).sort();
    expect(unknown).toEqual([]);
  });
});

/**
 * Vision 11-14: a refusal told agents "agents use MCP agent_spawn", a tool
 * that never was. Every tool Den's own text names after MCP, call or tool
 * (errors, refusals, descriptions, and the comments beside them) is one
 * Den registers, or another server's that Den's text names on purpose.
 */
describe("Den's text names only tools that exist", () => {
  /** Other servers' tools Den's text names on purpose (Hub, Playwright). */
  const ELSEWHERE = new Set([
    "hub_inbox",
    "hub_artifact_update",
    "browser_snapshot",
  ]);
  const SRC = path.join(__dirname, "../../../src");
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
      return /\.(ts|js|md)$/.test(e.name) ? [p] : [];
    });
  }

  it("no made-up tool after MCP, call or tool", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const text = fs.readFileSync(f, "utf-8");
      for (const m of text.matchAll(
        /\b(?:MCP|[Cc]all|tool)\s+`?([a-z][a-z0-9]*_[a-z0-9_]+)\b(?![.(])/g,
      ))
        if (!registered.has(m[1]) && !ELSEWHERE.has(m[1]))
          bad.push(`${path.relative(SRC, f)}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
