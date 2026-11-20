/**
 * Issue 441: an outside runner's gate results, imported as a Verify run.
 *
 *   settings   verify.environments (Verify-only environments, default
 *              none) and verify.import limits, each with a permissive
 *              default; a bad value throws. Their keys never overlap the
 *              run, flaky, history and security keys another reader owns.
 *   the file   untrusted: a schema, a size and a count cap, long notes
 *              cut, evidence paths dropped
 *   the run    one check per gate file (its issue), with its clauses; the
 *              tag is the run's id, the commit its commit, started by an
 *              outside runner
 *   the answer on an imported environment: from its newest import, with
 *              the clause counts, failures first, what needs a person and
 *              what couldn't run
 *
 * Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  IMPORT_KEYS,
  IMPORT_DEFAULTS,
  importRecord,
  parseGateVerdict,
  readImportSettings,
} from "../../../src/shared/verify/imports.js";
import {
  listRunRecords,
  writeRunRecord,
} from "../../../src/shared/verify/records.js";
import { verifyOverview } from "../../../src/shared/verify/overview.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-import-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const VERDICT = {
  tag: "v1.2.3-dev.4",
  sha: "0ccbe0c291c6117c67fbc9a20f9f068500aa374a",
  install: "bed",
  startedAt: "2026-11-17T21:36:24Z",
  endedAt: "2026-11-17T21:39:56Z",
  wallMs: 211981,
  clauses: [
    {
      issue: 327,
      clause: "the bell row names the prompt",
      verdict: "PASS",
      ms: 94333,
      evidence: ["/x/327-a.png"],
      note: "badge 6→7",
    },
    {
      issue: 327,
      clause: "stopping the agent clears its wait",
      verdict: "PASS",
      ms: 94333,
      evidence: [],
      note: "",
    },
    {
      issue: 327,
      clause: "answering the prompt clears the wait",
      verdict: "NOT_RUN",
      ms: 94333,
      evidence: [],
      note: "answering a permission prompt is a person's act · skip: person",
    },
    {
      issue: 330,
      clause: "the page answers through the edge",
      verdict: "PASS",
      ms: 73224,
      evidence: [],
      note: "chromium 200",
    },
  ],
};
const text = (v: unknown) => JSON.stringify(v);

describe("the settings", () => {
  it("defaults: no imported environment, permissive limits", () => {
    expect(readImportSettings(undefined)).toEqual(IMPORT_DEFAULTS);
    expect(IMPORT_DEFAULTS.environments).toEqual([]);
    expect(IMPORT_DEFAULTS.maxBytes).toBeGreaterThanOrEqual(5_000_000);
    expect(IMPORT_DEFAULTS.maxClauses).toBeGreaterThanOrEqual(5000);
  });

  it("reads verify.environments and verify.import; a bad value throws, naming it", () => {
    expect(
      readImportSettings({
        environments: ["bed"],
        import: { max_bytes: 1000, max_clauses: 10, max_text: 50 },
      }),
    ).toEqual({
      environments: ["bed"],
      maxBytes: 1000,
      maxClauses: 10,
      maxText: 50,
    });
    expect(() => readImportSettings({ environments: "bed" })).toThrow(
      /verify\.environments/,
    );
    expect(() => readImportSettings({ environments: ["Bed Box"] })).toThrow(
      /verify\.environments/,
    );
    expect(() => readImportSettings({ import: { max_clauses: 0 } })).toThrow(
      /verify\.import\.max_clauses/,
    );
  });

  it("its keys never overlap the run, flaky, history and security keys", () => {
    expect(IMPORT_KEYS).toEqual(["environments", "import"]);
    for (const k of ["run", "flaky", "history", "security"])
      expect(IMPORT_KEYS).not.toContain(k);
  });
});

describe("the file, as untrusted input", () => {
  const lim = IMPORT_DEFAULTS;
  it("reads a runner's verdict; evidence paths are dropped", () => {
    const v = parseGateVerdict(text(VERDICT), lim);
    if (!v.ok) throw new Error(v.error);
    expect(v.verdict.tag).toBe("v1.2.3-dev.4");
    expect(v.verdict.clauses).toHaveLength(4);
    expect(JSON.stringify(v.verdict)).not.toContain("327-a.png");
  });

  it("refuses what isn't one: not JSON, a bad verdict word, a tag that isn't a run id", () => {
    expect(parseGateVerdict("{", lim)).toMatchObject({ ok: false });
    const bad = {
      ...VERDICT,
      clauses: [{ ...VERDICT.clauses[0], verdict: "MAYBE" }],
    };
    expect(parseGateVerdict(text(bad), lim)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/verdict/),
    });
    expect(
      parseGateVerdict(text({ ...VERDICT, tag: "../x" }), lim),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/tag/) });
  });

  it("refuses a file over the size cap and over the count cap, naming the setting", () => {
    expect(
      parseGateVerdict(text(VERDICT), { ...lim, maxBytes: 100 }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/verify\.import\.max_bytes/),
    });
    expect(
      parseGateVerdict(text(VERDICT), { ...lim, maxClauses: 3 }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/verify\.import\.max_clauses/),
    });
  });

  it("cuts a long note or clause to the text cap, and keeps markup as plain text", () => {
    const long = {
      ...VERDICT,
      clauses: [
        {
          ...VERDICT.clauses[0],
          note: "<img src=x onerror=alert(1)>" + "x".repeat(500),
        },
      ],
    };
    const v = parseGateVerdict(text(long), { ...lim, maxText: 60 });
    if (!v.ok) throw new Error(v.error);
    expect(v.verdict.clauses[0].note).toHaveLength(60);
    expect(v.verdict.clauses[0].note.startsWith("<img src=x")).toBe(true);
  });
});

describe("the run it makes", () => {
  it("one check per gate file, its clauses, and the run's verdict", () => {
    const v = parseGateVerdict(text(VERDICT), IMPORT_DEFAULTS);
    if (!v.ok) throw new Error(v.error);
    const rec = importRecord("north", "bed", v.verdict);
    expect(rec).toMatchObject({
      runId: "v1.2.3-dev.4",
      project: "north",
      env: "bed",
      scope: "imported",
      source: "import",
      verdict: "passed",
      exitCode: 0,
      commit: "0ccbe0c291c6117c67fbc9a20f9f068500aa374a",
      startedAt: "2026-11-17T21:36:24Z",
      endedAt: "2026-11-17T21:39:56Z",
      startedBy: { kind: "runner" },
    });
    expect(
      rec.modules.map((m) => [m.id, m.name, m.layer, m.kind, m.state]),
    ).toEqual([
      ["gate/327", "gate/327", "gate", "synthetic", "passed"],
      ["gate/330", "gate/330", "gate", "synthetic", "passed"],
    ]);
    expect(rec.modules[0].clauses).toEqual([
      {
        clause: "the bell row names the prompt",
        result: "passed",
        note: "badge 6→7",
        ms: 94333,
      },
      {
        clause: "stopping the agent clears its wait",
        result: "passed",
        ms: 94333,
      },
      {
        clause: "answering the prompt clears the wait",
        result: "needs-person",
        note: "answering a permission prompt is a person's act",
        ms: 94333,
      },
    ]);
  });

  it("a FAIL fails its check and the run; an ERROR is an error; a check where nothing ran isn't a pass", () => {
    const mixed = {
      ...VERDICT,
      tag: "v1.2.3-dev.5",
      clauses: [
        {
          issue: 1,
          clause: "a",
          verdict: "FAIL",
          ms: 1,
          note: "page row not found",
        },
        { issue: 1, clause: "b", verdict: "PASS", ms: 1 },
        {
          issue: 2,
          clause: "c",
          verdict: "ERROR",
          ms: null,
          note: "shape: no expect",
        },
        {
          issue: 3,
          clause: "d",
          verdict: "NOT_RUN",
          ms: 1,
          note: "skip: needs-second-device",
        },
      ],
    };
    const v = parseGateVerdict(text(mixed), IMPORT_DEFAULTS);
    if (!v.ok) throw new Error(v.error);
    const rec = importRecord("north", "bed", v.verdict);
    expect([rec.verdict, rec.exitCode]).toEqual(["failed", 1]);
    expect(rec.modules.map((m) => [m.id, m.state, m.message])).toEqual([
      ["gate/1", "failed", "a: page row not found"],
      ["gate/2", "error", "c: shape: no expect"],
      ["gate/3", "blocked", "nothing ran here: d"],
    ]);
    expect(rec.modules[2].clauses?.[0]).toMatchObject({
      result: "cant-run",
      note: "needs second device",
    });
  });
});

describe("the answer on an imported environment", () => {
  it("comes from its newest import: clause counts, failures first, needs you, couldn't run", () => {
    for (const [tag, clauses] of [
      ["v1.2.3-dev.4", VERDICT.clauses],
      [
        "v1.2.3-dev.5",
        [
          {
            issue: 327,
            clause: "the bell row names the prompt",
            verdict: "FAIL",
            ms: 1,
            note: "webkit: page row not found",
          },
          ...VERDICT.clauses.slice(1),
          {
            issue: 406,
            clause: "the person signs in on a second device",
            verdict: "NOT_RUN",
            ms: 1,
            note: "skip: needs-second-device",
          },
        ],
      ],
    ] as const) {
      const v = parseGateVerdict(
        text({
          ...VERDICT,
          tag,
          endedAt: tag.endsWith("5") ? "2026-11-18T10:00:00Z" : VERDICT.endedAt,
          clauses,
        }),
        IMPORT_DEFAULTS,
      );
      if (!v.ok) throw new Error(v.error);
      writeRunRecord(stateDir, importRecord("north", "bed", v.verdict));
    }
    const ov = verifyOverview({
      project: "north",
      envs: ["local", "bed"],
      imported: ["bed"],
      modules: [],
      layers: {},
      latest: {},
      runs: listRunRecords(stateDir, "north"),
    });
    const bed = ov.envs.find((e) => e.env === "bed")!;
    expect(bed).toMatchObject({
      answer: "failed",
      imported: true,
      run: {
        runId: "v1.2.3-dev.5",
        tag: "v1.2.3-dev.5",
        startedBy: { kind: "runner" },
      },
      clauses: {
        passed: 2,
        failed: 1,
        error: 0,
        needsPerson: 1,
        cantRun: 1,
        total: 5,
      },
    });
    expect(bed.clauseFailures).toEqual([
      {
        check: "gate/327",
        clause: "the bell row names the prompt",
        result: "failed",
        note: "webkit: page row not found",
      },
    ]);
    expect(bed.needsPerson).toEqual([
      {
        check: "gate/327",
        clause: "answering the prompt clears the wait",
        result: "needs-person",
        note: "answering a permission prompt is a person's act",
      },
    ]);
    expect(bed.cantRun).toEqual([
      {
        check: "gate/406",
        clause: "the person signs in on a second device",
        result: "cant-run",
        note: "needs second device",
      },
    ]);
    // Each check on the tag with its clauses, for the why view's tables,
    // and when the run started (the meta line's time range).
    expect(bed.run?.startedAt).toBe(VERDICT.startedAt);
    expect(
      bed.gateChecks?.map((c) => [
        c.module,
        c.state,
        c.clauses.map((x) => x.result),
      ]),
    ).toEqual([
      ["gate/327", "failed", ["failed", "passed", "needs-person"]],
      ["gate/330", "passed", ["passed"]],
      ["gate/406", "blocked", ["cant-run"]],
    ]);
    // The checks table gets a row per imported check, off elsewhere.
    expect(ov.checks.map((c) => [c.module, c.states])).toEqual([
      ["gate/327", { local: "off", bed: "failed" }],
      ["gate/330", { local: "off", bed: "passed" }],
      ["gate/406", { local: "off", bed: "blocked" }],
    ]);
    // An environment with nothing imported yet has no answer but "not run".
    const none = verifyOverview({
      project: "south",
      envs: ["bed"],
      imported: ["bed"],
      modules: [],
      layers: {},
      latest: {},
      runs: [],
    });
    expect(none.envs[0]).toMatchObject({
      env: "bed",
      answer: "notrun",
      imported: true,
    });
  });
});
