/**
 * PL-1a and PL-2a: `<cli> plugin list | validate | add | update | remove`.
 *
 * Every plugins/<id>/ is a plugin, local (no lock entry) or added (vendored
 * at an exact ref, pinned in plugins.lock.json), and needs a manifest. A
 * file:// source is refused; plugins.allow in den.yml limits where add may
 * fetch from.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdPlugin } from "../../../src/ui/cli/plugin-command.js";
import { cmdTheme } from "../../../src/ui/cli/theme-command.js";
import { readLock } from "../../../src/shared/plugins/store.js";
import { validatePluginDir } from "../../../src/shared/plugins/manifest.js";
import { listThemes } from "../../../src/ui/server/theme-runtime.js";

const ROOT = path.resolve(__dirname, "../../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "plugins");
const REMOTE = "https://git.example/acme/den-plugins.git";

let tmp: string;
let repo: string;
const lines: string[] = [];
const log = (l: string) => lines.push(l);
const out = () => lines.join("\n");
const savedEnv = { ...process.env };

const run = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();

function gitInit(dir: string): void {
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.email", "t@example.com");
  run(dir, "config", "user.name", "t");
  run(dir, "config", "commit.gpgsign", "false");
  run(dir, "config", "tag.gpgsign", "false");
}

/** A fresh distribution in tmp, optionally seeded from a fixture dist. */
function dist(name: string, from?: string): string {
  const d = path.join(tmp, name);
  if (from) fs.cpSync(path.join(FIXTURES, from), d, { recursive: true });
  else fs.mkdirSync(d, { recursive: true });
  return d;
}

const runbook = () =>
  JSON.parse(
    fs.readFileSync(
      path.join(
        FIXTURES,
        "local-dist",
        "plugins",
        "runbook",
        "den-plugin.json",
      ),
      "utf-8",
    ),
  ) as Record<string, unknown>;

/** A copy of the runbook fixture with its manifest changed. */
function runbookWith(dir: string, patch: Record<string, unknown>): string {
  fs.cpSync(path.join(FIXTURES, "local-dist", "plugins", "runbook"), dir, {
    recursive: true,
  });
  const m = { ...runbook(), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete m[k];
  fs.writeFileSync(path.join(dir, "den-plugin.json"), JSON.stringify(m));
  return dir;
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-plugin-")));
  process.env.DEN_ENGINE_ROOT = ROOT;
  // `add` refuses file://, so the test repo is reached at an https URL that
  // git rewrites to it.
  repo = path.join(tmp, "plugins-repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${repo}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = REMOTE;
  runbookWith(path.join(repo, "plugins", "runbook"), {});
  fs.cpSync(
    path.join(FIXTURES, "local-dist", "plugins", "signal"),
    path.join(repo, "themes", "signal"),
    { recursive: true },
  );
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "plugins");
  run(repo, "tag", "runbook/v1.0.0");
  run(repo, "tag", "signal/v1.0.1");
  // v1.1.0 asks for more.
  runbookWith(path.join(repo, "plugins", "runbook"), {
    version: "1.1.0",
    capabilities: ["ui.nav", "api.read", "net:status.example.com"],
  });
  run(repo, "commit", "-qam", "runbook 1.1.0");
  run(repo, "tag", "runbook/v1.1.0");
});

afterAll(() => {
  for (const k of [
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "DEN_ENGINE_ROOT",
  ])
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("PL-1a: local plugins of any kind list and validate", () => {
  const fixture = path.join(FIXTURES, "local-dist");

  it("lists a local theme and a local page plugin, each as local", async () => {
    lines.length = 0;
    expect(await cmdPlugin(["list"], { distRoot: fixture, log })).toBe(0);
    expect(out()).toMatch(/den\s+\S+\s+theme\s+built in/);
    expect(out()).toMatch(
      /runbook\s+1\.0\.0\s+page\s+local \(plugins\/runbook\)/,
    );
    expect(out()).toMatch(
      /signal\s+1\.0\.1\s+theme\s+local \(plugins\/signal\)/,
    );
  });

  it("validates both, and either dir on its own", async () => {
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: fixture, log })).toBe(0);
    expect(out()).toMatch(/✓ runbook .*: Team runbook 1\.0\.0/);
    expect(out()).toMatch(/✓ signal .*: Signal 1\.0\.1/);
    for (const id of ["runbook", "signal"])
      expect(
        await cmdPlugin(["validate", path.join(fixture, "plugins", id)], {
          log,
        }),
      ).toBe(0);
    expect(await cmdPlugin(["validate", fixture], { log })).toBe(0);
  });

  it("a plugins/<id>/ with no manifest is an error in list and validate", async () => {
    const d = path.join(FIXTURES, "no-manifest-dist");
    lines.length = 0;
    expect(await cmdPlugin(["list"], { distRoot: d, log })).toBe(1);
    expect(out()).toMatch(
      /stray .*local \(plugins\/stray\), .*no den-plugin\.json or den-theme\.json/,
    );
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: d, log })).toBe(1);
    expect(out()).toMatch(/✗ stray/);
    expect(out()).toMatch(/a plugin needs a manifest/);
  });

  it("theme list and validate still skip a local plugin that is not a theme", async () => {
    lines.length = 0;
    expect(await cmdTheme(["list"], { distRoot: fixture, log })).toBe(0);
    expect(out()).toMatch(/signal\s+1\.0\.1\s+local/);
    expect(out()).not.toMatch(/runbook/);
  });

  it("refuses the built-in id and a dir name that is not an id", async () => {
    const d = dist("odd-names", "local-dist");
    fs.cpSync(
      path.join(d, "plugins", "signal"),
      path.join(d, "plugins", "den"),
      {
        recursive: true,
      },
    );
    fs.mkdirSync(path.join(d, "plugins", "Not_An_Id"));
    lines.length = 0;
    expect(await cmdPlugin(["list"], { distRoot: d, log })).toBe(1);
    expect(out()).toMatch(
      /den .*local \(plugins\/den\), "den" is the built-in/,
    );
    expect(out()).toMatch(/Not_An_Id .*not a plugin id/);
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: d, log })).toBe(1);
    expect(out()).toMatch(/✗ den/);
  });
});

describe("PL-1a: den.plugin/v1 and admission rules 1-3", () => {
  const dir = (name: string) => path.join(tmp, "manifests", name);

  it("uses den.theme/v1's SPDX rule by reference, not a copy", () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "schemas", "den.plugin.v1.json"),
        "utf-8",
      ),
    ) as { properties: { license: { $ref: string } } };
    expect(schema.properties.license.$ref).toBe(
      "den.theme.v1.json#/$defs/spdx",
    );
    const v = validatePluginDir(
      runbookWith(dir("unlicensed"), { license: "UNLICENSED" }),
    );
    expect(v.ok).toBe(false);
    expect(v.issues).toContainEqual({
      at: "den-plugin.json#/license",
      message: expect.stringMatching(/SPDX expression/),
    });
  });

  it("rule 1: names a maintainer", () => {
    const v = validatePluginDir(
      runbookWith(dir("no-maintainer"), { maintainer: undefined }),
    );
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.message).join()).toMatch(/maintainer/);
  });

  it("rule 2: a page plugin's README says its tier and what it must never do", () => {
    const d = runbookWith(dir("readme"), {});
    fs.writeFileSync(path.join(d, "README.md"), "# Runbook\n\nA page.\n");
    let v = validatePluginDir(d);
    expect(v.ok).toBe(false);
    expect(v.issues).toContainEqual({
      at: "README.md",
      message: expect.stringMatching(
        /its tier \(browser\) or what it must never do/,
      ),
    });
    fs.rmSync(path.join(d, "README.md"));
    v = validatePluginDir(d);
    expect(v.issues[0]).toMatchObject({
      at: "README.md",
      message: expect.stringMatching(
        /^missing: a browser-tier plugin needs a README/,
      ),
    });
  });

  it("rule 2 exempts files-tier plugins: a den-plugin.json theme needs no README", () => {
    const d = dir("theme-plugin");
    fs.cpSync(
      path.join(FIXTURES, "local-dist", "plugins", "signal"),
      path.join(d, "theme"),
      { recursive: true },
    );
    const t = path.join(d, "theme", "den-theme.json");
    fs.writeFileSync(
      t,
      JSON.stringify({
        ...(JSON.parse(fs.readFileSync(t, "utf-8")) as object),
        id: "theme-plugin",
      }),
    );
    fs.writeFileSync(
      path.join(d, "den-plugin.json"),
      JSON.stringify({
        schema: "den.plugin/v1",
        id: "theme-plugin",
        name: "Theme plugin",
        version: "1.0.0",
        license: "MIT",
        den: ">=0.3.0",
        maintainer: "design",
        provides: [{ kind: "theme", manifest: "theme/den-theme.json" }],
      }),
    );
    const v = validatePluginDir(d, { expectId: "theme-plugin" });
    expect(v.issues).toEqual([]);
    expect(v.plugin).toMatchObject({
      kinds: ["theme"],
      capabilities: [],
      tier: "files",
      implicit: false,
    });
    // The nested theme is held to den.theme/v1: contrast, files, its id.
    const m = JSON.parse(fs.readFileSync(t, "utf-8")) as {
      modes: { light: Record<string, string> };
    };
    m.modes.light.muted = "#bbbbbb";
    fs.writeFileSync(t, JSON.stringify(m));
    expect(validatePluginDir(d).contrast.length).toBeGreaterThan(0);
  });

  it("rule 3 covers bundled fonts: the theme validator's rule", () => {
    const d = dir("fontless");
    fs.cpSync(path.join(FIXTURES, "local-dist", "plugins", "signal"), d, {
      recursive: true,
    });
    fs.rmSync(path.join(d, "fonts", "OFL.txt"));
    const v = validatePluginDir(d);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.message).join()).toMatch(
      /no OFL\.txt or LICENSE/,
    );
  });

  it("a dir with only den-theme.json is an implicit theme plugin", () => {
    const v = validatePluginDir(
      path.join(FIXTURES, "local-dist", "plugins", "signal"),
      { expectId: "signal" },
    );
    expect(v.ok).toBe(true);
    expect(v.plugin).toMatchObject({
      id: "signal",
      kinds: ["theme"],
      capabilities: [],
      tier: "files",
      implicit: true,
      manifestFile: "den-theme.json",
    });
  });

  it("the capability vocabulary is closed", () => {
    const v = validatePluginDir(
      runbookWith(dir("caps"), { capabilities: ["ui.nav", "root"] }),
    );
    expect(v.issues).toContainEqual({
      at: "den-plugin.json#/capabilities/1",
      message: expect.stringMatching(/^unknown capability: the vocabulary is/),
    });
    expect(
      validatePluginDir(
        runbookWith(dir("caps-ok"), {
          capabilities: [
            "ui.nav",
            "api.read",
            "api.actions:service.restart,service.up",
            "secrets:vault/item/field",
            "net:status.example.com,api.example.com:8443",
            "exec:git",
            "send:phone",
          ],
        }),
      ).issues,
    ).toEqual([]);
  });

  it("a page's entry must be in the plugin", () => {
    const v = validatePluginDir(
      runbookWith(dir("no-entry"), {
        provides: [{ kind: "page", entry: "page/missing.js" }],
      }),
    );
    expect(v.issues).toContainEqual({
      at: "den-plugin.json#/provides/0",
      message: "page/missing.js is missing",
    });
  });
});

describe("PL-1a: the git warning for a local plugin that acts", () => {
  it("warns on uncommitted files only when it declares an acting capability", async () => {
    const d = dist("git-dist", "local-dist");
    gitInit(d);
    const mf = path.join(d, "plugins", "runbook", "den-plugin.json");
    // Read-only (ui.nav, api.read) and untracked: no warning.
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: d, log })).toBe(0);
    expect(out()).not.toMatch(/WARNING/);
    // Acting and untracked: a warning, still a pass.
    fs.writeFileSync(
      mf,
      JSON.stringify({ ...runbook(), capabilities: ["ui.nav", "exec:git"] }),
    );
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: d, log })).toBe(0);
    expect(out()).toMatch(
      /WARNING plugins\/runbook\/ has files git has not committed .*declares exec:git/,
    );
    expect(out()).toMatch(/→ commit them/);
    expect(out()).not.toMatch(/WARNING plugins\/signal/);
    // Committed: no warning. Modified again: the warning is back.
    run(d, "add", "-A");
    run(d, "commit", "-qm", "dist");
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: d, log })).toBe(0);
    expect(out()).not.toMatch(/WARNING/);
    fs.appendFileSync(
      path.join(d, "plugins", "runbook", "page", "index.js"),
      "//\n",
    );
    lines.length = 0;
    expect(await cmdPlugin(["validate"], { distRoot: d, log })).toBe(0);
    expect(out()).toMatch(/WARNING plugins\/runbook\/ .*index\.js/);
  });
});

describe("PL-2a: plugin add, update, remove", () => {
  const add = (d: string, ...a: string[]) =>
    cmdPlugin(["add", ...a], { distRoot: d, log, tmpDir: tmp });

  it("refuses a file:// source with the hint, touching nothing", async () => {
    const d = dist("file-src");
    lines.length = 0;
    expect(await add(d, `file://${repo}//plugins/runbook@runbook/v1.0.0`)).toBe(
      1,
    );
    expect(out()).toMatch(
      /is a path on this machine: for your own plugin, put it in plugins\/<id>\/ as a local plugin; to try a published one before tagging, push a branch and use --track/,
    );
    expect(fs.existsSync(path.join(d, "plugins"))).toBe(false);
    expect(fs.existsSync(path.join(d, "plugins.lock.json"))).toBe(false);
  });

  it("adds a page plugin: kinds and approved capabilities from its manifest", async () => {
    const d = dist("added");
    const spec = `${REMOTE}//plugins/runbook@runbook/v1.0.0`;
    lines.length = 0;
    expect(await add(d, spec)).toBe(1);
    expect(out()).toMatch(
      /runbook asks for ui\.nav, api\.read: run again with --yes/,
    );
    expect(fs.existsSync(path.join(d, "plugins", "runbook"))).toBe(false);
    lines.length = 0;
    expect(await add(d, spec, "--yes")).toBe(0);
    expect(readLock(d).runbook).toMatchObject({
      id: "runbook",
      name: "Team runbook",
      version: "1.0.0",
      source: `${REMOTE}//plugins/runbook`,
      ref: "runbook/v1.0.0",
      kinds: ["page"],
      approved_capabilities: ["ui.nav", "api.read"],
    });
    expect(
      fs
        .readdirSync(path.join(d, "plugins", "runbook"), { recursive: true })
        .map(String)
        .sort(),
    ).toEqual([
      "README.md",
      "den-plugin.json",
      "fixtures",
      "fixtures/smoke.json",
      "page",
      "page/index.js",
    ]);
    lines.length = 0;
    expect(await cmdPlugin(["list"], { distRoot: d, log })).toBe(0);
    expect(out()).toMatch(
      /runbook\s+1\.0\.0\s+page\s+https:\/\/git\.example\/acme\/den-plugins\.git\/\/plugins\/runbook@runbook\/v1\.0\.0/,
    );
    fs.appendFileSync(
      path.join(d, "plugins", "runbook", "page", "index.js"),
      "//\n",
    );
    lines.length = 0;
    expect(await cmdPlugin(["list"], { distRoot: d, log })).toBe(1);
    expect(out()).toMatch(/runbook .*changed since it was added/);
  });

  it("adds a theme with kinds [theme] and no capabilities, like theme add", async () => {
    const d = dist("added-theme");
    expect(await add(d, `${REMOTE}//themes/signal@signal/v1.0.1`)).toBe(0);
    expect(readLock(d).signal).toMatchObject({
      name: "Signal",
      kinds: ["theme"],
      approved_capabilities: [],
    });
    lines.length = 0;
    expect(await cmdTheme(["list"], { distRoot: d, log })).toBe(0);
    expect(out()).toMatch(/signal\s+1\.0\.1\s+https:/);
  });

  it("theme add refuses a plugin that is not a theme", async () => {
    const d = dist("theme-add-page");
    lines.length = 0;
    expect(
      await cmdTheme(["add", `${REMOTE}//plugins/runbook@runbook/v1.0.0`], {
        distRoot: d,
        log,
        tmpDir: tmp,
      }),
    ).toBe(1);
    expect(out()).toMatch(/runbook provides page, not a theme: use plugin add/);
  });

  it("update re-asks only when the capability set grows", async () => {
    const d = dist("updated");
    expect(
      await add(d, `${REMOTE}//plugins/runbook@runbook/v1.0.0`, "--yes"),
    ).toBe(0);
    lines.length = 0;
    expect(
      await cmdPlugin(["update", "runbook", "@runbook/v1.1.0"], {
        distRoot: d,
        log,
        tmpDir: tmp,
      }),
    ).toBe(1);
    expect(out()).toMatch(
      /asks for net:status\.example\.com \(more than was approved\)/,
    );
    expect(readLock(d).runbook.version).toBe("1.0.0");
    expect(
      await cmdPlugin(["update", "runbook", "@runbook/v1.1.0", "--yes"], {
        distRoot: d,
        log,
        tmpDir: tmp,
      }),
    ).toBe(0);
    expect(readLock(d).runbook).toMatchObject({
      version: "1.1.0",
      ref: "runbook/v1.1.0",
      approved_capabilities: ["ui.nav", "api.read", "net:status.example.com"],
    });
    // Back down: a smaller set needs no --yes.
    expect(
      await cmdPlugin(["update", "runbook", "@runbook/v1.0.0"], {
        distRoot: d,
        log,
        tmpDir: tmp,
      }),
    ).toBe(0);
    expect(readLock(d).runbook.approved_capabilities).toEqual([
      "ui.nav",
      "api.read",
    ]);
  });

  it("update and remove are for added plugins; a local one is edited or deleted in git", async () => {
    const d = dist("local-only", "local-dist");
    lines.length = 0;
    expect(
      await cmdPlugin(["update", "runbook", "@v2.0.0"], { distRoot: d, log }),
    ).toBe(1);
    expect(out()).toMatch(
      /runbook is a local plugin .*edit it in plugins\/runbook\//,
    );
    lines.length = 0;
    expect(await cmdPlugin(["remove", "runbook"], { distRoot: d, log })).toBe(
      1,
    );
    expect(out()).toMatch(
      /runbook is a local plugin .*remove it by deleting plugins\/runbook\/ in git/,
    );
    expect(fs.existsSync(path.join(d, "plugins", "runbook"))).toBe(true);
  });

  it("remove deletes an added plugin and its lock entry", async () => {
    const d = dist("removed");
    expect(
      await add(d, `${REMOTE}//plugins/runbook@runbook/v1.0.0`, "--yes"),
    ).toBe(0);
    expect(await cmdPlugin(["remove", "runbook"], { distRoot: d, log })).toBe(
      0,
    );
    expect(fs.existsSync(path.join(d, "plugins", "runbook"))).toBe(false);
    expect(readLock(d).runbook).toBeUndefined();
  });

  it("never replaces a local plugin of any kind", async () => {
    const d = dist("collide");
    fs.mkdirSync(path.join(d, "plugins", "runbook"), { recursive: true });
    fs.writeFileSync(
      path.join(d, "plugins", "runbook", "den-theme.json"),
      "{}",
    );
    lines.length = 0;
    expect(
      await add(d, `${REMOTE}//plugins/runbook@runbook/v1.0.0`, "--yes"),
    ).toBe(1);
    expect(out()).toMatch(/already a local plugin/);
    expect(readLock(d).runbook).toBeUndefined();
  });
});

describe("PL-2a: plugins.allow in den.yml", () => {
  const add = (d: string) =>
    cmdPlugin(["add", `${REMOTE}//themes/signal@signal/v1.0.1`], {
      distRoot: d,
      log,
      tmpDir: tmp,
    });
  const withAllow = (name: string, yml: string) => {
    const d = dist(name);
    fs.writeFileSync(path.join(d, "den.yml"), `product:\n  name: acme\n${yml}`);
    return d;
  };

  it("absent: any host", async () => {
    expect(await add(withAllow("allow-none", ""))).toBe(0);
  });

  it("refuses a source outside the list, naming the list", async () => {
    const d = withAllow(
      "allow-other",
      "plugins:\n  allow:\n    - git.example/other\n",
    );
    lines.length = 0;
    expect(await add(d)).toBe(1);
    expect(out()).toMatch(
      /https:\/\/git\.example\/acme\/den-plugins\.git is not allowed by plugins\.allow in den\.yml \(git\.example\/other\)/,
    );
    expect(readLock(d).signal).toBeUndefined();
  });

  it("accepts a listed <host>/<owner>, or a bare host", async () => {
    expect(
      await add(
        withAllow("allow-owner", "plugins:\n  allow: [git.example/acme]\n"),
      ),
    ).toBe(0);
    expect(
      await add(withAllow("allow-host", "plugins:\n  allow: [git.example]\n")),
    ).toBe(0);
  });

  it("a malformed list is an error, not an open door", async () => {
    const d = withAllow("allow-bad", "plugins:\n  allow: git.example\n");
    lines.length = 0;
    expect(await add(d)).toBe(1);
    expect(out()).toMatch(/plugins\.allow must be a list/);
  });
});

describe("the theme runtime sees a den-plugin.json theme", () => {
  it("serves the theme from the directory its entry names", () => {
    const d = dist("runtime");
    const p = path.join(d, "plugins", "brand");
    fs.cpSync(
      path.join(FIXTURES, "local-dist", "plugins", "signal"),
      path.join(p, "theme"),
      { recursive: true },
    );
    const t = path.join(p, "theme", "den-theme.json");
    fs.writeFileSync(
      t,
      JSON.stringify({
        ...(JSON.parse(fs.readFileSync(t, "utf-8")) as object),
        id: "brand",
      }),
    );
    fs.writeFileSync(
      path.join(p, "den-plugin.json"),
      JSON.stringify({
        schema: "den.plugin/v1",
        id: "brand",
        name: "Brand",
        version: "1.0.0",
        license: "MIT",
        den: ">=0.3.0",
        maintainer: "design",
        provides: [{ kind: "theme", manifest: "theme/den-theme.json" }],
      }),
    );
    const brand = listThemes({ distRoot: d, engineRoot: ROOT }).find(
      (x) => x.id === "brand",
    );
    expect(brand).toMatchObject({ ok: true, source: "local" });
    expect(brand?.dir).toBe(path.join(p, "theme"));
  });
});
