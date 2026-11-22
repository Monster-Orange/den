/**
 * Issue 770, clauses 7 and 9: each shipped runtime points to its screen
 * rule set (catalog.ts `screenRules`), and every file under
 * src/shared/agents/detect lifted from herdr carries its Apache-2.0
 * attribution and is listed in THIRD_PARTY_NOTICES.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  BUILTIN_CATALOG,
  validateCatalog,
} from "../../../src/shared/agents/catalog.js";
import { RULE_SETS } from "../../../src/shared/agents/detect/index.js";

const ROOT = process.cwd();
const DETECT = path.join(ROOT, "src", "shared", "agents", "detect");

describe("clause 7: runtimes point to their rule sets", () => {
  it("every shipped runtime but the generic one names a rule set Den ships", () => {
    const missing = BUILTIN_CATALOG.filter(
      (e) => !e.screenRules || !RULE_SETS[e.screenRules],
    ).map((e) => e.id);
    expect(missing).toEqual([]);
    expect(
      Object.fromEntries(BUILTIN_CATALOG.map((e) => [e.id, e.screenRules])),
    ).toEqual({
      "den-claude": "claude",
      codex: "codex",
      gemini: "gemini",
      grok: "grok",
    });
  });

  it("a configured entry may name one; a name Den doesn't ship is refused", () => {
    const entry = (screenRules: unknown) => ({
      id: "acme-cli",
      vendor: "Acme",
      name: "Acme CLI",
      bins: ["acme"],
      version: { args: ["--version"], identity: { output: "acme" } },
      dirs: ["{system}"],
      launch: { argv: ["{bin}"] },
      screenRules,
    });
    expect(
      validateCatalog([entry("codex")], "agents.runtimes")[0]?.screenRules,
    ).toBe("codex");
    expect(() => validateCatalog([entry("nope")], "agents.runtimes")).toThrow(
      /screenRules/,
    );
  });
});

/** Files under detect/ that say they came from herdr, and from where. */
function herdrFiles(dir = DETECT): [string, string][] {
  const out: [string, string][] = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...herdrFiles(p));
    else {
      const m = /herdr-origin: (\S+)/.exec(fs.readFileSync(p, "utf8"));
      if (m) out.push([path.relative(ROOT, p), m[1]]);
    }
  }
  return out.sort();
}

describe("clause 9: herdr's Apache-2.0 attribution", () => {
  const notices = () =>
    fs.readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES"), "utf8");

  it("the rule sets and the engine say they came from herdr", () => {
    expect(
      herdrFiles()
        .map(([f]) => path.basename(f))
        .sort(),
    ).toEqual(["claude.ts", "codex.ts", "engine.ts", "gemini.ts", "grok.ts"]);
  });

  it("each such file has a copyright line, the license and 'Modified by Den'", () => {
    for (const [f] of herdrFiles()) {
      // The header comment as running text: its line breaks are spaces.
      const head = fs
        .readFileSync(path.join(ROOT, f), "utf8")
        .slice(0, 1500)
        .replace(/\s*\n\s*\*\s*/g, " ");
      expect([f, /Copyright \d{4} the herdr authors/.test(head)]).toEqual([
        f,
        true,
      ]);
      expect([f, head.includes("Apache License, Version 2.0")]).toEqual([
        f,
        true,
      ]);
      expect([f, head.includes("Modified by Den")]).toEqual([f, true]);
    }
  });

  it("THIRD_PARTY_NOTICES lists herdr, its license and each lifted file", () => {
    const n = notices();
    expect(n).toContain("herdr");
    expect(n).toContain("Apache License");
    expect(n).toContain("https://github.com/herdrdev/herdr");
    for (const [f, origin] of herdrFiles()) {
      expect([f, n.includes(f)]).toEqual([f, true]);
      expect([origin, n.includes(origin)]).toEqual([origin, true]);
    }
  });

  it("the notices ship in the package", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("THIRD_PARTY_NOTICES");
  });
});
