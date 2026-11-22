/**
 * Issue 636: the test-person path, the parts that need no server.
 *  - In test-person mode the CLI sends the person's token and the
 *    test-person header, even from an agent's environment; never the
 *    agent's token.
 *  - Every audit row made on that path says so (`via: "test-person"`):
 *    the server's (a request that came by it) and the CLI's own.
 *  - The CLI refuses `--test-person` on an install not marked a test bed,
 *    before anything runs, and when the test bed's server refuses it.
 *  - `doctor` says whether the install is a test bed.
 *  - `create --test-bed` marks a new install (install time).
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  auditVia,
  dropAgentMarkers,
  inTestPersonScope,
  TEST_PERSON_HEADER,
  useTestPerson,
} from "../../../src/shared/test-person.js";
import {
  cliAuthHeaders,
  ensureWebSecret,
  personToken,
} from "../../../src/shared/web-secret.js";
import { recordAction, setAuditFile } from "../../../src/ui/server/audit.js";
import { auditConfig } from "../../../src/shared/config-audit.js";
import {
  enterTestPerson,
  testBedLines,
  testPersonAsked,
} from "../../../src/ui/cli/test-person.js";
import {
  parseCreateArgs,
  renderDistribution,
} from "../../../src/ui/cli/create.js";
import { parseCliArgs } from "../../../src/ui/cli/flag-parser.js";
import { isPersonCredentialEnv } from "../../../src/shared/actor-token.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-tp636-")));
});
afterEach(() => {
  useTestPerson(false);
  setAuditFile(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const AGENT_ENV = (): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin",
  DEN_AGENT: "stub",
  DEN_ACTOR_TOKEN: "den_at_" + "a".repeat(43),
});

describe("the CLI's credential on the test-person path", () => {
  it("outside it, an agent's environment sends the agent's token", () => {
    ensureWebSecret(tmp);
    expect(cliAuthHeaders(tmp, AGENT_ENV())).toEqual({
      Authorization: `Bearer den_at_${"a".repeat(43)}`,
    });
  });

  it("on it, the person's token and the test-person header, never the agent's", () => {
    const secret = ensureWebSecret(tmp);
    useTestPerson(true);
    expect(cliAuthHeaders(tmp, AGENT_ENV())).toEqual({
      Authorization: `Bearer ${personToken(secret)}`,
      [TEST_PERSON_HEADER]: "1",
    });
  });

  it("the agent markers are taken out of the CLI's own environment, nothing else", () => {
    const env = { ...AGENT_ENV(), DEN_ACTOR_TOKEN_FILE: "/x", HOME: "/h" };
    dropAgentMarkers(env);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h" });
  });

  it("`--test-person` is a global flag, taken off the command's args", () => {
    const p = parseCliArgs(["--test-person", "notifications", "clear"]);
    expect(p).toMatchObject({
      command: "notifications",
      args: ["clear"],
      flags: { testPerson: true },
    });
    expect(() => parseCliArgs(["--test-person"])).toThrow(/command/);
  });
});

describe("audit rows name the test-person path", () => {
  it("a server row made in a test-person request has via test-person; others none", () => {
    const f = path.join(tmp, "audit.jsonl");
    setAuditFile(f);
    const plain = recordAction(
      null,
      { verb: "x", detail: "plain" },
      "person:p",
    );
    const tp = inTestPersonScope(() =>
      recordAction(null, { verb: "x", detail: "tp" }, "person:p"),
    );
    expect(plain.via).toBeUndefined();
    expect(tp).toMatchObject({ principal: "person:p", via: "test-person" });
    expect(auditVia()).toBeUndefined();
    const rows = fs
      .readFileSync(f, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r.via)).toEqual([undefined, "test-person"]);
  });

  it("a scope stays across awaits", async () => {
    const v = await inTestPersonScope(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return auditVia();
    });
    expect(v).toBe("test-person");
  });

  it("the CLI's own rows on the path say so", () => {
    useTestPerson(true);
    auditConfig({ verb: "agents", detail: "stop stub in p: stopped" }, tmp);
    const row = JSON.parse(
      fs.readFileSync(path.join(tmp, "audit.jsonl"), "utf-8").trim(),
    ) as Record<string, unknown>;
    expect(row).toMatchObject({ verb: "agents", via: "test-person" });
    expect(String(row.principal)).toMatch(/^person:/);
  });
});

describe("entering the test-person path", () => {
  const deps = (o: {
    mark: boolean;
    server?: { ok: true } | { ok: false; error: string };
  }) => {
    const env = AGENT_ENV();
    const calls: string[] = [];
    return {
      env,
      calls,
      d: {
        env,
        mark: () => o.mark,
        announce: async (command: string) => {
          calls.push(command);
          return o.server ?? { ok: true as const };
        },
      },
    };
  };

  it("not a test bed: refused with a clear error, the server never asked, nothing changed", async () => {
    const t = deps({ mark: false });
    await expect(enterTestPerson("notifications clear", t.d)).rejects.toThrow(
      /--test-person is refused: this install isn't a test bed/,
    );
    expect(t.calls).toEqual([]);
    expect(t.env.DEN_ACTOR_TOKEN).toBeDefined();
    expect(cliAuthHeaders(tmp, t.env).Authorization).toMatch(/den_at_/);
  });

  it("the test bed's server refuses (no launch flag, owned): refused, nothing changed", async () => {
    const t = deps({
      mark: true,
      server: { ok: false, error: "not a test bed (server)" },
    });
    await expect(enterTestPerson("agents stop", t.d)).rejects.toThrow(
      /not a test bed \(server\)/,
    );
    expect(t.calls).toEqual(["agents stop"]);
    expect(t.env.DEN_AGENT).toBe("stub");
  });

  it("a refusal leaves no tag for children", async () => {
    const t = deps({ mark: false });
    await expect(enterTestPerson("agents stop", t.d)).rejects.toThrow();
    expect(t.env.DEN_TEST_PERSON).toBeUndefined();
  });

  it("allowed: the children it starts inherit the path's tag", async () => {
    const t = deps({ mark: true });
    await enterTestPerson("agents stop", t.d);
    expect(t.env.DEN_TEST_PERSON).toBe("1");
    expect(testPersonAsked({ testPerson: undefined }, t.env)).toBe(true);
    expect(testPersonAsked({}, {})).toBe(false);
    expect(testPersonAsked({ testPerson: true }, {})).toBe(true);
  });

  it("the tag never reaches an agent's session (a person's credential there)", () => {
    expect(isPersonCredentialEnv("DEN_TEST_PERSON", "1")).toBe(true);
  });

  it("a test bed: the server is told, then the CLI acts as the person", async () => {
    const t = deps({ mark: true });
    ensureWebSecret(tmp);
    await enterTestPerson("agents stop", t.d);
    expect(t.calls).toEqual(["agents stop"]);
    expect(t.env.DEN_AGENT).toBeUndefined();
    expect(t.env.DEN_ACTOR_TOKEN).toBeUndefined();
    expect(cliAuthHeaders(tmp, t.env)).toMatchObject({
      [TEST_PERSON_HEADER]: "1",
    });
  });
});

describe("doctor shows whether the install is a test bed", () => {
  it("marked", () => {
    const r = testBedLines("Den", () => true, "config/den.yml");
    expect(r.lines.join("\n")).toMatch(/Test bed/);
    expect(r.lines.join("\n")).toMatch(/is a test bed/);
    expect(r.check).toMatchObject({ id: "test_bed", status: "ok" });
    expect(r.check.detail).toMatch(/--test-person/);
  });
  it("not marked", () => {
    const r = testBedLines("Den", () => false, "config/den.yml");
    expect(r.lines.join("\n")).toMatch(/not a test bed/);
    expect(r.check).toMatchObject({ id: "test_bed", status: "ok" });
    expect(r.check.detail).toMatch(/--test-person is refused/);
  });
  it("an unreadable config reads as not a test bed", () => {
    const r = testBedLines(
      "Den",
      () => {
        throw new Error("bad yaml");
      },
      "config/den.yml",
    );
    expect(r.check.detail).toMatch(/not a test bed/);
  });
});

describe("create --test-bed marks the install at install time", () => {
  it("writes web.test_install: true in the new org config", () => {
    const a = parseCreateArgs(["acme", "--test-bed"], tmp);
    expect(a.testBed).toBe(true);
    const files = renderDistribution({ ...a, denVersion: "1.2.3" });
    expect(files["config/acme.yml"]).toMatch(/^web:$/m);
    expect(files["config/acme.yml"]).toMatch(/^ {2}test_install: true$/m);
  });
  it("with --github-org, one web block holds both", () => {
    const a = parseCreateArgs(
      ["acme", "--test-bed", "--github-org", "example-org"],
      tmp,
    );
    const cfg = renderDistribution({ ...a, denVersion: "1.2.3" })[
      "config/acme.yml"
    ];
    expect(cfg.match(/^web:$/gm)).toHaveLength(1);
    expect(cfg).toMatch(/allowed_github_org: example-org/);
    expect(cfg).toMatch(/test_install: true/);
  });
  it("without it, no mark", () => {
    const a = parseCreateArgs(["acme"], tmp);
    const cfg = renderDistribution({ ...a, denVersion: "1.2.3" })[
      "config/acme.yml"
    ];
    expect(cfg).not.toMatch(/test_install/);
  });
});
