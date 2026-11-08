/**
 * The server's test-run history (0.4.17, run-history.ts): every run's
 * start and end in <state>/run-history.jsonl, each repo's latest read back
 * for Workspaces' Last test run, and the file kept bounded.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  KEEP_LINES,
  lastRunsByRepo,
  MAX_LINES,
  readRuns,
  recordRunEnd,
  recordRunStart,
  runHistoryFile,
  reposOfRun,
  type RunRepoSources,
} from "../../../src/ui/server/run-history.js";

let dir = "";
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-runh-")));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 8, 12, min));

describe("the run history", () => {
  it("records a run's start and end, 0600, and reads it back", () => {
    recordRunStart(
      dir,
      { id: "r1", pillar: "smoke", env: "local", repos: ["queue", "web"] },
      at(0),
    );
    recordRunEnd(dir, "r1", 0, at(2));
    expect(readRuns(dir)).toEqual([
      {
        id: "r1",
        pillar: "smoke",
        env: "local",
        repos: ["queue", "web"],
        startedAt: at(0).toISOString(),
        endedAt: at(2).toISOString(),
        exitCode: 0,
      },
    ]);
    expect(fs.statSync(runHistoryFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("gives each repo its latest run; a running one only while this server runs it", () => {
    recordRunStart(
      dir,
      { id: "a", pillar: "smoke", env: "local", repos: ["queue", "web"] },
      at(0),
    );
    recordRunEnd(dir, "a", 0, at(1));
    recordRunStart(
      dir,
      { id: "b", pillar: "journeys", env: "local", repos: ["web"] },
      at(5),
    );
    recordRunEnd(dir, "b", 2, at(6));
    // Cut off by a restart: no end, not live.
    recordRunStart(
      dir,
      { id: "c", pillar: "smoke", env: "local", repos: ["queue"] },
      at(8),
    );
    let last = lastRunsByRepo(dir);
    expect([last.queue.id, last.queue.running]).toEqual(["a", false]);
    expect([last.web.id, last.web.exitCode]).toEqual(["b", 2]);
    // Live: it is the latest, and running.
    last = lastRunsByRepo(dir, new Set(["c"]));
    expect([last.queue.id, last.queue.running]).toEqual(["c", true]);
    expect(last.notes).toBeUndefined();
  });

  it("no file, or a line it can't read, is no run: never a throw", () => {
    expect(lastRunsByRepo(dir)).toEqual({});
    fs.writeFileSync(runHistoryFile(dir), "not json\n{}\n");
    expect(readRuns(dir)).toEqual([]);
  });

  it(`stays bounded: past ${MAX_LINES} lines it keeps the newest ${KEEP_LINES}`, () => {
    const lines = Array.from({ length: MAX_LINES }, (_, i) =>
      JSON.stringify({
        t: "start",
        id: `old${i}`,
        pillar: "smoke",
        env: "local",
        repos: ["queue"],
        at: at(0).toISOString(),
      }),
    );
    fs.writeFileSync(runHistoryFile(dir), `${lines.join("\n")}\n`);
    recordRunStart(
      dir,
      { id: "new", pillar: "smoke", env: "local", repos: ["queue"] },
      at(9),
    );
    const kept = fs
      .readFileSync(runHistoryFile(dir), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(kept).toHaveLength(KEEP_LINES);
    expect(kept.at(-1)).toContain('"id":"new"');
  });
});

describe("the repos a run tests (every run kind)", () => {
  const src: RunRepoSources = {
    pillarSources: (p) => (p === "smoke" ? ["web", "queue"] : []),
    suiteRepos: (_env, only) =>
      ["api/unit", "api/lint", "web/unit"]
        .filter(
          (id) =>
            !only.length ||
            only.includes(id) ||
            only.includes(id.split("/")[0]),
        )
        .map((id) => id.split("/")[0]),
    perfModules: async () => ["api/load", "shared-k6"],
    repoNames: () => ["api", "web", "queue"],
  };

  it("a repo's own tests: suites (all, or the ones picked) name their repos", async () => {
    expect(await reposOfRun("suites", "local", [], src)).toEqual([
      "api",
      "web",
    ]);
    expect(await reposOfRun("suites", "local", ["web/unit"], src)).toEqual([
      "web",
    ]);
    expect(await reposOfRun("suites", "local", ["api"], src)).toEqual(["api"]);
  });

  it("smoke and its kind keep their sources; a repo's performance module names it; Den's own name none", async () => {
    expect(await reposOfRun("smoke", "local", [], src)).toEqual([
      "web",
      "queue",
    ]);
    expect(await reposOfRun("performance", "local", [], src)).toEqual(["api"]);
    expect(
      await reposOfRun("performance", "local", ["shared-k6"], src),
    ).toEqual([]);
    expect(await reposOfRun("integration", "local", [], src)).toEqual([]);
  });

  it("a source that throws is no repos, never a failed run", async () => {
    const bad: RunRepoSources = {
      ...src,
      suiteRepos: () => {
        throw new Error("no manifests");
      },
    };
    expect(await reposOfRun("suites", "local", [], bad)).toEqual([]);
  });
});
