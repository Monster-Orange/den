/**
 * Issue 810: live checks sign in as a fixture person on a test install,
 * never as an agent with its identity stripped. The pure parts: the
 * test-install mark (the distribution config only, set by hand), the
 * fixture person's secret (made by a person, 0600, never printed), its
 * one-time sign-in code, and what a fixture session may never reach.
 * No secret or code is printed: a failure shows booleans and reasons.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkFixtureCode,
  FIXTURE_LABEL,
  FIXTURE_PRINCIPAL,
  fixtureLoginLink,
  fixturePersonPath,
  fixtureScopeRefusal,
  mintFixtureCode,
  readFixtureSecret,
  setupFixturePerson,
} from "../../../src/shared/fixture-person.js";
import {
  checkLoginCode,
  mintLoginCode,
  readWebAuthConfig,
} from "../../../src/shared/web-session.js";
import { ensureWebSecret } from "../../../src/shared/web-secret.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-fx-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

describe("the test-install mark (web.test_install)", () => {
  it("is off when nothing sets it", () => {
    expect(readWebAuthConfig(tmp).testInstall).toBe(false);
  });

  it("is on when the distribution config sets it to true", () => {
    write("config/den.yml", "web:\n  test_install: true\n");
    expect(readWebAuthConfig(tmp).testInstall).toBe(true);
  });

  it("is never read from user.yml (what Settings writes): ignored there, and said so", () => {
    write("config/local/user.yml", "web:\n  test_install: true\n");
    const c = readWebAuthConfig(tmp);
    expect(c.testInstall).toBe(false);
    expect(c.testInstallInUser).toBe(true);
  });

  it("must be true or false", () => {
    write("config/den.yml", "web:\n  test_install: yes please\n");
    expect(() => readWebAuthConfig(tmp)).toThrow(/web.test_install/);
  });
});

describe("making the fixture person (a person, on a test install)", () => {
  it("a real install refuses it, and writes nothing", () => {
    const r = setupFixturePerson(tmp, { testInstall: false, agent: false });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("not_test_install");
    expect(fs.existsSync(fixturePersonPath(tmp))).toBe(false);
  });

  it("an agent is refused, even on a test install, and nothing is written", () => {
    const r = setupFixturePerson(tmp, { testInstall: true, agent: true });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("person_only");
    expect(fs.existsSync(fixturePersonPath(tmp))).toBe(false);
  });

  it("a person on a test install makes it: a 0600 file in the state dir, its value never returned", () => {
    const r = setupFixturePerson(tmp, { testInstall: true, agent: false });
    expect(r.ok).toBe(true);
    const st = fs.statSync(fixturePersonPath(tmp));
    expect(st.mode & 0o777).toBe(0o600);
    const value = fs.readFileSync(fixturePersonPath(tmp), "utf-8").trim();
    expect(value.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(r).includes(value)).toBe(false);
    expect(readFixtureSecret(tmp)).not.toBeNull();
  });

  it("a secret others can read is no secret: refused (null)", () => {
    setupFixturePerson(tmp, { testInstall: true, agent: false });
    fs.chmodSync(fixturePersonPath(tmp), 0o644);
    expect(readFixtureSecret(tmp)).toBeNull();
  });
});

describe("the fixture sign-in code", () => {
  it("round-trips with the fixture secret, and is one the person's sign-in never takes", () => {
    setupFixturePerson(tmp, { testInstall: true, agent: false });
    const secret = readFixtureSecret(tmp)!;
    const code = mintFixtureCode(secret);
    expect(checkFixtureCode(code, secret).ok).toBe(true);
    // The person's own login code check refuses it (another shape and key).
    expect(checkLoginCode(code, ensureWebSecret(tmp)).ok).toBe(false);
    // And a person's login code is never a fixture code.
    const personCode = mintLoginCode(ensureWebSecret(tmp));
    expect(checkFixtureCode(personCode, secret).ok).toBe(false);
  });

  it("expires", () => {
    setupFixturePerson(tmp, { testInstall: true, agent: false });
    const secret = readFixtureSecret(tmp)!;
    const code = mintFixtureCode(secret, 1_000, 60_000);
    const r = checkFixtureCode(code, secret, 1_000 + 61_000);
    expect(r.ok ? "ok" : r.reason).toBe("expired");
  });

  it("fixtureLoginLink: refused on a real install, refused with no fixture person, else /auth?fixture=", () => {
    const origin = "https://den.example.test";
    const real = fixtureLoginLink(tmp, { testInstall: false, origin });
    expect(real.ok).toBe(false);
    expect(real.ok ? "" : real.code).toBe("not_test_install");
    const none = fixtureLoginLink(tmp, { testInstall: true, origin });
    expect(none.ok ? "" : none.code).toBe("no_fixture_person");
    setupFixturePerson(tmp, { testInstall: true, agent: false });
    const ok = fixtureLoginLink(tmp, {
      testInstall: true,
      origin,
      next: "/agents",
    });
    expect(ok.ok).toBe(true);
    const url = new URL(ok.ok ? ok.url : "http://x/");
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/auth");
    expect(url.searchParams.has("fixture")).toBe(true);
    expect(url.searchParams.get("next")).toBe("/agents");
  });
});

describe("what a fixture session never reaches", () => {
  it("is named the fixture person, never the human", () => {
    expect(FIXTURE_PRINCIPAL).toBe("fixture:person");
    expect(FIXTURE_LABEL).toBe("fixture person");
  });

  it.each([
    ["POST", "/api/hub/connect"],
    ["POST", "/api/hub/disconnect"],
    ["POST", "/api/hub/sync"],
    ["POST", "/api/workspaces/notes/hub-project"],
    ["POST", "/api/web/fixture-person"],
    ["POST", "/api/web/pair"],
    ["POST", "/api/web/approve"],
    ["POST", "/api/web/owner/link"],
    ["POST", "/api/approvals/a1/decide"],
  ])("%s %s is refused", (method, p) => {
    expect(fixtureScopeRefusal(method, p)).toMatch(/fixture person/);
  });

  it.each([
    ["GET", "/api/agents"],
    ["GET", "/api/session"],
    ["GET", "/api/hub"],
    ["POST", "/api/agents/a1/say"],
    ["POST", "/api/settings"],
  ])("%s %s is not refused here (the bed's own pages and writes)", (m, p) => {
    expect(fixtureScopeRefusal(m, p)).toBeNull();
  });
});
