/**
 * `<cli> theme add | list | remove | validate`: a theme is fetched at an
 * exact ref, validated, vendored into the distribution with a lock entry,
 * and checked against that lock afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cmdTheme,
  parseThemeSource,
  readLock,
} from "../../../src/ui/cli/theme-command.js";

const colors = (dark: boolean) =>
  dark
    ? {
        bg: "#0d1117",
        surface: "#161b22",
        raised: "#1c2330",
        sunken: "#0b0f14",
        text: "#e6edf3",
        muted: "#9198a1",
        faint: "#838a95",
        border: "#30363d",
        "border-strong": "#646d7a",
        accent: "#4493f8",
        "accent-text": "#58a6ff",
        "accent-fill": "#1f6feb",
        "on-accent": "#ffffff",
        ok: "#3fb950",
        warn: "#d29922",
        bad: "#f85149",
        remote: "#39c5cf",
      }
    : {
        bg: "#f6f8fa",
        surface: "#ffffff",
        raised: "#ffffff",
        sunken: "#eef1f4",
        text: "#1f2328",
        muted: "#59636e",
        faint: "#656e7b",
        border: "#d1d9e0",
        "border-strong": "#7c8c9e",
        accent: "#0969da",
        "accent-text": "#0969da",
        "accent-fill": "#0969da",
        "on-accent": "#ffffff",
        ok: "#1a7d36",
        warn: "#946300",
        bad: "#cf222e",
        remote: "#0d7882",
      };

const manifest = (id: string, version = "1.0.0") => ({
  schema: "den.theme/v1",
  id,
  name: id,
  version,
  license: "MIT",
  mark: { svg: "mark.svg" },
  fonts: [
    {
      family: "Sample Sans",
      license: "OFL-1.1",
      files: [{ path: "fonts/sample-400.woff2", weight: "400" }],
    },
  ],
  modes: { dark: colors(true), light: colors(false) },
});

let tmp: string;
let repo: string;
let dist: string;
const lines: string[] = [];
const log = (l: string) => lines.push(l);
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString().trim();

function writeTheme(dir: string, m: object): void {
  fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "den-theme.json"), JSON.stringify(m));
  fs.writeFileSync(
    path.join(dir, "mark.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  fs.writeFileSync(path.join(dir, "fonts", "sample-400.woff2"), "wOF2");
  fs.writeFileSync(path.join(dir, "fonts", "OFL.txt"), "SIL OFL 1.1");
  fs.writeFileSync(path.join(dir, "notes.md"), "not part of the theme");
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-theme-cmd-"));
  process.env.DEN_ENGINE_ROOT = path.resolve(__dirname, "../../..");
  repo = path.join(tmp, "themes-repo");
  dist = path.join(tmp, "dist");
  fs.mkdirSync(dist);
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  writeTheme(path.join(repo, "themes", "sample"), manifest("sample"));
  writeTheme(path.join(repo, "themes", "den"), manifest("den"));
  const bad = manifest("bad") as ReturnType<typeof manifest>;
  bad.modes.light.muted = "#bbbbbb";
  writeTheme(path.join(repo, "themes", "bad"), bad);
  git("add", "-A");
  git("commit", "-q", "-m", "themes");
  git("tag", "sample/v1.0.0");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const add = (spec: string) =>
  cmdTheme(["add", spec], { distRoot: dist, log, tmpDir: tmp });

describe("parseThemeSource", () => {
  it("reads the github shorthand with a subpath", () => {
    expect(
      parseThemeSource("github.com/acme/den-themes/nightly@nightly/v1.2.0"),
    ).toEqual({
      repo: "https://github.com/acme/den-themes.git",
      subpath: "nightly",
      ref: "nightly/v1.2.0",
    });
    expect(parseThemeSource("github.com/acme/den-theme-x@v1.0.0")).toEqual({
      repo: "https://github.com/acme/den-theme-x.git",
      subpath: "",
      ref: "v1.0.0",
    });
  });

  it("reads full git URLs, ssh included, with // for a subpath", () => {
    expect(
      parseThemeSource("git@github.com:acme/themes.git//nightly@v1.0.0"),
    ).toEqual({
      repo: "git@github.com:acme/themes.git",
      subpath: "nightly",
      ref: "v1.0.0",
    });
    expect(
      parseThemeSource("https://git.example/x/themes.git//a/b@0123abcd"),
    ).toMatchObject({ subpath: "a/b", ref: "0123abcd" });
  });

  it("requires an exact ref, and refuses odd ones", () => {
    expect(() => parseThemeSource("github.com/acme/themes")).toThrow(
      /exact ref/,
    );
    expect(() => parseThemeSource("git@github.com:acme/themes.git")).toThrow(
      /exact ref/,
    );
    expect(() => parseThemeSource("github.com/a/b@-x")).toThrow(/usable/);
    expect(() => parseThemeSource("github.com/a/b/../c@v1")).toThrow(/\.\./);
  });
});

describe("theme add, list, remove", () => {
  const spec = () => `file://${repo}//themes/sample@sample/v1.0.0`;

  it("vendors the theme's files only, and locks source, ref, commit and hash", async () => {
    expect(await add(spec())).toBe(0);
    const out = path.join(dist, "themes", "sample");
    expect(fs.readdirSync(out, { recursive: true }).map(String).sort()).toEqual(
      [
        "den-theme.json",
        "fonts",
        "fonts/OFL.txt",
        "fonts/sample-400.woff2",
        "mark.svg",
      ],
    );
    const lock = readLock(dist).sample;
    expect(lock).toMatchObject({
      id: "sample",
      version: "1.0.0",
      source: `file://${repo}//themes/sample`,
      ref: "sample/v1.0.0",
      commit: git("rev-parse", "HEAD"),
    });
    expect(lock.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("list checks each theme against its lock", async () => {
    lines.length = 0;
    expect(await cmdTheme(["list"], { distRoot: dist, log })).toBe(0);
    expect(lines.join("\n")).toMatch(/sample\s+1\.0\.0/);
    fs.appendFileSync(path.join(dist, "themes", "sample", "mark.svg"), " ");
    lines.length = 0;
    expect(await cmdTheme(["list"], { distRoot: dist, log })).toBe(1);
    expect(lines.join("\n")).toMatch(/changed since it was added/);
  });

  it("remove deletes the theme and its lock entry", async () => {
    expect(await cmdTheme(["remove", "sample"], { distRoot: dist, log })).toBe(
      0,
    );
    expect(fs.existsSync(path.join(dist, "themes", "sample"))).toBe(false);
    expect(readLock(dist).sample).toBeUndefined();
    expect(await cmdTheme(["remove", "sample"], { distRoot: dist, log })).toBe(
      1,
    );
  });

  it("refuses a theme that fails validation, naming the pair", async () => {
    git("tag", "bad/v1.0.0");
    lines.length = 0;
    expect(await add(`file://${repo}//themes/bad@bad/v1.0.0`)).toBe(1);
    expect(lines.join("\n")).toMatch(/light: muted on (bg|surface) is/);
    expect(fs.existsSync(path.join(dist, "themes", "bad"))).toBe(false);
  });

  it("refuses the built-in id", async () => {
    git("tag", "den/v1.0.0");
    lines.length = 0;
    expect(await add(`file://${repo}//themes/den@den/v1.0.0`)).toBe(1);
    expect(lines.join("\n")).toMatch(/built-in/);
  });

  it("a ref that does not exist fails without touching the distribution", async () => {
    lines.length = 0;
    expect(await add(`file://${repo}//themes/sample@sample/v9.9.9`)).toBe(1);
    expect(lines.join("\n")).toMatch(/no tag or branch "sample\/v9.9.9"/);
    expect(fs.existsSync(path.join(dist, "themes", "sample"))).toBe(false);
  });

  it("refuses a branch unless --track, which the lock records", async () => {
    lines.length = 0;
    expect(await add(`file://${repo}//themes/sample@main`)).toBe(1);
    expect(lines.join("\n")).toMatch(
      /main is a branch: pin a tag or a full commit SHA/,
    );
    expect(
      await cmdTheme(["add", `file://${repo}//themes/sample@main`, "--track"], {
        distRoot: dist,
        log,
        tmpDir: tmp,
      }),
    ).toBe(0);
    expect(readLock(dist).sample).toMatchObject({
      ref: "main",
      tracking: true,
    });
  });

  it("takes a full commit SHA, not a short one", async () => {
    const sha = git("rev-parse", "HEAD");
    expect(await add(`file://${repo}//themes/sample@${sha}`)).toBe(0);
    expect(readLock(dist).sample).toMatchObject({ ref: sha, commit: sha });
    expect(readLock(dist).sample.tracking).toBeUndefined();
    lines.length = 0;
    expect(await add(`file://${repo}//themes/sample@${sha.slice(0, 7)}`)).toBe(
      1,
    );
    expect(lines.join("\n")).toMatch(/full 40-character SHA/);
  });
});

describe("theme validate", () => {
  it("validates a repo of themes, each id against its directory", async () => {
    lines.length = 0;
    expect(await cmdTheme(["validate", repo], { log })).toBe(1);
    const out = lines.join("\n");
    expect(out).toMatch(/✓ .*sample/);
    expect(out).toMatch(/✗ .*bad/);
  });
});
