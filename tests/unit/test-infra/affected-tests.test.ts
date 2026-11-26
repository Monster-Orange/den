/**
 * Issue 398: a pull request runs the tests its change affects (jest's
 * related tests, the browser specs tests/affected-map.json maps to a changed
 * page, and a fixed smoke set); a change to anything shared runs them all.
 * scripts/ci-replay.mjs proved the subset on the last 30 days of red CI
 * runs; tests/fixtures/ci-replay-cases.json keeps those real failures, and
 * the map must go on catching every one of them.
 *
 * Fixtures only: no git, no gh, no jest child. The scripts are ES modules,
 * so each call runs in a child Node.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");
const AFFECTED = path.join(ROOT, "scripts", "affected-tests.mjs");
const REPLAY = path.join(ROOT, "scripts", "ci-replay.mjs");
const MAP_FILE = path.join(ROOT, "tests", "affected-map.json");
const MAP_GEN = path.join(ROOT, "scripts", "affected-map.mjs");
const CASES_FILE = path.join(ROOT, "tests", "fixtures", "ci-replay-cases.json");

interface Selection {
  all: boolean;
  allBecause: string[];
  files: Record<string, string[]>;
}
interface Map {
  everything: string[];
  smoke: string[];
  rules: { when: string[]; run: string[]; why: string }[];
  subjects?: Record<string, string[]>;
  subjectless?: string[];
}
interface Case {
  file: string;
  nodes?: string[];
  changed: string[];
  related: boolean;
  verdict: string;
  caught?: boolean;
}

/**
 * Runs ES-module code in a child Node, `input` as JSON in a temp file (read
 * with `ARGS()`): never in the environment, where Linux caps one variable
 * at 128 KB (E2BIG; the replay's cases are bigger), and never on stdin,
 * where an input over 64 KB sometimes left the child waiting for the rest
 * and the parent for the child, until jest's timeout (issue 708: the map
 * passed 64 KB). A failure comes back as a plain Error: a child-process
 * error refers to itself (`.error`), and jest's worker can't send that to
 * the parent.
 */
function child(code: string, input: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-affected-"));
  const file = path.join(dir, "args.json");
  fs.writeFileSync(file, JSON.stringify(input));
  try {
    return execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFileSync as readArgs } from "node:fs"; const ARGS = () => JSON.parse(readArgs(process.argv[1], "utf-8"));\n${code}`,
        file,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (e) {
    const err = e as { message?: string; stderr?: string };
    throw new Error(
      `child node failed: ${err.message ?? e}\n${err.stderr ?? ""}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Calls `fn` of a script module in a child Node with JSON args. */
function call<T>(script: string, fn: string, ...args: unknown[]): T {
  const out = child(
    `const m = await import(${JSON.stringify(script)});
     const r = await m[${JSON.stringify(fn)}](...ARGS());
     const plain = (k, v) => v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v instanceof RegExp ? v.source : v;
     console.log(JSON.stringify(r ?? null, plain));`,
    args,
  );
  return JSON.parse(out) as T;
}

const select = (a: {
  changed: string[];
  allTests: string[];
  related: string[];
  map: Map;
  importersOf?: Record<string, string[]>;
  mentioned?: string[];
}) => call<Selection>(AFFECTED, "selectTests", a);

/** Every *.test.ts under tests/, as jest lists them (repo-relative). */
function allTests(dir = path.join(ROOT, "tests")): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory())
      return e.name === "node_modules" || e.name === "fixtures"
        ? []
        : allTests(p);
    return e.name.endsWith(".test.ts") ? [path.relative(ROOT, p)] : [];
  });
}

const MAP = JSON.parse(fs.readFileSync(MAP_FILE, "utf-8")) as Map;
const TESTS = allTests();

describe("globs", () => {
  const match = (glob: string, file: string) =>
    new RegExp(call<string>(AFFECTED, "globToRegExp", glob)).test(file);
  it("** spans directories, * stays in one", () => {
    expect(match("packages/den-ui/**", "packages/den-ui/src/a/b.js")).toBe(
      true,
    );
    expect(match("tests/**/helpers/**", "tests/unit/server/helpers/x.ts")).toBe(
      true,
    );
    expect(match("tests/*.ts", "tests/setup.ts")).toBe(true);
    expect(match("tests/*.ts", "tests/unit/setup.ts")).toBe(false);
    expect(
      match(
        "src/ui/server/public/agent*.js",
        "src/ui/server/public/agents-page.js",
      ),
    ).toBe(true);
    expect(
      match(
        "src/ui/server/public/agent*.js",
        "src/ui/server/public/x/agents.js",
      ),
    ).toBe(false);
  });
  it("{a,b} is either; dots are literal", () => {
    expect(match("jest.config.{js,mjs}", "jest.config.mjs")).toBe(true);
    expect(match("jest.config.{js,mjs}", "jest_config.js")).toBe(false);
  });
});

describe("selectTests (fixtures)", () => {
  const map: Map = {
    everything: ["src/guard.ts", "packages/kit/**"],
    smoke: ["tests/smoke.test.ts"],
    rules: [
      {
        when: ["src/public/a-page.js"],
        run: ["tests/a-*.browser.test.ts"],
        why: "page a",
      },
    ],
  };
  const tests = [
    "tests/smoke.test.ts",
    "tests/a-one.browser.test.ts",
    "tests/a-two.browser.test.ts",
    "tests/b.browser.test.ts",
    "tests/lib.test.ts",
    "tests/other.test.ts",
  ];

  it("a page change runs that page's specs and smoke, each with its reason", () => {
    const s = select({
      changed: ["src/public/a-page.js"],
      allTests: tests,
      related: [],
      map,
    });
    expect(s.all).toBe(false);
    expect(Object.keys(s.files).sort()).toEqual([
      "tests/a-one.browser.test.ts",
      "tests/a-two.browser.test.ts",
      "tests/smoke.test.ts",
    ]);
    expect(s.files["tests/a-one.browser.test.ts"]).toEqual([
      "mapped: src/public/a-page.js (page a)",
    ]);
    expect(s.files["tests/smoke.test.ts"]).toEqual(["smoke"]);
  });

  it("related and changed tests run; tests outside jest's list never do", () => {
    const s = select({
      changed: ["src/lib.ts", "tests/other.test.ts", "tests/gone.test.ts"],
      allTests: tests,
      related: ["tests/lib.test.ts", "tests/not-a-test.ts"],
      map,
    });
    expect(s.files["tests/lib.test.ts"]).toEqual(["related"]);
    expect(s.files["tests/other.test.ts"]).toEqual(["changed"]);
    expect(s.files["tests/gone.test.ts"]).toBeUndefined();
    expect(s.files["tests/not-a-test.ts"]).toBeUndefined();
    expect(s.files["tests/b.browser.test.ts"]).toBeUndefined();
  });

  it("a change to a shared file runs everything and says which file", () => {
    const s = select({
      changed: ["src/lib.ts", "packages/kit/src/x.js"],
      allTests: tests,
      related: [],
      map,
    });
    expect(s.all).toBe(true);
    expect(s.allBecause).toEqual(["packages/kit/src/x.js"]);
    expect(Object.keys(s.files)).toHaveLength(tests.length);
  });

  it("a malformed map is refused, never read as 'run less'", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(AFFECTED)}); m.validateMap({ everything: [], smoke: [], rules: [{ when: ["x"] }] });`,
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/rules\[0\]: needs when, run and why/);
  });
});

describe("the map (tests/affected-map.json)", () => {
  it("is valid; smoke files exist; every run glob names a test", () => {
    call(AFFECTED, "validateMap", MAP);
    for (const s of MAP.smoke) expect(TESTS).toContain(s);
    // Every glob at once, in one child.
    const globs = MAP.rules.flatMap((r) => r.run);
    const res = call<string[]>(AFFECTED, "globsToRegExps", globs);
    const dead = globs.filter(
      (_g, i) => !TESTS.some((t) => new RegExp(res[i]).test(t)),
    );
    expect(dead).toEqual([]);
  });

  it("every browser spec is in a rule (a page it opens, or the script it guards)", () => {
    // affected-tests.mjs adds these rules, rebuilt from the code, to the
    // file's own: a new spec is mapped before anyone rewrites the file.
    const rules = call<Map["rules"]>(MAP_GEN, "buildRules");
    const mapped = new Set(rules.flatMap((r) => r.run));
    const orphans = TESTS.filter(
      (t) => t.endsWith(".browser.test.ts") && !mapped.has(t),
    );
    expect(orphans).toEqual([]);
  });

  it("a spec's pages: by URL, the root is local-dev, every page via SERVED_PAGES", () => {
    const pages = (t: string) => call<string[]>(MAP_GEN, "pagesOpened", t);
    expect(pages("await p.goto(`${s.base}/agents?open=1`)")).toEqual([
      "agents.html",
    ]);
    expect(pages("goto(`http://${EDGE}:${port}/settings#access`)")).toEqual([
      "settings.html",
    ]);
    expect(pages("goto(`${base}/`)")).toEqual(["local-dev.html"]);
    expect(pages("for (const p of SERVED_PAGES)").length).toBeGreaterThan(10);
  });

  it("the everything list covers what the issue names", () => {
    for (const f of [
      "src/ui/server/public/shell.js",
      "packages/den-ui/src/kit.js",
      "src/ui/server/request-guard.ts",
      "src/ui/server/route-classes.ts",
      "package.json",
      "package-lock.json",
      "jest.config.js",
      "tests/setup.ts",
      "tests/unit/server/helpers/den-auth.ts",
      ".github/workflows/ci.yml",
    ]) {
      const s = select({
        changed: [f],
        allTests: ["tests/x.test.ts"],
        related: [],
        map: MAP,
      });
      expect([f, s.all]).toEqual([f, true]);
    }
  });

  it("a pull request touching one page runs only that page's specs plus smoke", () => {
    const s = select({
      changed: ["src/ui/server/public/verify-page.js"],
      allTests: TESTS,
      related: [],
      map: MAP,
    });
    expect(s.all).toBe(false);
    const files = Object.keys(s.files);
    expect(files).toContain("tests/unit/server/verify-page.browser.test.ts");
    for (const f of files) {
      const why = s.files[f].join("; ");
      expect([
        f,
        /^(smoke|mapped: src\/ui\/server\/public\/verify-page\.js)/.test(why),
      ]).toEqual([f, true]);
    }
    // Specs of other pages stay out.
    expect(files).not.toContain(
      "tests/unit/server/agents-ag14.browser.test.ts",
    );
    expect(files).not.toContain(
      "tests/unit/server/settings-anchor.browser.test.ts",
    );
    expect(files.length).toBeLessThan(TESTS.length / 10);
  });

  it("a pull request touching the request guard runs everything", () => {
    const s = select({
      changed: ["src/ui/server/request-guard.ts"],
      allTests: TESTS,
      related: [],
      map: MAP,
    });
    expect(s.all).toBe(true);
    expect(s.allBecause).toEqual(["src/ui/server/request-guard.ts"]);
    expect(Object.keys(s.files)).toHaveLength(TESTS.length);
  });

  it("a pull request touching only a live check runs every live check's own test", () => {
    const s = select({
      changed: ["gate/252.mjs"],
      allTests: TESTS,
      related: [],
      map: MAP,
    });
    const files = Object.keys(s.files);
    const own = TESTS.filter((t) =>
      t.startsWith("tests/unit/test-infra/gate-"),
    );
    expect(own).toContain("tests/unit/test-infra/gate-252-runner.test.ts");
    expect(own).toContain("tests/unit/test-infra/gate-expect-shape.test.ts");
    for (const t of own) expect([t, files.includes(t)]).toEqual([t, true]);
  });

  it("a live check's change also runs a test elsewhere that loads it by path", () => {
    const s = select({
      changed: ["gate/750.mjs"],
      allTests: TESTS,
      related: [],
      map: MAP,
    });
    const files = Object.keys(s.files);
    expect(files).toContain("tests/unit/gates/gate-750-hub-leg.test.ts");
    expect(files).toContain("tests/unit/gates/gate-750-real-read.test.ts");
  });
});

describe("tests that start Den as a process (issue 708)", () => {
  // Pull request 704's change: the server process sends the acks, and the
  // integration test reaches it over HTTP, never by an import.
  const PR_704 = [
    "src/shared/hub-delivery-loop.ts",
    "src/shared/hub-delivery.ts",
    "src/ui/cli/agent-ops.ts",
    "src/ui/server/attention.ts",
    "src/ui/server/hub-delivery-service.ts",
    "src/ui/server/index.ts",
    "tests/unit/server/attention-answered.test.ts",
    "tests/unit/server/delivery-idle-input.test.ts",
    "tests/unit/shared/hub-delivery-held-ack.test.ts",
    "tests/unit/shared/hub-delivery-loop.test.ts",
  ];

  it("issue 728: a test declared in subjects runs on its subject, though it starts a scaffolded distribution's bin the pattern can't see", () => {
    const s = select({
      changed: ["src/ui/cli/doctor-command.ts"],
      allTests: TESTS,
      related: [],
      map: MAP,
    });
    expect(s.all).toBe(false);
    expect(Object.keys(s.files)).toEqual(
      expect.arrayContaining([
        "tests/unit/server/no-secrets-store.integration.test.ts",
        "tests/unit/cli/repo-add-no-run.integration.test.ts",
      ]),
    );
  });

  it("a change to its subject runs it, with no import edge (704's change)", () => {
    const s = select({
      changed: PR_704,
      allTests: TESTS,
      related: [],
      map: MAP,
    });
    expect(s.all).toBe(false);
    expect(Object.keys(s.files)).toContain(
      "tests/unit/server/hub-delivery.integration.test.ts",
    );
    // Its subject only: not every test that starts Den.
    const starters = Object.entries(s.files).filter(([, why]) =>
      why.some((w) => /starts Den/.test(w)),
    );
    expect(starters.length).toBeGreaterThan(0);
    expect(starters.length).toBeLessThan(15);
  });

  it("finds them: by a helper, bin/den, or tsx on an entry", () => {
    const starts = call<string[]>(MAP_GEN, "startsDen", [
      "tests/unit/server/hub-delivery.integration.test.ts",
      "tests/unit/cli/validate-all.integration.test.ts",
      "tests/unit/mcp/stdio-integration.test.ts",
      "tests/unit/shared/hub-delivery-loop.test.ts",
    ]);
    expect(starts).toEqual([
      "tests/unit/server/hub-delivery.integration.test.ts",
      "tests/unit/cli/validate-all.integration.test.ts",
      "tests/unit/mcp/stdio-integration.test.ts",
    ]);
  });

  it("a subject: source files named like it, or named in it", () => {
    const subj = (t: string, text = "") =>
      call<string[]>(MAP_GEN, "subjectOf", t, text, {});
    expect(subj("tests/unit/server/hub-delivery.integration.test.ts")).toEqual(
      [
        "src/shared/hub-delivery-journal.ts",
        "src/shared/hub-delivery-loop.ts",
        "src/shared/hub-delivery.ts",
        "src/ui/server/hub-delivery-service.ts",
      ].sort(),
    );
    expect(
      subj("tests/unit/x/odd-name.integration.test.ts", "see crash-loop.ts"),
    ).toEqual(["src/shared/crash-loop.ts"]);
    expect(subj("tests/unit/x/odd-name.integration.test.ts")).toEqual([]);
  });

  it("each one has a subject, or is on the map's shrink-only list", () => {
    const r = call<{ missing: string[]; stale: string[] }>(
      MAP_GEN,
      "subjectGaps",
      MAP,
    );
    // missing: starts Den, no subject, not listed (add `subjects` for it).
    // stale: listed, but it has a subject now or starts no Den (drop it).
    // empty: a declared subject glob that names no file (issue 709).
    expect(r).toEqual({ missing: [], stale: [], empty: [] });
  });

  it("issue 709: a declared subject that names no file is refused, never counted as a subject", () => {
    const a11y = "tests/unit/server/a11y.browser.test.ts";
    const r = call<{ empty: string[] }>(MAP_GEN, "subjectGaps", {
      ...MAP,
      subjects: {
        ...MAP.subjects,
        [a11y]: ["", "src/ui/server/no-such-module.ts", "src/ui/server/*.ts"],
        "tests/unit/no-such.test.ts": ["src/ui/server/index.ts"],
      },
    });
    expect(r.empty).toEqual([
      `${a11y}: ""`,
      `${a11y}: "src/ui/server/no-such-module.ts"`,
      "tests/unit/no-such.test.ts: the test isn't there",
    ]);
  });
});

describe("the replay's real failures stay caught", () => {
  const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf-8")) as Case[];

  it("has the replay's real failures, none of them flakes", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) expect(c.verdict).not.toBe("flake");
  });

  it("the map catches every one, on the Node it failed on (the pr matrix, or the nightly run for Node 22)", () => {
    const ciText = fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "ci.yml"),
      "utf-8",
    );
    // Issue 998: a pull request runs Node 24; Node 22 runs nightly on main.
    expect(call<string[]>(REPLAY, "prNodesOf", ciText)).toEqual(["24.13.0"]);
    const nodes = call<string[]>(REPLAY, "caughtNodesOf", ciText);
    expect(nodes).toEqual(["22.13.0", "24.13.0"]);
    for (const c of cases) expect(c.nodes?.length).toBeGreaterThan(0);
    const rows = call<Case[]>(REPLAY, "recheck", cases, MAP, nodes);
    const missed = rows.filter((r) => !r.caught).map((r) => r.file);
    expect(missed).toEqual([]);
  });

  it("a pull request on Node 24 alone misses the Node-22-only failures", () => {
    const rows = call<Case[]>(REPLAY, "recheck", cases, MAP, ["24.13.0"]);
    const missed = rows.filter((r) => !r.caught);
    expect(missed.length).toBeGreaterThan(0);
    for (const r of missed) expect(r.nodes).toEqual(["22.13.0"]);
  });

  it("a narrowed map misses some, and the replay exits 1 on it", () => {
    const narrow: Map = { everything: [], smoke: [], rules: [] };
    const missed = call<Case[]>(
      REPLAY,
      "missedFailures",
      call<Case[]>(REPLAY, "recheck", cases, narrow),
    );
    expect(missed.length).toBeGreaterThan(0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-replay-"));
    try {
      const mapFile = path.join(dir, "narrow.json");
      fs.writeFileSync(mapFile, JSON.stringify(narrow));
      const r = spawnSync(
        process.execPath,
        [REPLAY, "--recheck", CASES_FILE, "--map", mapFile],
        { encoding: "utf-8", env: { ...process.env, PATH: "" } },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/the subset misses \d+ real failure/);
      const ok = spawnSync(
        process.execPath,
        [REPLAY, "--recheck", CASES_FILE, "--map", MAP_FILE],
        { encoding: "utf-8", env: { ...process.env, PATH: "" } },
      );
      expect([ok.status, ok.stderr]).toEqual([0, ""]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the replay's parsing and verdicts", () => {
  const LOG = [
    "2026-11-17T20:08:19.9795058Z   ● Console",
    "2026-11-17T20:18:05.7803091Z \x1b[1mFAIL\x1b[22m tests/unit/server/a.integration.test.ts (20.437 s)",
    "2026-11-17T20:18:05.8291065Z   ● suite › first",
    "2026-11-17T20:18:05.8299918Z   ● suite › second",
    "2026-11-17T20:18:06.0000000Z PASS tests/unit/server/b.test.ts",
    "2026-11-17T20:20:33.4026109Z FAIL tests/unit/server/a.integration.test.ts (20.437 s)",
    "2026-11-17T20:20:33.4030274Z   ● suite › first",
    "2026-11-17T20:20:33.4062119Z Test Suites: 1 failed, 201 passed, 202 total",
  ].join("\n");

  it("reads each failing file once, with its failing tests", () => {
    expect(call(REPLAY, "parseJestFailures", LOG)).toEqual([
      {
        file: "tests/unit/server/a.integration.test.ts",
        tests: ["suite › first", "suite › second"],
      },
    ]);
  });

  const at = (key: string, head: string, extra: object = {}) => ({
    key,
    head,
    tree: `t-${head}`,
    green: false,
    testsFinished: true,
    failedFiles: [] as string[],
    ...extra,
  });
  const verdict = (o: {
    others: ReturnType<typeof at>[];
    next?: ReturnType<typeof at>[];
    nextChanged?: string[];
    nextRelated?: string[];
    changed?: string[];
  }) => {
    // Sets do not survive JSON: rebuild them in the child.
    const out = child(
      `const m = await import(${JSON.stringify(REPLAY)});
       const a = ARGS();
       const fix = (l) => (l ?? []).map((x) => ({ ...x, failedFiles: new Set(x.failedFiles) }));
       console.log(JSON.stringify(m.classify({ file: "t.test.ts", attempt: { key: "r1#1", head: "h1", tree: "t-h1" }, base: "main1", changed: a.changed ?? ["src/x.ts"], testReadsMarkdown: false, others: fix(a.others), next: fix(a.next), nextChanged: a.nextChanged, nextRelated: a.nextRelated })));`,
      o,
    );
    return (JSON.parse(out) as { verdict: string }).verdict;
  };

  it("flake: the same head passed it later (sha, or the same tree)", () => {
    expect(verdict({ others: [at("r1#2", "h1", { green: true })] })).toBe(
      "flake",
    );
    expect(
      verdict({ others: [at("r9#1", "other", { tree: "t-h1", green: true })] }),
    ).toBe("flake");
    expect(
      verdict({ others: [at("r1#2", "h1", { failedFiles: ["u.test.ts"] })] }),
    ).toBe("flake");
  });

  it("real: failed again on the same head, or on the next commit, or a fix followed", () => {
    expect(
      verdict({ others: [at("r1#2", "h1", { failedFiles: ["t.test.ts"] })] }),
    ).toBe("real");
    expect(
      verdict({
        others: [],
        next: [at("r2#1", "h2", { failedFiles: ["t.test.ts"] })],
      }),
    ).toBe("real");
    expect(
      verdict({
        others: [],
        next: [at("r2#1", "h2", { green: true })],
        nextChanged: ["t.test.ts"],
      }),
    ).toBe("real");
    expect(
      verdict({
        others: [],
        next: [at("r2#1", "h2", { green: true })],
        nextChanged: ["src/x.ts"],
        nextRelated: ["t.test.ts"],
      }),
    ).toBe("real");
  });

  it("inherited: main's run at the base had already failed it", () => {
    expect(
      verdict({
        others: [at("m1#1", "main1", { failedFiles: ["t.test.ts"] })],
      }),
    ).toBe("inherited");
  });

  it("flake?: it went away with no fix, or the change was Markdown only", () => {
    expect(
      verdict({
        others: [],
        next: [at("r2#1", "h2", { green: true })],
        nextChanged: ["docs/x.md"],
      }),
    ).toBe("flake?");
    expect(
      verdict({
        others: [],
        next: [
          at("r2#1", "h2", { failedFiles: ["t.test.ts"] }),
          at("r2#2", "h2", { green: true }),
        ],
      }),
    ).toBe("flake?");
    expect(
      verdict({
        others: [at("r1#2", "h1", { failedFiles: ["t.test.ts"] })],
        changed: ["README.md"],
      }),
    ).toBe("flake?");
  });

  it("real?: no evidence either way counts as real", () => {
    expect(verdict({ others: [] })).toBe("real?");
    // The next commit touched the test but never finished: no fix shown.
    expect(
      verdict({
        others: [],
        next: [at("r2#1", "h2", { testsFinished: false })],
        nextChanged: ["t.test.ts"],
      }),
    ).toBe("real?");
    // An unfinished run (cancelled tests) is no evidence of a pass.
    expect(
      verdict({ others: [at("r1#2", "h1", { testsFinished: false })] }),
    ).toBe("real?");
  });

  it("a real? that failed the same way as a flake elsewhere is a known flake", () => {
    const rows = call<{ verdict: string }[]>(REPLAY, "knownFlakes", [
      {
        run: "r1#1 main abc",
        file: "t.test.ts",
        tests: ["a › b"],
        verdict: "real?",
      },
      {
        run: "r2#1 x def",
        file: "t.test.ts",
        tests: ["a › b"],
        verdict: "flake",
      },
      {
        run: "r3#1 y 123",
        file: "u.test.ts",
        tests: ["a › b"],
        verdict: "real?",
      },
    ]);
    expect(rows.map((r) => r.verdict)).toEqual(["flake?", "flake", "real?"]);
    // A fix seen only in imported code gives way to a confirmed flake twin.
    const weak = call<{ verdict: string }[]>(REPLAY, "knownFlakes", [
      {
        run: "r1#1 main abc",
        file: "t.test.ts",
        tests: ["a › b"],
        verdict: "real",
        why: "the next commit changed code the test imports, and passed it",
      },
      {
        run: "r2#1 x def",
        file: "t.test.ts",
        tests: ["a › b"],
        verdict: "flake",
        why: "same head passed in r2#2",
      },
      {
        run: "r3#1 y 123",
        file: "t.test.ts",
        tests: ["a › b"],
        verdict: "real",
        why: "failed again on the same head (r3#2)",
      },
    ]);
    expect(weak.map((r) => r.verdict)).toEqual(["flake?", "flake", "real"]);
  });
});

describe("ci.yml (issue 398)", () => {
  type Step = {
    run?: string;
    if?: string;
    env?: Record<string, string>;
    id?: string;
  };
  type Job = {
    if?: string;
    needs?: string[];
    "runs-on"?: string;
    strategy?: { matrix?: { node?: string[]; shard?: unknown } };
    steps: Step[];
  };
  const ci = yaml.parse(
    fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf-8"),
  ) as { jobs: Record<string, Job> };
  const runs = (j: Job) => j.steps.map((s) => s.run ?? "").join("\n");

  // Issue 996: a push to main runs the checks only; the full matrix runs by
  // hand (workflow_dispatch). None of it runs on a pull request.
  it("the full matrix runs by hand, the checks on main too; none of it on a pull request", () => {
    expect(ci.jobs.checks.if).toBe(
      "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
    );
    for (const name of ["tests", "dist-smoke"])
      expect([name, ci.jobs[name].if]).toEqual([
        name,
        "github.event_name == 'workflow_dispatch'",
      ]);
    for (const name of ["checks", "tests", "dist-smoke"])
      expect(ci.jobs[name].strategy?.matrix?.node).toEqual([
        "22.13.0",
        "24.13.0",
      ]);
    expect(ci.jobs["den-ui-nav"].if).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
  });

  it("a pull request: Node 24, the checks, then the subset with its reasons in the summary", () => {
    const pr = ci.jobs.pr;
    expect(pr.if).toBe(
      "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
    );
    // Issue 843: and the fast static checks.
    expect(ci.jobs["pr-shards"].needs).toEqual(["fast", "pr"]);
    const text = runs(pr);
    // Issue 843: the words gate and the kit copies run once, in `fast`,
    // which the pr job waits for.
    expect(ci.jobs.pr.needs).toEqual(["fast"]);
    for (const gate of [
      "npm run typecheck",
      "npm run lint",
      "scripts/org-name-gate.mjs",
      "scripts/org-name-commits.mjs",
      "scripts/dist-smoke.sh",
    ])
      expect([gate, text.includes(gate)]).toEqual([gate, true]);
    // The checks come before the tests.
    expect(text.indexOf("npm run typecheck")).toBeLessThan(
      text.indexOf("affected-tests.mjs"),
    );
    expect(text).toMatch(
      /affected-tests\.mjs "\$BASE" HEAD --out affected\.txt --summary "\$GITHUB_STEP_SUMMARY"/,
    );
    for (const name of ["pr", "pr-shards"]) {
      // Issue 998: Node 24 only (the Node installs run); Node 22 runs
      // nightly on main.
      expect([name, ci.jobs[name].strategy?.matrix?.node]).toEqual([
        name,
        ["24.13.0"],
      ]);
      const versions = ci.jobs[name].steps
        .map(
          (s) =>
            (s as { with?: { "node-version"?: string } }).with?.[
              "node-version"
            ],
        )
        .filter(Boolean);
      expect([name, versions]).toEqual([name, ["${{ matrix.node }}"]]);
      expect(runs(ci.jobs[name])).toMatch(
        /mapfile -t files < (affected|shard)\.txt && npm test/,
      );
    }
  });

  // Issue 1226: pr and pr-shards may use the self-hosted runners (every
  // event is checked in ci-runner-guard.test.ts). A fork's pull request
  // never does, and with the switch off they fall back to GitHub-hosted.
  it("the pr jobs fall back to GitHub-hosted, and a fork's PR never leaves it", () => {
    for (const job of ["pr", "pr-shards"]) {
      const on = String(ci.jobs[job]["runs-on"]);
      expect([job, on]).toEqual([
        job,
        expect.stringContaining("|| 'ubuntu-latest'"),
      ]);
      expect([job, on]).toEqual([
        job,
        expect.stringContaining(
          "github.event.pull_request.head.repo.full_name == github.repository",
        ),
      ]);
    }
  });
});

describe("the UI catalogs (public/i18n/*.js), from a fake diff", () => {
  const EN = "src/ui/server/public/i18n/en.js";
  const DIFF = [
    "--- a/src/ui/server/public/i18n/en.js",
    "+++ b/src/ui/server/public/i18n/en.js",
    "@@ -10 +10 @@",
    '-    "bell.title": "Needs your answer",',
    '+    "bell.title": "Waiting for you",',
    "+    'v.loading': 'Reading the latest results',",
    '     "n.graph": "Graph",',
  ].join("\n");

  it("reads the changed keys and texts, and the English text of a key", () => {
    expect(call(AFFECTED, "catalogChanges", DIFF)).toEqual({
      keys: ["bell.title", "v.loading"],
      texts: [
        "Needs your answer",
        "Waiting for you",
        "Reading the latest results",
      ],
    });
    expect(
      call(
        AFFECTED,
        "englishTexts",
        ["n.graph", "gone.key"],
        '  m.en = {\n    "n.graph": "Graph",\n  };',
      ),
    ).toEqual(["Graph"]);
  });

  it("finds the specs that name a changed key or its text (short words don't count)", () => {
    const specs = {
      "tests/a.browser.test.ts": 'expect(await t("bell.title")).toBe(x)',
      "tests/b.browser.test.ts": "getByText('Waiting for you')",
      "tests/c.browser.test.ts": "getByText('Graph')",
      "tests/d.browser.test.ts": "nothing to see",
    };
    expect(
      call(
        AFFECTED,
        "specsMentioning",
        specs,
        ["bell.title"],
        ["Waiting for you", "Graph"],
      ),
    ).toEqual(["tests/a.browser.test.ts", "tests/b.browser.test.ts"]);
  });

  it("a catalog change runs the helper's importers, the named specs and the fixed ones; not everything", () => {
    const fixed = MAP.rules.find((r) => r.why === "the UI catalogs");
    expect(fixed).toBeDefined();
    const s = select({
      changed: [EN],
      allTests: TESTS.concat(["tests/x-imports-catalog.test.ts"]),
      related: [],
      map: MAP,
      importersOf: {
        "tests/unit/server/helpers/en-catalog.ts": [
          "tests/x-imports-catalog.test.ts",
        ],
      },
      mentioned: ["tests/unit/server/bell.browser.test.ts"],
    });
    expect(s.all).toBe(false);
    const files = Object.keys(s.files);
    for (const f of [
      "tests/unit/scripts/words.test.ts",
      "tests/unit/server/i18n-pages.browser.test.ts",
      "tests/unit/server/i18n-shell.browser.test.ts",
      "tests/unit/server/one-url-per-module.browser.test.ts",
      "tests/unit/server/kit-dialog.browser.test.ts",
      "tests/x-imports-catalog.test.ts",
      "tests/unit/server/bell.browser.test.ts",
    ])
      expect([f, files.includes(f)]).toEqual([f, true]);
    expect(s.files["tests/x-imports-catalog.test.ts"].join()).toMatch(
      /imports en-catalog\.ts/,
    );
    expect(s.files["tests/unit/server/bell.browser.test.ts"].join()).toMatch(
      /mentions a changed key/,
    );
    // A spec that neither checks every page's words, switches language,
    // nor names the key stays out.
    expect(files).not.toContain(
      "tests/unit/server/settings-anchor.browser.test.ts",
    );
  });

  it("shell.js, ui-language.ts, ui-assets.ts and the catalog helpers still run everything", () => {
    for (const f of [
      "src/ui/server/public/shell.js",
      "src/shared/ui-language.ts",
      "src/ui/server/ui-assets.ts",
      "tests/unit/server/helpers/en-catalog.ts",
      "tests/unit/server/helpers/kit-shell.ts",
    ]) {
      const s = select({
        changed: [f],
        allTests: ["tests/x.test.ts"],
        related: [],
        map: MAP,
      });
      expect([f, s.all]).toEqual([f, true]);
    }
  });
});
