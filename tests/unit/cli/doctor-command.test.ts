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
  hubProjectLines,
  hubGithubLines,
  strategyCheck,
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
          notes: [
            "access log on: masked into /x/edge-access.log, and kept up with",
          ],
        },
      ],
      "Acme",
    );
    expect(lines).toEqual([
      "Acme doctor: strategies",
      "",
      "  secrets  none                 ✓ available: no secrets backend configured",
      "  tls      mkcert (implicit)    ✗ unavailable: mkcert is not installed",
      "    ✓ access log on: masked into /x/edge-access.log, and kept up with",
      "    ⚠ edge.tls is not set; …",
    ]);
  });
});

describe("#331: doctor's line for the edge image", () => {
  const FIX = "Set edge.image to traefik:v3.7.17, Den's default.";
  const tlsRow = (image: string) =>
    doctorRows(
      dist(
        `environments: [local]\nedge:\n  org: acme\n  domain: acme.localhost\n  tls: none\n  image: "${image}"\n`,
      ),
    ).find((r) => r.kind === "tls")!;
  const imageLines = (image: string) =>
    formatDoctor([tlsRow(image)], "Acme").filter((l) => l.includes(image));

  it("Traefik v2.11: a warning naming what's missing, and the fix", () => {
    const row = tlsRow("traefik:v2.11");
    expect(row.warnings).toContain(
      `edge.image traefik:v2.11 is Traefik v2: the access log has no request ids (OTLP tracing needs v3). ${FIX}`,
    );
    expect(imageLines("traefik:v2.11")).toEqual([
      `    ⚠ edge.image traefik:v2.11 is Traefik v2: the access log has no request ids (OTLP tracing needs v3). ${FIX}`,
    ]);
    expect(strategyCheck(row).status).toBe("warn");
  });

  it("Traefik v3.7.17: OK, no warning", () => {
    const row = tlsRow("traefik:v3.7.17");
    expect(row.warnings).toEqual([]);
    expect(imageLines("traefik:v3.7.17")).toEqual([
      "    ✓ edge.image traefik:v3.7.17 is Traefik v3: every flag Den sets works",
    ]);
    expect(strategyCheck(row).status).toBe("ok");
  });

  it.each([
    "traefik:latest",
    "traefik@sha256:4f1c2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
  ])("%s: Den can't tell, so it leaves out version-only flags", (image) => {
    const row = tlsRow(image);
    const want = `edge.image ${image}: Den can't tell which Traefik version it is, so it leaves out the flags only some versions take (request ids in the access log). ${FIX}`;
    expect(row.warnings).toContain(want);
    expect(imageLines(image)).toEqual([`    ⚠ ${want}`]);
    expect(strategyCheck(row).status).toBe("warn");
  });
});

describe("issue 519: the v3 hint checks for Traefik v2 rule syntax first", () => {
  const FIX = "Set edge.image to traefik:v3.7.17, Den's default.";
  const V2_RULE = "HostRegexp(`{sub:[a-z]+}.acme.localhost`)";
  // A stack whose compose file carries Traefik labels, and an included
  // dynamic file: both read from disk, never from docker.
  const fixture = (labelRule: string, fileRule?: string) => {
    const repo = path.join(ROOT, "repos", "app");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(repo, "docker-compose.yml"),
      [
        "services:",
        "  web:",
        "    image: nginx",
        "    labels:",
        `      - "traefik.http.routers.web.rule=${labelRule}"`,
        "",
      ].join("\n"),
    );
    const inc = path.join(ROOT, "edge-dynamic");
    fs.rmSync(inc, { recursive: true, force: true });
    fs.mkdirSync(inc, { recursive: true });
    if (fileRule)
      fs.writeFileSync(
        path.join(inc, "extra.yml"),
        `http:\n  routers:\n    extra:\n      rule: "${fileRule}"\n      service: x\n`,
      );
    return doctorRows(
      dist(
        [
          "repos_root: repos",
          "environments: [local]",
          "stacks:",
          "  app:",
          "    repo: app",
          "edge:",
          "  org: acme",
          "  domain: acme.localhost",
          "  tls: none",
          '  image: "traefik:v2.11"',
          "  include: edge-dynamic",
          "",
        ].join("\n"),
      ),
    ).find((r) => r.kind === "tls")!;
  };

  it("a v2 named-group HostRegexp label: not the bare hint; names where, and both ways", () => {
    const before = spawned();
    const row = fixture(V2_RULE);
    const text = row.warnings.join("\n");
    expect(text).not.toContain(FIX);
    expect(text).toContain("v2 syntax");
    expect(text).toContain("app/docker-compose.yml");
    expect(text).toContain("service web");
    expect(text).toContain(V2_RULE);
    expect(text).toContain("--core.defaultRuleSyntax=v2");
    expect(text).toContain("edge.args");
    expect(text).toMatch(/rewrite/i);
    expect(strategyCheck(row).status).toBe("warn");
    expect(spawned()).toEqual(before);
  });

  it("a v2 rule in an included dynamic file is named by its file and router", () => {
    const row = fixture("Host(`web.acme.localhost`)", "Headers(`X-Env`, `dev`)");
    const text = row.warnings.join("\n");
    expect(text).not.toContain(FIX);
    expect(text).toContain("extra.yml");
    expect(text).toContain("router extra");
    expect(text).toContain("Headers(`X-Env`, `dev`)");
  });

  it("no v2 rules anywhere: the plain hint stays", () => {
    const row = fixture(
      "Host(`web.acme.localhost`)",
      "HostRegexp(`^[a-z]+\\\\.acme\\\\.localhost$`)",
    );
    expect(row.warnings).toContain(
      `edge.image traefik:v2.11 is Traefik v2: the access log has no request ids (OTLP tracing needs v3). ${FIX}`,
    );
    expect(row.warnings.join("\n")).not.toContain("defaultRuleSyntax");
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
      ["config:web", "ok"],
    ]);
  });

  it("nothing shown when both are fine", () => {
    dist("environments: [local]\nagents:\n  max_concurrent: 2\n");
    const r = configLines("Acme");
    expect([r.problem, r.lines]).toEqual([false, []]);
    expect(r.checks.map((c) => c.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("#257: a bad web.keep_alive_seconds is one ✗ line naming the key", () => {
    dist("environments: [local]\nweb:\n  keep_alive_seconds: 0\n");
    const r = configLines("Acme");
    expect(r.problem).toBe(true);
    expect(r.lines.filter((l) => l.includes("✗"))).toEqual([
      "  web  ✗  web.keep_alive_seconds: seconds, 1 to 3600 (got 0)",
    ]);
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

describe("hubProjectLines (H5)", () => {
  it("Hub not connected, or no projects: nothing", () => {
    expect(
      hubProjectLines(false, [{ ws: "north", link: null }], "acme"),
    ).toEqual({ lines: [], checks: [] });
    expect(hubProjectLines(true, [], "acme")).toEqual({
      lines: [],
      checks: [],
    });
  });

  it("linked is ok; not linked warns with the command that shows Hub's suggestions", () => {
    const r = hubProjectLines(
      true,
      [
        { ws: "north", link: { slug: "back-office", name: "Back office" } },
        { ws: "south", link: null },
      ],
      "acme",
    );
    expect(r.checks).toEqual([
      {
        id: "hub:project:north",
        status: "ok",
        detail: "north: linked to Hub project Back office (back-office)",
      },
      {
        id: "hub:project:south",
        status: "warn",
        detail:
          "south: not linked to a Hub project, so Hub files its agents' work in Unfiled",
        fix: "acme hub link -p south",
      },
    ]);
    expect(r.lines[0]).toMatch(/^ {2}hub project {2}✓ {2}north: linked/);
    expect(r.lines[1]).toContain("`acme hub link -p south`");
    expect(r.lines[1]).toContain("⚠");
    // One unlinked: no "in one go" line.
    expect(r.lines).toHaveLength(2);
  });

  it("0.4.44: a project that lost its link (no unlink asked) warns, connected or not", () => {
    const lost = { slug: "back-office", at: "2026-11-12T10:00:00.000Z" };
    for (const connected of [true, false]) {
      const r = hubProjectLines(
        connected,
        [{ ws: "north", link: null, lost }],
        "acme",
      );
      expect(r.checks).toEqual([
        {
          id: "hub:project:north",
          status: "warn",
          detail:
            "north: was linked to Hub project back-office (seen 2026-11-12T10:00:00.000Z) and has no link now, with no unlink asked. The audit (audit.jsonl, verb hub-link and config-write) says which writer dropped it",
          fix: "acme hub link -p north back-office",
        },
      ]);
      expect(r.lines[0]).toContain("⚠");
      expect(r.lines[0]).toContain("`acme hub link -p north back-office`");
    }
  });

  it("#68: two or more unlinked: one line names hub link --suggested", () => {
    const r = hubProjectLines(
      true,
      [
        { ws: "north", link: null },
        { ws: "south", link: null },
      ],
      "acme",
    );
    expect(r.lines).toHaveLength(3);
    expect(r.lines[2]).toContain("2 projects aren't linked");
    expect(r.lines[2]).toContain("`acme hub link --suggested`");
    expect(r.checks).toHaveLength(2);
  });
});

describe("hubGithubLines (H5)", () => {
  it("not connected: nothing; all repos ✓; none and some warn with GitHub's link", () => {
    expect(hubGithubLines(null)).toEqual({ lines: [], checks: [] });
    const r = hubGithubLines({
      orgs: [
        { org: "acme-co", access: "all", covered: 2, total: 2 },
        {
          org: "beta-co",
          access: "none",
          covered: 0,
          total: 1,
          installUrl: "https://github.com/apps/den-hub/installations/new",
        },
        {
          org: "gamma-co",
          access: "some",
          covered: 1,
          total: 4,
          manageUrl:
            "https://github.com/organizations/gamma-co/settings/installations/9",
        },
      ],
    });
    expect(r.lines[0]).toMatch(/✓ {2}acme-co: Den Hub can read all repos$/);
    expect(r.lines[1]).toContain(
      "⚠  beta-co: Den Hub can read no repos (no access). Give Den Hub access: https://github.com/apps/den-hub/installations/new",
    );
    expect(r.lines[2]).toContain(
      "gamma-co: Den Hub can read 1 of 4 repos. Change repos: https://github.com/organizations/gamma-co/settings/installations/9",
    );
    expect(r.checks.map((c) => c.status)).toEqual(["ok", "warn", "warn"]);
  });

  it("Hub couldn't answer: one warning in words", () => {
    expect(
      hubGithubLines({ error: "Hub did not answer in 5000 ms" }).checks[0],
    ).toMatchObject({
      id: "hub:github",
      status: "warn",
    });
  });
});
