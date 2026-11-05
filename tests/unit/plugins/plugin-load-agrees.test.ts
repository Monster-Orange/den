/**
 * 0.3.0-dev.9 follow-ups:
 * a  what fails `validate` never loads: the theme runtime's verdict is
 *    validate's, plugin rules (author, maintainer, range) included;
 * b  `theme list`'s footer counts every broken dir, in good English;
 * c  a range a prerelease Den misses only for being a prerelease says how to
 *    write it (-0);
 * d  validate's no-manifest line is list's; list's id column fits the ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { denRangeIssue } from "../../../src/shared/theme/contract.js";
import {
  PLUGIN_NOT_A_PLUGIN,
  validatePluginDir,
} from "../../../src/shared/plugins/manifest.js";
import { cmdPlugin } from "../../../src/ui/cli/plugin-command.js";
import { cmdTheme } from "../../../src/ui/cli/theme-command.js";
import {
  listThemes,
  resetThemeWarnings,
  resolveActiveTheme,
} from "../../../src/ui/server/theme-runtime.js";

const ROOT = path.resolve(__dirname, "../../..");
const DEN_THEME = path.join(ROOT, "themes", "den");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "plugins");
let tmp: string;
const lines: string[] = [];
const log = (l: string) => lines.push(l);
const out = () => lines.join("\n");
const savedEngine = process.env.DEN_ENGINE_ROOT;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-agree-")));
  process.env.DEN_ENGINE_ROOT = ROOT;
});
afterAll(() => {
  if (savedEngine === undefined) delete process.env.DEN_ENGINE_ROOT;
  else process.env.DEN_ENGINE_ROOT = savedEngine;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Patch = Record<string, unknown>;
const patched = (file: string, patch: Patch) => {
  const m = JSON.parse(fs.readFileSync(file, "utf-8")) as Patch;
  for (const [k, v] of Object.entries(patch))
    if (v === undefined) delete m[k];
    else m[k] = v;
  fs.writeFileSync(file, JSON.stringify(m));
};

/** plugins/<id>/ as a bare den-theme.json (den's), patched. */
function bareTheme(distRoot: string, id: string, patch: Patch = {}): void {
  const dir = path.join(distRoot, "plugins", id);
  fs.cpSync(DEN_THEME, dir, { recursive: true });
  patched(path.join(dir, "den-theme.json"), { id, name: id, ...patch });
}

/** plugins/<id>/ as a den-plugin.json that provides den's theme, patched. */
function pluginTheme(distRoot: string, id: string, patch: Patch = {}): void {
  const dir = path.join(distRoot, "plugins", id);
  fs.cpSync(DEN_THEME, path.join(dir, "theme"), { recursive: true });
  patched(path.join(dir, "theme", "den-theme.json"), { id, name: id });
  fs.writeFileSync(
    path.join(dir, "den-plugin.json"),
    JSON.stringify({
      schema: "den.plugin/v1",
      id,
      name: id,
      version: "1.0.0",
      license: "MIT",
      den: ">=0.3.0-0 <0.4.0",
      maintainer: "design",
      provides: [{ kind: "theme", manifest: "theme/den-theme.json" }],
    }),
  );
  patched(path.join(dir, "den-plugin.json"), patch);
}

describe("a: the runtime's verdict is validate's", () => {
  const d = () => path.join(tmp, "agree");
  beforeAll(() => {
    fs.mkdirSync(d());
    bareTheme(d(), "fine");
    bareTheme(d(), "no-author", { author: undefined });
    bareTheme(d(), "blank-author", { author: "  " });
    bareTheme(d(), "future", { den: ">=99.0.0" });
    pluginTheme(d(), "plugin-fine");
    pluginTheme(d(), "plugin-no-maintainer", { maintainer: undefined });
    pluginTheme(d(), "plugin-future", { den: ">=99.0.0" });
    pluginTheme(d(), "plugin-bad-cap", { capabilities: ["root"] });
  });

  it("every theme loads exactly when validate passes it", () => {
    const roots = { distRoot: d(), engineRoot: ROOT };
    const verdicts = listThemes(roots)
      .filter((t) => t.source !== "built-in")
      .map((t) => [
        t.id,
        t.ok,
        validatePluginDir(path.join(d(), "plugins", t.id), { expectId: t.id })
          .ok,
      ]);
    expect(verdicts.map(([id, ok]) => [id, ok])).toEqual([
      ["blank-author", false],
      ["fine", true],
      ["future", false],
      ["no-author", false],
      ["plugin-bad-cap", false],
      ["plugin-fine", true],
      ["plugin-future", false],
      ["plugin-no-maintainer", false],
    ]);
    for (const [id, load, validate] of verdicts)
      expect({ id, load }).toEqual({ id, load: validate });
  });

  it("one that fails falls through user → brand.theme → den, one notice", () => {
    const roots = { distRoot: d(), engineRoot: ROOT };
    for (const bad of ["no-author", "plugin-no-maintainer"]) {
      resetThemeWarnings();
      const w: string[] = [];
      const pick = (user: string | null, distribution: string | null) =>
        resolveActiveTheme(roots, { user, distribution }, (l) => w.push(l));
      expect(pick(bad, "fine")).toMatchObject({
        id: "fine",
        chosenBy: "distribution",
      });
      expect(pick(bad, bad)).toMatchObject({ id: "den", chosenBy: "default" });
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(new RegExp(`"${bad}".*not valid under this Den`));
    }
  });
});

describe("b: theme list counts every broken plugin dir", () => {
  const dist = (name: string) => {
    const d = path.join(tmp, name);
    fs.cpSync(path.join(FIXTURES, "local-dist"), d, { recursive: true });
    return d;
  };
  const footer = () =>
    lines.filter((l) => /plugin dirs? ha(s|ve) errors/.test(l));

  it("shown or not, and plural only when it is", async () => {
    const d = dist("count-4");
    bareTheme(d, "no-author", { author: undefined }); // shown inline
    bareTheme(d, "future", { den: ">=99.0.0" }); // shown inline
    fs.mkdirSync(path.join(d, "plugins", "x")); // not a theme
    fs.mkdirSync(path.join(d, "plugins", "scratch")); // not a theme
    lines.length = 0;
    await cmdTheme(["list"], { distRoot: d, log });
    expect(footer()).toEqual([
      expect.stringMatching(
        /^ {2}4 plugin dirs have errors: run `\S+ plugin list`$/,
      ),
    ]);
    const one = dist("count-1");
    fs.mkdirSync(path.join(one, "plugins", "scratch"));
    lines.length = 0;
    await cmdTheme(["list"], { distRoot: one, log });
    expect(footer()).toEqual([
      expect.stringMatching(
        /^ {2}1 plugin dir has errors: run `\S+ plugin list`$/,
      ),
    ]);
  });
});

describe("c: a prerelease Den and a range without -0", () => {
  it("hints at the -0 form, from the range's own lower bound", () => {
    expect(denRangeIssue(">=0.3.0", "0.3.0-dev.8")).toBe(
      "needs Den >=0.3.0; this is 0.3.0-dev.8 (prerelease builds need a -0 range, e.g. >=0.3.0-0)",
    );
    expect(denRangeIssue("^0.3.1 <0.4.0", "0.3.1-dev.2")).toMatch(
      /prerelease builds need a -0 range, e\.g\. >=0\.3\.1-0\)$/,
    );
  });

  it("gives no hint when the release would not match either", () => {
    expect(denRangeIssue(">=0.4.0", "0.3.0-dev.8")).toBe(
      "needs Den >=0.4.0; this is 0.3.0-dev.8",
    );
    expect(denRangeIssue(">=0.4.0", "0.3.0")).toBe(
      "needs Den >=0.4.0; this is 0.3.0",
    );
  });
});

describe("d: wording and alignment", () => {
  it("validate's no-manifest line is list's, from one constant", async () => {
    expect(PLUGIN_NOT_A_PLUGIN).toBe(
      "no den-plugin.json or den-theme.json, so it isn't a plugin",
    );
    const d = path.join(tmp, "wording");
    fs.mkdirSync(path.join(d, "plugins", "scratch"), { recursive: true });
    lines.length = 0;
    await cmdPlugin(["list"], { distRoot: d, log });
    expect(out()).toContain(`local (plugins/scratch): ${PLUGIN_NOT_A_PLUGIN}`);
    lines.length = 0;
    await cmdPlugin(["validate"], { distRoot: d, log });
    expect(lines).toContain(`    ${PLUGIN_NOT_A_PLUGIN}`);
    lines.length = 0;
    await cmdPlugin(["validate", "scratch"], { distRoot: d, log });
    expect(lines).toContain(`    ${PLUGIN_NOT_A_PLUGIN}`);
  });

  it("list sizes the id column to the longest id", async () => {
    const d = path.join(tmp, "wide");
    fs.cpSync(path.join(FIXTURES, "local-dist"), d, { recursive: true });
    const long = "a-theme-id-that-is-forty-characters-long";
    expect(long).toHaveLength(40);
    bareTheme(d, long);
    for (const cmd of [cmdPlugin, cmdTheme]) {
      lines.length = 0;
      await cmd(["list"], { distRoot: d, log });
      const rows = lines.filter((l) => /^ {2}[a-z]/.test(l));
      expect(rows.length).toBeGreaterThanOrEqual(3);
      // The version column starts at the same place on every row.
      const at = rows.map((r) => r.search(/\d+\.\d+\.\d+/));
      expect(new Set(at).size).toBe(1);
      expect(at[0]).toBeGreaterThan(2 + long.length);
    }
  });
});
