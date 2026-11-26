import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseChangelog } from "../../../src/ui/server/changelog-parser.js";

const SCRIPTS = path.join(process.cwd(), "scripts");
const LINE = path.join(SCRIPTS, "changelog-line.mjs");
const DIFF = path.join(SCRIPTS, "release-version-diff.mjs");

const MODULE = path.join(SCRIPTS, "changelog-fragments.mjs");
const assembled = (
  log: string,
  entries: { file: string; text: string }[],
  version: string,
  date: string,
): string => {
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(MODULE)});
const [log, entries, version, date] = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(m.assemble(log, m.parseFragments(entries), version, date)));`,
      JSON.stringify([log, entries, version, date]),
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

const LOG = [
  "# Changelog",
  "",
  "Intro.",
  "",
  "## [0.4.91] - unreleased",
  "",
  "### Fixed",
  "",
  "- An earlier fix.",
  "",
  "### Added",
  "",
  "- An earlier feature.",
  "",
  "### Fixed",
  "",
  "- A second earlier fix,",
  "  on two lines.",
  "",
  "## [0.4.90] - 2026-11-25",
  "",
  "### Fixed",
  "",
  "- A released fix.",
  "",
].join("\n");

const frag = (sections: Record<string, string[]>) =>
  Object.entries(sections)
    .map(([name, lines]) => `### ${name}\n\n${lines.join("\n")}\n`)
    .join("\n");

const repos: string[] = [];
afterEach(() => {
  for (const d of repos.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...a: string[]) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function write(dir: string, file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

function repo(seed: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-fragments-"));
  repos.push(dir);
  git(dir, "init", "-q", "-b", "main");
  write(dir, "CHANGELOG.md", LOG);
  write(dir, "package.json", '{\n  "name": "x",\n  "version": "0.4.91"\n}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");
  seed(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

function commit(dir: string, change: (dir: string) => void) {
  change(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  return git(dir, "rev-parse", "HEAD");
}

function check(change: (dir: string) => void, body = "A change.\n\nRefs #1") {
  const { dir, base } = repo(() => {});
  const head = commit(dir, change);
  const r = spawnSync("node", [LINE, `${base}..${head}`], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, PR_BODY: body, PR_HEAD_REF: "fix/x" },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const srcChange = (d: string) => write(d, "src/a.ts", "export const a = 2;\n");
const FIX = frag({ Fixed: ["- The new fix."] });

describe("issue 1703: the changelog check wants a fragment, never a CHANGELOG.md edit", () => {
  it("a src change with a fragment passes", () => {
    const r = check((d) => {
      srcChange(d);
      write(d, "changes/1703-new-fix.md", FIX);
    });
    expect(r).toMatchObject({ code: 0 });
  });

  it("a src change with no fragment fails, and names the fragment and no-changelog", () => {
    const r = check(srcChange);
    expect(r.code).toBe(1);
    expect(r.out).toContain("changes/<issue>-<slug>.md");
    expect(r.out).toContain("no-changelog: <reason>");
  });

  it("a direct CHANGELOG.md edit fails, even with a fragment", () => {
    const r = check((d) => {
      srcChange(d);
      write(d, "changes/1703-new-fix.md", FIX);
      write(
        d,
        "CHANGELOG.md",
        LOG.replace("- An earlier fix.", "- An earlier fix.\n- The new fix."),
      );
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("CHANGELOG.md");
    expect(r.out).toContain("version commit");
  });

  it("a direct CHANGELOG.md edit fails with no product change too", () => {
    const r = check((d) =>
      write(d, "CHANGELOG.md", LOG.replace("Intro.", "Intro, reworded.")),
    );
    expect(r.code).toBe(1);
  });

  it.each([
    ["a section that isn't one", "changes/1703-x.md", frag({ Fixes: ["- x"] })],
    ["no section heading", "changes/1703-x.md", "- The new fix.\n"],
    ["a section with no line", "changes/1703-x.md", "### Fixed\n\nprose\n"],
    ["a name without the issue", "changes/new-fix.md", FIX],
    ["a name in capitals", "changes/1703-New-Fix.md", FIX],
  ])(
    "a fragment with %s fails, and says what is wrong",
    (_what, file, text) => {
      const r = check((d) => {
        srcChange(d);
        write(d, file, text);
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain(file);
    },
  );

  it("no-changelog with a reason still passes with no fragment", () => {
    const r = check(srcChange, "A change.\n\nno-changelog: a rename\n");
    expect(r).toMatchObject({ code: 0 });
  });

  it("the version commit may edit CHANGELOG.md", () => {
    const r = check((d) => {
      write(d, "package.json", '{\n  "name": "x",\n  "version": "0.4.92"\n}\n');
      write(d, "CHANGELOG.md", LOG.replace("unreleased", "2026-11-27"));
    });
    expect(r).toMatchObject({ code: 0 });
  });
});

describe("issue 1703: the version commit assembles the fragments", () => {
  it("one heading per section in a stable order, earlier lines first, fragments by issue number", () => {
    const fragments = [
      {
        file: "changes/1710-later.md",
        text: frag({ Fixed: ["- Fix from 1710."], Security: ["- Sec 1710."] }),
      },
      {
        file: "changes/1703-first.md",
        text: frag({ Migrations: ["- Move x."], Fixed: ["- Fix from 1703."] }),
      },
    ];
    const out = assembled(LOG, fragments, "0.4.91", "2026-11-27");
    const entry = out.slice(
      out.indexOf("## [0.4.91]"),
      out.indexOf("## [0.4.90]"),
    );
    expect(entry).toBe(
      [
        "## [0.4.91] - 2026-11-27",
        "",
        "### Security",
        "",
        "- Sec 1710.",
        "",
        "### Added",
        "",
        "- An earlier feature.",
        "",
        "### Fixed",
        "",
        "- An earlier fix.",
        "- A second earlier fix,",
        "  on two lines.",
        "- Fix from 1703.",
        "- Fix from 1710.",
        "",
        "### Migrations",
        "",
        "- Move x.",
        "",
        "",
      ].join("\n"),
    );
    expect(out.startsWith("# Changelog\n\nIntro.\n\n## [0.4.91]")).toBe(true);
    expect(out.endsWith("### Fixed\n\n- A released fix.\n")).toBe(true);
  });

  it("no unreleased heading: a new entry above the latest release", () => {
    const log = LOG.replace(/## \[0\.4\.91\][\s\S]*?(?=## \[0\.4\.90\])/, "");
    const out = assembled(
      log,
      [{ file: "changes/1703-a.md", text: FIX }],
      "0.4.91",
      "2026-11-27",
    );
    expect(out).toContain(
      "Intro.\n\n## [0.4.91] - 2026-11-27\n\n### Fixed\n\n- The new fix.\n\n## [0.4.90]",
    );
  });

  it("the changelog parser reads the assembled file as it reads the same file written by hand", () => {
    const got = assembled(
      LOG,
      [
        {
          file: "changes/1703-a.md",
          text: frag({
            Fixed: ["- The new fix,", "  wrapped.", "  - a sub point"],
          }),
        },
      ],
      "0.4.91",
      "2026-11-27",
    );
    const byHand = [
      "# Changelog",
      "",
      "Intro.",
      "",
      "## [0.4.91] - 2026-11-27",
      "",
      "### Added",
      "",
      "- An earlier feature.",
      "",
      "### Fixed",
      "",
      "- An earlier fix.",
      "- A second earlier fix,",
      "  on two lines.",
      "- The new fix,",
      "  wrapped.",
      "  - a sub point",
      "",
      "## [0.4.90] - 2026-11-25",
      "",
      "### Fixed",
      "",
      "- A released fix.",
      "",
    ].join("\n");
    expect(got).toBe(byHand);
    const parsed = parseChangelog(got);
    expect(parsed).toEqual(parseChangelog(byHand));
    expect(parsed[0].sections.Fixed.map((b) => b.text)).toEqual([
      "An earlier fix.",
      "A second earlier fix, on two lines.",
      "The new fix, wrapped.",
    ]);
  });
});

describe("issue 1703: the version commit's diff check takes the assembled changelog and the fragments' removal", () => {
  const setUp = () =>
    repo((d) => {
      write(d, "changes/1703-new-fix.md", FIX);
      write(d, "changes/README.md", "How to write a fragment.\n");
    });
  const diff = (dir: string, base: string, head: string) => {
    const r = spawnSync("node", [DIFF, base, head, "0.4.91"], {
      cwd: dir,
      encoding: "utf-8",
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };

  it("passes when CHANGELOG.md is what assembly gives and the fragments are gone", () => {
    const { dir, base } = setUp();
    const head = commit(dir, (d) => {
      const want = assembled(
        LOG,
        [{ file: "changes/1703-new-fix.md", text: FIX }],
        "0.4.91",
        "2026-11-27",
      );
      write(d, "CHANGELOG.md", want);
      fs.rmSync(path.join(d, "changes/1703-new-fix.md"));
    });
    expect(diff(dir, base, head)).toMatchObject({ code: 0 });
  });

  it("fails when a fragment is left behind", () => {
    const { dir, base } = setUp();
    const head = commit(dir, (d) =>
      write(d, "CHANGELOG.md", LOG.replace("unreleased", "2026-11-27")),
    );
    const r = diff(dir, base, head);
    expect(r.code).toBe(1);
    expect(r.out).toContain("changes/1703-new-fix.md");
  });

  it("fails when the changelog has a line no fragment gave", () => {
    const { dir, base } = setUp();
    const head = commit(dir, (d) => {
      const want = assembled(
        LOG,
        [{ file: "changes/1703-new-fix.md", text: FIX }],
        "0.4.91",
        "2026-11-27",
      );
      write(
        d,
        "CHANGELOG.md",
        want.replace("- The new fix.", "- The new fix.\n- Untested."),
      );
      fs.rmSync(path.join(d, "changes/1703-new-fix.md"));
    });
    const r = diff(dir, base, head);
    expect(r.code).toBe(1);
    expect(r.out).toContain("CHANGELOG.md");
  });
});
