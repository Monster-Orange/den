import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildEnvelope,
  record,
  recordInvocation,
} from "../../src/shared/dev-metrics/emit.js";

const FIXTURES = path.resolve("tests/unit/fixtures/dev-metrics");

/** Parse (epoch, id) out of a captured Sentry envelope (line 3 is the payload). */
function envelopeMeta(envelope: string): { epoch: number; id: string } {
  const payload = envelope.split("\n")[2];
  const body = JSON.parse(payload);
  if (body.version === 2) {
    const item = body.items[0];
    return { epoch: item.timestamp, id: item.trace_id };
  }
  return { epoch: body.timestamp, id: body.event_id };
}

describe("dev-metrics buildEnvelope — byte-compat with dev_metrics.py", () => {
  for (const tier of ["log", "event"] as const) {
    it(`reproduces the golden ${tier} envelope byte-for-byte`, () => {
      const goldenEnvelope = fs.readFileSync(
        path.join(FIXTURES, `${tier}.envelope.txt`),
        "utf-8",
      );
      const recordLine = fs
        .readFileSync(path.join(FIXTURES, `${tier}.record.jsonl`), "utf-8")
        .trim();
      // The shipped object is the JSONL object minus `ts`.
      const { ts: _ts, ...rec } = JSON.parse(recordLine) as Record<
        string,
        string
      >;
      void _ts;

      const { epoch, id } = envelopeMeta(goldenEnvelope);
      const mine = buildEnvelope(rec, epoch, id);

      expect(mine).toBe(goldenEnvelope);
    });
  }

  it("selects the event envelope only for allowlisted Tier-2 events", () => {
    const base = {
      event: "x",
      tier: "log",
      service: "dev-tooling",
      environment: "dev-tooling",
      repo: "den",
      user: "u",
      branch: "b",
      sha: "s",
      pins: "",
    };
    const logEnv = buildEnvelope({ ...base, tier: "log" }, 1, "a".repeat(32));
    const evtEnv = buildEnvelope({ ...base, tier: "event" }, 1, "a".repeat(32));
    expect(logEnv.startsWith("{}\n")).toBe(true);
    expect(evtEnv.startsWith('{"event_id":')).toBe(true);
  });
});

describe("dev-metrics record — buffering, guards, fail-open", () => {
  let tmp: string;
  const saved = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-test-"));
    process.env.DEV_METRICS_REPO_ROOT = tmp;
    delete process.env.CI;
    delete process.env.DEV_METRICS_DISABLED;
    delete process.env.DEV_METRICS_ENVELOPE_OUT;
    delete process.env.DEV_METRICS_SENTRY_DSN;
  });

  afterEach(() => {
    process.env = { ...saved };
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const readJsonl = (): Record<string, string>[] =>
    fs
      .readFileSync(path.join(tmp, ".dev-metrics", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  it("always buffers one JSONL line and stringifies every field value", () => {
    process.env.DEV_METRICS_DISABLED = "1"; // suppress ship, still buffer
    recordInvocation({
      command: "up",
      surface: "cli",
      durationMs: 1234,
      exit: 0,
    });
    const rows = readJsonl();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.event).toBe("devtool.den.invocation");
    expect(r.tool).toBe("den");
    expect(r.tier).toBe("log");
    expect(r.service).toBe("dev-tooling");
    // numbers are serialized as strings (matches dev_metrics.py str()).
    expect(r.duration_ms).toBe("1234");
    expect(r.exit).toBe("0");
    expect(typeof r.duration_ms).toBe("string");
  });

  it("CI=true suppresses shipping but still buffers", () => {
    process.env.CI = "true";
    process.env.DEV_METRICS_SENTRY_DSN = "https://pub@fake.invalid/42";
    const out = path.join(tmp, "env.out");
    process.env.DEV_METRICS_ENVELOPE_OUT = out;
    record("devtool.den.invocation", { tool: "den", command: "web" });
    expect(fs.existsSync(path.join(tmp, ".dev-metrics", "events.jsonl"))).toBe(
      true,
    );
    expect(fs.existsSync(out)).toBe(false); // never shipped
  });

  it("ships (captures an envelope) when a DSN is set and not suppressed", () => {
    process.env.DEV_METRICS_SENTRY_DSN = "https://pub@fake.invalid/42";
    const out = path.join(tmp, "env.out");
    process.env.DEV_METRICS_ENVELOPE_OUT = out;
    record("devtool.den.invocation", { tool: "den", command: "up" });
    expect(fs.existsSync(out)).toBe(true);
    const envelope = fs.readFileSync(out, "utf-8");
    // The captured envelope must be reproducible from the buffered record.
    const rec = (() => {
      const { ts: _t, ...r } = readJsonl()[0];
      void _t;
      return r;
    })();
    const { epoch, id } = envelopeMeta(envelope);
    expect(buildEnvelope(rec, epoch, id)).toBe(envelope);
  });

  it("never throws on an empty event or an unwritable repo root", () => {
    expect(() => record("")).not.toThrow();
    // Unwritable root = a subpath of a read-only directory → mkdirSync gets a
    // clean EACCES. Do NOT use a /proc/* path here: procfs answers mkdir with
    // EPERM, which node's recursive mkdirSync retries in an INFINITE LOOP on
    // Linux — this exact test silently wedged CI for 6h runs (silent at
    // ~68/123 suites) while passing on macOS, where /proc doesn't exist.
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), "dm-ro-"));
    fs.chmodSync(ro, 0o555);
    process.env.DEV_METRICS_REPO_ROOT = path.join(ro, "sub", "cannot-write");
    try {
      expect(() =>
        recordInvocation({ command: "up", surface: "cli" }),
      ).not.toThrow();
    } finally {
      fs.chmodSync(ro, 0o755);
      fs.rmSync(ro, { recursive: true, force: true });
    }
  });
});
