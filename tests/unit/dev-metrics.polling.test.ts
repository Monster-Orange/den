/**
 * The doctor's polling-loop warning (den#5, dev-metrics/polling.ts), and
 * the `cwd` each local dev-metrics line carries for it (emit.ts).
 *
 * The replay is shaped like a real burst over three days (Nov 3-5): an
 * agent ran one status command from one directory every few seconds for
 * hours, among ordinary use. It is generated here, not committed.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cwdField, eventsFile } from "../../src/shared/dev-metrics/emit.js";
import {
  findPollingLoops,
  pollingWarnings,
  readTailLines,
} from "../../src/shared/dev-metrics/polling.js";
import { pollingLines } from "../../src/ui/cli/doctor-command.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dm-poll-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-03T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const line = (
  ms: number,
  command: string,
  extra: Record<string, string> = {},
) =>
  JSON.stringify({
    ts: iso(ms),
    event: "devtool.den.invocation",
    tier: "log",
    repo: "dist",
    tool: "den",
    command,
    surface: "cli",
    ...extra,
  });

/** Nov 3-5: ordinary use, plus a polling burst on Nov 4, 09:00-15:00. */
function replay(withCwd: boolean): string[] {
  const out: string[] = [];
  // Ordinary use: a few commands an hour, from a few places.
  for (let h = 0; h < 72; h++)
    for (const [i, c] of ["up", "logs", "test", "status"].entries())
      out.push(
        line(T0 + h * 3600_000 + i * 600_000, c, withCwd ? { cwd: "." } : {}),
      );
  // The burst: `status` from one service dir every 3 s for 6 hours.
  const start = Date.parse("2026-11-04T09:00:00Z");
  for (let t = start; t < start + 6 * 3600_000; t += 3000)
    out.push(line(t, "status", withCwd ? { cwd: "services/api" } : {}));
  return out;
}

describe("findPollingLoops on the replay", () => {
  it("fires on the burst, with command, place, count and window", () => {
    const loops = findPollingLoops(replay(true));
    expect(loops).toHaveLength(1);
    expect(loops[0]).toEqual({
      command: "status",
      where: "services/api",
      calls: 1200,
      from: "2026-11-04T09:00:00Z",
      to: "2026-11-04T09:59:57Z",
    });
  });

  it("old lines with no cwd are keyed on command plus repo", () => {
    const loops = findPollingLoops(replay(false));
    expect(loops.map((l) => [l.command, l.where])).toEqual([
      ["status", "repo dist"],
    ]);
  });

  it("600 in an hour is not a loop; 601 is", () => {
    const at = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        line(T0 + i * 5000, "status", { cwd: "." }),
      );
    expect(findPollingLoops(at(600))).toEqual([]);
    expect(findPollingLoops(at(601))).toHaveLength(1);
    // The same 601 spread over more than an hour is not one.
    const spread = Array.from({ length: 601 }, (_, i) =>
      line(T0 + i * 7000, "status", { cwd: "." }),
    );
    expect(findPollingLoops(spread)).toEqual([]);
  });

  it("the same command in different places is counted apart", () => {
    const lines = Array.from({ length: 800 }, (_, i) =>
      line(T0 + i * 1000, "status", { cwd: i % 2 ? "a" : "b" }),
    );
    expect(findPollingLoops(lines)).toEqual([]);
  });
});

describe("doctor's warning", () => {
  it("prints the burst from the local events file", () => {
    const root = path.join(tmp, "dist");
    fs.mkdirSync(path.join(root, ".dev-metrics"), { recursive: true });
    fs.writeFileSync(eventsFile(root), replay(true).join("\n") + "\n");
    expect(pollingWarnings(eventsFile(root))).toEqual([
      "looks like a polling loop: status in services/api, 1200 calls in an hour (2026-11-04T09:00:00Z–2026-11-04T09:59:57Z)",
    ]);
    const lines = pollingLines(eventsFile(root), "Acme");
    expect(lines.join("\n")).toContain(
      "doctor: dev-metrics (local, never sent)",
    );
    expect(lines.join("\n")).toContain("looks like a polling loop: status");
  });

  it("is silent with no file, or a file with no loop", () => {
    expect(pollingLines(path.join(tmp, "none.jsonl"), "Acme")).toEqual([]);
    const f = path.join(tmp, "calm.jsonl");
    fs.writeFileSync(f, replay(true).slice(0, 288).join("\n"));
    expect(pollingLines(f, "Acme")).toEqual([]);
  });

  it("reads only the tail, whole lines, however big the file", () => {
    const f = path.join(tmp, "big.jsonl");
    const head = Array.from({ length: 5000 }, (_, i) =>
      line(T0 + i, "old", { cwd: "." }),
    );
    const tail = Array.from({ length: 10 }, (_, i) =>
      line(T0 + 10_000 + i, "new", { cwd: "." }),
    );
    fs.writeFileSync(f, [...head, ...tail].join("\n") + "\n");
    const bytes = Buffer.byteLength(tail.join("\n") + "\n") + 40;
    const got = readTailLines(f, bytes);
    expect(got.slice(-10)).toEqual(tail);
    expect(got.length).toBe(10);
    for (const l of got) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe("cwd in each local line", () => {
  it("is relative to the root, '.' at the root, 'outside' elsewhere", () => {
    const root = path.join(tmp, "r");
    fs.mkdirSync(path.join(root, "services", "api"), { recursive: true });
    expect(cwdField(root, root)).toBe(".");
    expect(cwdField(root, path.join(root, "services", "api"))).toBe(
      "services/api",
    );
    expect(cwdField(root, tmp)).toBe("outside");
    expect(cwdField(root, os.homedir())).toBe("outside");
  });

  it("record() writes it, and never an absolute path", async () => {
    const root = path.join(tmp, "rec");
    fs.mkdirSync(root, { recursive: true });
    const saved = { ...process.env };
    process.env.DEV_METRICS_REPO_ROOT = root;
    process.env.DEV_METRICS_DISABLED = "1";
    try {
      const { record } = await import("../../src/shared/dev-metrics/emit.js");
      record("devtool.den.invocation", { tool: "den", command: "up" });
    } finally {
      process.env = saved;
    }
    const row = JSON.parse(
      fs.readFileSync(eventsFile(root), "utf-8").trim(),
    ) as Record<string, string>;
    expect(row.cwd).toBe("outside");
    expect(JSON.stringify(row)).not.toContain(tmp);
  });
});
