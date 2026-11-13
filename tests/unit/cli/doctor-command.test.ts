/**
 * `<cli> doctor` (0.3.0-dev.25): one row per strategy kind in the registry
 * (secrets, tls) with the selected strategy, whether it was implicit, and
 * detect() with its reason. It never runs a CLI: child_process is mocked
 * and must stay untouched.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("child_process");

import { ROOT } from "./helpers/doctor-root.js";
import * as child from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  agentsConfigured,
  configLines,
  doctorNotes,
  doctorRows,
  formatDoctor,
} from "../../../src/ui/cli/doctor-command.js";
// D9: the usage sources register on import, as in the CLI.
import "../../../src/shared/usage/sources.js";
import { registerStrategy } from "../../../src/shared/strategies/registry.js";

const savedPath = process.env.PATH;

function dist(config: string): NodeJS.ProcessEnv {
  fs.writeFileSync(path.join(ROOT, "config", "den.yml"), config);
  return { PATH: "/usr/bin:/bin" };
}

beforeEach(() => {
  // No mkcert, op or doppler on PATH.
  process.env.PATH = "/usr/bin:/bin";
});
afterEach(() => {
  process.env.PATH = savedPath;
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const spawned = () =>
  [child.spawnSync, child.execSync, child.execFileSync, child.spawn].map(
    (f) => (f as unknown as jest.Mock).mock.calls.length,
  );

describe("doctor", () => {
  it("lists secrets and tls, with no edge and no store", () => {
    const rows = doctorRows(dist("secrets:\n  provider: none\n"));
    expect(rows.map((r) => r.kind)).toEqual([
      "secrets",
      "tls",
      "session-backend",
      "runtime",
      "usage",
    ]);
    expect(rows[0]).toMatchObject({
      selected: "none",
      implicit: false,
      available: true,
      problem: false,
    });
    expect(rows[1]).toMatchObject({
      selected: "none",
      available: true,
      reason: "no edge: block",
      problem: false,
    });
    expect(spawned()).toEqual([0, 0, 0, 0]);
  });

  it("an edge with no tls: mkcert (implicit), 'mkcert is not installed', a problem", () => {
    const rows = doctorRows(
      dist(
        "secrets:\n  provider: doppler\nedge:\n  org: acme\n  domain: acme.localhost\n",
      ),
    );
    expect(rows[0]).toMatchObject({
      selected: "doppler",
      available: false,
      reason: "The Doppler CLI (doppler) is not on PATH",
      problem: true,
    });
    expect(rows[1]).toMatchObject({
      selected: "mkcert",
      implicit: true,
      available: false,
      reason: "mkcert is not installed",
      problem: true,
      warnings: [
        "edge.tls is not set; defaulting to mkcert with a local CA. Set edge.tls explicitly.",
      ],
    });
    expect(spawned()).toEqual([0, 0, 0, 0]);
  });

  it("D9: usage lists its sources (implicit), never an invalid config", () => {
    const rows = doctorRows(dist("environments: [local]\n"));
    const row = rows.find((r) => r.kind === "usage");
    expect(row).toMatchObject({
      selected: "claude-code",
      implicit: true,
      problem: false,
    });
    expect(row!.reason ?? "").not.toMatch(/no selector/);
    const text = formatDoctor(rows, "Den").join("\n");
    expect(text).not.toMatch(/invalid config|no selector/);
    expect(spawned()).toEqual([0, 0, 0, 0]);
  });

  it("D9: a kind with no selector of its own lists every registered strategy", () => {
    registerStrategy({
      id: "d9-a",
      kind: "d9-kind",
      detect: () => ({ available: false, reason: "a is off" }),
      capabilities: {},
    });
    registerStrategy({
      id: "d9-b",
      kind: "d9-kind",
      detect: () => ({ available: true }),
      capabilities: {},
    });
    const row = doctorRows(dist("environments: [local]\n")).find(
      (r) => r.kind === "d9-kind",
    );
    expect(row).toMatchObject({
      selected: "d9-a, d9-b",
      implicit: true,
      available: true,
      problem: false,
    });
  });

  it("lists the session backend (den-pty); unavailable is never a problem", () => {
    const row = doctorRows(dist("environments: [local]\n")).find(
      (r) => r.kind === "session-backend",
    );
    expect(row).toMatchObject({
      selected: "den-pty",
      implicit: true,
      problem: false,
    });
    if (!row!.available) expect(row!.reason).toMatch(/node-pty/);
    expect(spawned()).toEqual([0, 0, 0, 0]);
  });

  it("lists the agent runtime (den-claude), found on PATH without running it", () => {
    const row = doctorRows(dist("environments: [local]\n")).find(
      (r) => r.kind === "runtime",
    );
    expect(row).toMatchObject({
      selected: "den-claude",
      implicit: true,
      available: false,
      // AG-0.1: the search says how far it looked (no login shell or
      // install directories in a test: tests/setup.ts).
      reason: expect.stringMatching(
        /^claude not found \(searched \d+ director/,
      ),
      problem: false,
    });
    expect(spawned()).toEqual([0, 0, 0, 0]);
  });

  it("the implicit secrets default is never a problem (used only when asked)", () => {
    const [secrets] = doctorRows(dist("environments: [local]\n"));
    expect(secrets).toMatchObject({
      selected: "doppler",
      implicit: true,
      available: false,
      problem: false,
    });
  });

  it("an invalid edge.tls is reported, not thrown", () => {
    const [, tls] = doctorRows(
      dist("edge:\n  org: acme\n  domain: acme.localhost\n  tls: acme\n"),
    );
    expect(tls).toMatchObject({ selected: "", problem: true });
    expect(tls.reason).toMatch(/the built-ins are none, mkcert, files/);
  });

  it("prints one line per kind, and each warning under it", () => {
    const lines = formatDoctor(
      [
        {
          kind: "secrets",
          selected: "none",
          implicit: false,
          available: true,
          reason: "no secrets backend configured",
          problem: false,
          warnings: [],
        },
        {
          kind: "tls",
          selected: "mkcert",
          implicit: true,
          available: false,
          reason: "mkcert is not installed",
          problem: true,
          warnings: ["edge.tls is not set; …"],
        },
      ],
      "Acme",
    );
    expect(lines).toEqual([
      "Acme doctor: strategies",
      "",
      "  secrets  none                 ✓ available: no secrets backend configured",
      "  tls      mkcert (implicit)    ✗ unavailable: mkcert is not installed",
      "    ⚠ edge.tls is not set; …",
    ]);
  });
});

describe("doctor's agents note", () => {
  const NOTE =
    "  ℹ agents are configured or have run here: run `acme doctor --probe` to verify agent env isolation";
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-notes-"));
    created.push(d);
    return d;
  };
  const created: string[] = [];
  afterAll(() => {
    for (const d of created.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  it("is shown when agents are configured, informational only", () => {
    const state = tmp();
    for (const agents of [
      { persona_packs: ["personas"] },
      { max_concurrent: 2 },
      { planner: { grants: ["south"] } },
    ])
      expect(
        doctorNotes(
          "acme",
          agentsConfigured({ environments: [], agents }, state),
        ),
      ).toContain(NOTE);
  });

  it("is shown when an agent record exists", () => {
    const state = tmp();
    fs.mkdirSync(path.join(state, "agents"));
    fs.writeFileSync(
      path.join(state, "agents", "planner.json"),
      JSON.stringify({ id: "planner", session: { id: "x" } }),
    );
    expect(
      doctorNotes("acme", agentsConfigured({ environments: [] }, state)),
    ).toContain(NOTE);
  });

  it("is absent otherwise", () => {
    const state = tmp();
    for (const cfg of [
      { environments: [] },
      { environments: [], agents: {} },
      null,
    ])
      expect(doctorNotes("acme", agentsConfigured(cfg, state))).toEqual([]);
  });
});

describe("doctor names a bad agents: or sessions: key and carries on", () => {
  it("one ✗ line per section, with file and key; no values", () => {
    dist(
      "environments: [local]\nagents:\n  helpers:\n    collapse_done: 5\nsessions:\n  max_concurrent: hunter2\n",
    );
    const r = configLines("Acme");
    expect(r.problem).toBe(true);
    expect(r.lines.filter((l) => l.includes("✗"))).toEqual([
      "  agents  ✗  config/den.yml: agents.helpers.collapse_done: unknown key (agents.helpers takes active_minutes, row_max, read_max_mb)",
      "  sessions  ✗  config/den.yml: sessions.max_concurrent: must be a whole number of at least 1",
    ]);
    expect(r.lines.join("\n")).not.toContain("hunter2");
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["config:agents", "fail"],
      ["config:sessions", "fail"],
    ]);
  });

  it("nothing shown when both are fine", () => {
    dist("environments: [local]\nagents:\n  max_concurrent: 2\n");
    const r = configLines("Acme");
    expect([r.problem, r.lines]).toEqual([false, []]);
    expect(r.checks.map((c) => c.status)).toEqual(["ok", "ok"]);
  });
});

describe("doctor notes agents.helpers.collapse_done_minutes (0.4.29: ignored)", () => {
  it("an ℹ line, not a problem", () => {
    dist(
      "environments: [local]\nagents:\n  helpers:\n    collapse_done_minutes: 60\n",
    );
    const r = configLines("Acme");
    expect(r.problem).toBe(false);
    expect(r.lines.filter((l) => l.includes("ℹ"))).toEqual([
      "  agents  ℹ  agents.helpers.collapse_done_minutes no longer does anything (0.4.29): remove it. Finished helpers stay until a person clears them (Clear done).",
    ]);
  });
});
