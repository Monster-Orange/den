/**
 * The Start agent form's readiness line (public/agent-start.js, AG-0.2):
 * a bad agents.runtimes.<id>.bin says the setting's own reason, never
 * "not found. Searched: no directories" (a 0.4.3 candidate finding).
 */
import { describe, expect, it } from "@jest/globals";
import { readiness } from "../../../src/ui/server/public/agent-start.js";
/** Echoes the key and its values: what was said, not how. */
const t = (key: string, vars?: Record<string, unknown>) =>
  [key, ...Object.values(vars ?? {}).map(String)].join(" ");
const text = (html: string) => html.replace(/<[^>]+>/g, "");

const data = (rt: Record<string, unknown>) => ({
  personas: [{ id: "planner", role: "Plans." }],
  runtimes: [
    {
      id: "den-claude",
      label: "Claude Code",
      default: true,
      setting: "agents.runtimes.den-claude.bin",
      ...rt,
    },
  ],
  userConfig: "/home/u/dist/config/local/user.yml",
});

describe("readiness: why a runtime can't start", () => {
  it("a bad configured bin: the setting's reason, not a search", () => {
    const r = readiness(
      data({
        available: false,
        source: "setting",
        searched: [],
        why: "agents.runtimes.den-claude.bin: /nonexistent/claude does not exist",
      }),
      "planner",
      "",
      t,
    );
    expect(r.ok).toBe(false);
    expect(text(r.html)).toContain(
      "agents.runtimes.den-claude.bin: /nonexistent/claude does not exist",
    );
    expect(text(r.html)).toContain("ag.rt.refused");
    expect(text(r.html)).not.toMatch(/ag\.rt\.(notFound|nowhere|searched)/);
  });

  it("not found by the search: names where it looked", () => {
    const r = readiness(
      data({
        available: false,
        searched: ["/usr/bin", "/bin"],
        why: "claude not found (searched 2 directories)",
      }),
      "planner",
      "",
      t,
    );
    expect(r.ok).toBe(false);
    expect(text(r.html)).toMatch(/ag\.rt\.notFound Claude Code.*\/usr\/bin/);
  });
});
