/**
 * Every busyAction name a Den page uses is one busy-den.js lists. The kit
 * throws on a name it doesn't know ("busyAction: no action named"), so the
 * button's write never runs: the bell's Allow and Deny did that from issue
 * 746 until this test.
 *
 * A literal name is checked as it is. A name built from a template, or
 * passed in a variable, must be listed below with every name it can be;
 * an unlisted one fails, so a new call can't slip past.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/**
 * "file first-argument" → how many such calls there are, and the names
 * they can be. `pass` marks a wrapper that hands its caller's name on (the
 * caller's own call is what's checked).
 */
const NOT_LITERAL: Record<
  string,
  { calls: number; names?: string[]; pass?: string }
> = {
  "bell.js `decide-${decision}`": {
    calls: 1,
    names: ["decide-allow", "decide-deny"],
  },
  "address-card.js name": {
    calls: 1,
    names: ["check-edge-address", "edge-take-over"],
  },
  "settings-registry.js name": {
    calls: 1,
    names: ["push-test", "push-forget"],
  },
  "settings-registry.js kind": {
    calls: 3,
    names: ["save", "follow-project", "remove-mcp", "add-feed", "remove-feed"],
  },
  "coach-tab.js name": {
    calls: 1,
    names: ["coach-dismiss", "coach-apply", "coach-undismiss", "coach-counts"],
  },
  "shell.js name": {
    calls: 2,
    pass: "denShell.busyAction and holdDots hand the page's name to the kit",
  },
  "agents-page.js ...a)": {
    calls: 1,
    pass: "a context's busyAction is window.denShell.busyAction",
  },
};

function registered(): Set<string> {
  const src = fs.readFileSync(path.join(PUBLIC, "busy-den.js"), "utf-8");
  return new Set(
    [...src.matchAll(/^ {2}"?([a-z0-9-]+)"?: \{/gm)].map((m) => m[1]!),
  );
}

interface Use {
  file: string;
  line: number;
  name: string;
}

/** Each name a page hands busyAction, and each unlisted call. */
function scan(): { used: Use[]; unlisted: string[] } {
  const used: Use[] = [];
  const counts = new Map<string, number>();
  for (const f of fs.readdirSync(PUBLIC).sort()) {
    if (!/\.(js|html)$/.test(f) || f === "busy-den.js") continue;
    const src = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
    for (const m of src.matchAll(/\bbusyAction\(\s*([^\s,]+)\s*,/g)) {
      const arg = m[1]!;
      const line = src.slice(0, m.index).split("\n").length;
      const lit = /^(["'])([^"']+)\1$/.exec(arg) ?? /^`([^`$]+)`$/.exec(arg);
      if (lit) {
        used.push({ file: f, line, name: lit[2] ?? lit[1]! });
        continue;
      }
      const key = `${f} ${arg}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      for (const name of NOT_LITERAL[key]?.names ?? [])
        used.push({ file: f, line, name });
    }
  }
  const unlisted: string[] = [];
  for (const [key, n] of counts) {
    const want = NOT_LITERAL[key];
    if (!want) unlisted.push(`${key} (not listed)`);
    else if (want.calls !== n)
      unlisted.push(`${key} (${n} calls, ${want.calls} listed)`);
  }
  for (const key of Object.keys(NOT_LITERAL))
    if (!counts.has(key)) unlisted.push(`${key} (listed, but no such call)`);
  return { used, unlisted };
}

describe("busyAction names", () => {
  it("finds literal, built and passed-in names (the bell's Allow and Deny among them)", () => {
    const names = scan().used.map((u) => u.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "decide-allow",
        "decide-deny",
        "gate-end",
        "push-test",
        "check-edge-address",
      ]),
    );
  });

  it("every call that isn't a literal is listed, with its count", () => {
    expect(scan().unlisted).toEqual([]);
  });

  it("each listed name is spelled in its file, so the list can't go stale", () => {
    const stale: string[] = [];
    for (const [key, v] of Object.entries(NOT_LITERAL)) {
      const file = key.split(" ")[0]!;
      const src = fs.readFileSync(path.join(PUBLIC, file), "utf-8");
      for (const n of v.names ?? []) {
        const spelled = n.startsWith("decide-")
          ? src.includes("`decide-${")
          : src.includes(`"${n}"`);
        if (!spelled) stale.push(`${file} ${n}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("every name a page uses is listed in busy-den.js", () => {
    const have = registered();
    const missing = scan()
      .used.filter((u) => !have.has(u.name))
      .map((u) => `${u.file}:${u.line} ${u.name}`);
    expect(missing).toEqual([]);
  });
});
