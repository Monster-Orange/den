/**
 * Consumer findings on 0.3.0-dev.7, around broken plugins/<id>/ dirs:
 * A  a dir name that is not an id says the real rule (2–40 characters), and
 *    a missing manifest is reported too;
 * B  `plugin validate <id>` / `theme validate <id>` mean plugins/<id>/;
 * C  `plugin list` prints exactly one row per directory, every time;
 * D  a dir with no manifest "isn't a plugin" (not "not valid");
 * E  `theme list` stays 0 but points at plugin dirs that have errors.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdPlugin } from "../../../src/ui/cli/plugin-command.js";
import { cmdTheme } from "../../../src/ui/cli/theme-command.js";

const ROOT = path.resolve(__dirname, "../../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "plugins");
const ID_RULE =
  "2–40 characters: lowercase letters, digits or dashes, starting with a letter";
const NO_MANIFEST =
  "no den-plugin.json or den-theme.json, so it isn't a plugin";

let tmp: string;
const lines: string[] = [];
const log = (l: string) => lines.push(l);
const out = () => lines.join("\n");
const savedEngine = process.env.DEN_ENGINE_ROOT;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-find-")));
  process.env.DEN_ENGINE_ROOT = ROOT;
});
afterAll(() => {
  if (savedEngine === undefined) delete process.env.DEN_ENGINE_ROOT;
  else process.env.DEN_ENGINE_ROOT = savedEngine;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** local-dist (runbook, signal) plus plugins/x/ and plugins/scratch/. */
function brokenDist(name: string): string {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(FIXTURES, "local-dist"), d, { recursive: true });
  fs.mkdirSync(path.join(d, "plugins", "x"));
  fs.mkdirSync(path.join(d, "plugins", "scratch"));
  fs.writeFileSync(path.join(d, "plugins", "scratch", "notes.txt"), "wip\n");
  return d;
}

const row = (id: string) =>
  lines.filter((l) => new RegExp(`^ {2}${id} `).test(l));

/** Every directory (or symlink to one) under plugins/. */
const dirsIn = (d: string) =>
  fs
    .readdirSync(path.join(d, "plugins"), { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name[0] !== ".")
    .map((e) => e.name);

describe("A: a dir name that is not an id", () => {
  it("states the real rule, and says there is no manifest too", async () => {
    const d = brokenDist("a");
    lines.length = 0;
    expect(await cmdPlugin(["list"], { distRoot: d, log })).toBe(1);
    const [x] = row("x");
    expect(x).toContain(`not a plugin id, which is ${ID_RULE}`);
    expect(x).toContain(NO_MANIFEST);
    expect(out()).not.toMatch(/lowercase letters, digits and dashes/);
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: d, log })).toBe(1);
    const at = lines.findIndex((l) => /✗ x \(/.test(l));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.slice(at + 1, at + 3).join("\n")).toContain(ID_RULE);
    expect(lines.slice(at + 1, at + 3).join("\n")).toContain(NO_MANIFEST);
  });
});

describe("B: validate <id> is plugins/<id>/", () => {
  it("resolves an id before treating the argument as a path", async () => {
    const d = brokenDist("b");
    // The cwd (the repo) has no ./runbook or ./signal.
    expect(fs.existsSync(path.resolve("runbook"))).toBe(false);
    lines.length = 0;
    expect(await cmdPlugin(["validate", "runbook"], { distRoot: d, log })).toBe(
      0,
    );
    expect(out()).toMatch(/✓ runbook .*: Team runbook 1\.0\.0/);
    lines.length = 0;
    expect(await cmdTheme(["validate", "signal"], { distRoot: d, log })).toBe(
      0,
    );
    expect(out()).toMatch(/✓ signal .*: Signal 1\.0\.1/);
    // A broken one is reported as that plugin, not as a missing path.
    lines.length = 0;
    expect(await cmdPlugin(["validate", "scratch"], { distRoot: d, log })).toBe(
      1,
    );
    expect(out()).toMatch(/✗ scratch \(/);
    expect(out()).not.toMatch(/\(or in its themes/);
    // A bare name that is not an id is plugins/<name>/ when no such path
    // exists, so the id error is what it reports.
    lines.length = 0;
    expect(await cmdPlugin(["validate", "x"], { distRoot: d, log })).toBe(1);
    expect(out()).toMatch(/✗ x \(/);
    expect(out()).toContain(ID_RULE);
    // theme validate <id> of a plugin that is not a theme: one ✗, no ✓.
    lines.length = 0;
    expect(await cmdTheme(["validate", "runbook"], { distRoot: d, log })).toBe(
      1,
    );
    expect(out()).not.toMatch(/✓/);
    expect(out()).toMatch(/provides page, not a theme/);
    // A path still works.
    lines.length = 0;
    expect(
      await cmdPlugin(["validate", path.join(d, "plugins", "runbook")], {
        distRoot: d,
        log,
      }),
    ).toBe(0);
  });
});

describe("C: one row per directory, every time", () => {
  it("with an empty dir, a symlink and a lock key that is not its id", async () => {
    const d = brokenDist("c");
    fs.symlinkSync(
      path.join(d, "plugins", "signal"),
      path.join(d, "plugins", "linked"),
    );
    fs.mkdirSync(path.join(d, "plugins", "misfiled"));
    fs.writeFileSync(
      path.join(d, "plugins.lock.json"),
      JSON.stringify({
        plugins: {
          misfiled: {
            id: "other",
            name: "Other",
            version: "1.0.0",
            source: "https://git.example/acme/p.git",
            ref: "v1",
            commit: "0".repeat(40),
            sha256: "0".repeat(64),
            kinds: ["page"],
            approved_capabilities: [],
          },
        },
      }),
    );
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      lines.length = 0;
      expect(await cmdPlugin(["list"], { distRoot: d, log })).toBe(1);
      for (const name of dirsIn(d)) expect(row(name)).toHaveLength(1);
      runs.push(out());
    }
    expect(new Set(runs).size).toBe(1);
    expect(row("linked")[0]).toMatch(/symlink/);
    expect(row("misfiled")[0]).toMatch(/its id is "other"/);
  });

  it("when plugins.lock.json cannot be read", async () => {
    const d = brokenDist("c-lock");
    fs.writeFileSync(path.join(d, "plugins.lock.json"), "{");
    lines.length = 0;
    expect(await cmdPlugin(["list"], { distRoot: d, log })).toBe(1);
    for (const name of dirsIn(d)) expect(row(name)).toHaveLength(1);
    expect(out()).toMatch(/plugins\.lock\.json could not be read/);
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: d, log })).toBe(1);
    expect(out()).toMatch(/plugins\.lock\.json could not be read/);
    expect(out()).toMatch(/✓ runbook/);
  });
});

describe("D: a dir with no manifest isn't a plugin", () => {
  it("says so, and keeps 'not valid' for a real validation failure", async () => {
    const d = brokenDist("d");
    fs.mkdirSync(path.join(d, "plugins", "half"));
    fs.writeFileSync(path.join(d, "plugins", "half", "den-plugin.json"), "{}");
    lines.length = 0;
    await cmdPlugin(["list"], { distRoot: d, log });
    expect(row("scratch")[0]).toContain(
      `local (plugins/scratch): ${NO_MANIFEST}`,
    );
    expect(row("scratch")[0]).not.toMatch(/not valid under this/);
    expect(row("half")[0]).toMatch(
      /local \(plugins\/half\), not valid under this \S+: /,
    );
  });
});

describe("E: theme list points at plugin dirs with errors", () => {
  it("one line with the count; still exit 0", async () => {
    const d = brokenDist("e");
    lines.length = 0;
    expect(await cmdTheme(["list"], { distRoot: d, log })).toBe(0);
    expect(out()).toMatch(/signal\s+1\.0\.1\s+local/);
    expect(lines.filter((l) => /plugin dir\(s\) have errors/.test(l))).toEqual([
      expect.stringMatching(
        /^ {2}2 plugin dir\(s\) have errors: run `\S+ plugin list`$/,
      ),
    ]);
  });

  it("says nothing when every plugin dir is fine", async () => {
    lines.length = 0;
    expect(
      await cmdTheme(["list"], {
        distRoot: path.join(FIXTURES, "local-dist"),
        log,
      }),
    ).toBe(0);
    expect(out()).not.toMatch(/have errors/);
  });
});
