/**
 * Issue 810: live checks sign in as a fixture person on a test install,
 * never as an agent with its identity stripped. The pure parts: the
 * test-install mark and what binds it to a test install, the fixture
 * person's secret (made by the server for a person, sealed with the
 * install's own secret, 0600, never printed), its one-time sign-in code,
 * the session's lifetime, and the short list a fixture session may reach.
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
  FIXTURE_SESSION_MINUTES,
  fixtureKeyFingerprint,
  fixtureLoginLink,
  fixturePersonPath,
  fixtureScopeRefusal,
  fixtureSessionExpired,
  mintFixtureCode,
  readFixtureKey,
  setupFixturePerson,
  personsOnInstall,
  testInstallBinding,
  testInstallRead,
  verifiedFixtureKey,
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
const secret = () => ensureWebSecret(tmp);
const setUp = () =>
  setupFixturePerson(tmp, {
    testInstall: true,
    agent: false,
    webSecret: secret(),
  });

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

describe("what binds the mark to a test install", () => {
  const ok = {
    mark: true,
    launchFlag: true,
    defaultStateDir: false,
    owned: false,
  };
  it("holds only with the mark, the launch flag, its own state dir and no owner", () => {
    expect(testInstallBinding(ok)).toEqual({ ok: true });
  });
  it.each([
    ["no_mark", { mark: false }],
    ["no_launch_flag", { launchFlag: false }],
    ["default_state_dir", { defaultStateDir: true }],
    ["owned", { owned: true }],
  ])("refused: %s", (why, change) => {
    expect(testInstallBinding({ ...ok, ...change })).toEqual({
      ok: false,
      why,
    });
  });
});

// Issue 823: Settings reads why an install isn't a test install, the
// first missing condition, and the launcher's flag in this distribution's
// own prefix (never a hard-coded one).
describe("what Settings reads about the test install", () => {
  const ok = {
    mark: true,
    launchFlag: true,
    defaultStateDir: false,
    owned: false,
  };
  const read = (change: Partial<typeof ok>, ready: boolean) =>
    testInstallRead(testInstallBinding({ ...ok, ...change }), {
      ready,
      envPrefix: "ACME",
    });
  it("a test install, not set up: no reason", () => {
    expect(read({}, false)).toEqual({
      ok: true,
      testInstall: true,
      ready: false,
    });
  });
  it("a test install, set up: ready, no reason", () => {
    expect(read({}, true)).toEqual({
      ok: true,
      testInstall: true,
      ready: true,
    });
  });
  it.each([
    ["no_mark", { mark: false }],
    ["default_state_dir", { defaultStateDir: true }],
    ["owned", { owned: true }],
  ])("not a test install: %s, never ready", (why, change) => {
    expect(read(change, true)).toEqual({
      ok: true,
      testInstall: false,
      ready: false,
      why,
    });
  });
  it("no launch flag: names the variable with this distribution's prefix", () => {
    expect(read({ launchFlag: false }, false)).toEqual({
      ok: true,
      testInstall: false,
      ready: false,
      why: "no_launch_flag",
      launchFlag: "ACME_TEST_INSTALL",
    });
  });
  it("the first missing condition wins", () => {
    expect(read({ launchFlag: false, owned: true }, false).why).toBe(
      "no_launch_flag",
    );
  });
});

describe("making the fixture person (the server, for a person, on a test install)", () => {
  it("a real install refuses it, and writes nothing", () => {
    const r = setupFixturePerson(tmp, {
      testInstall: false,
      agent: false,
      webSecret: secret(),
    });
    expect(r.ok ? "" : r.code).toBe("not_test_install");
    expect(fs.existsSync(fixturePersonPath(tmp))).toBe(false);
  });

  it("an agent is refused, even on a test install, and nothing is written", () => {
    const r = setupFixturePerson(tmp, {
      testInstall: true,
      agent: true,
      webSecret: secret(),
    });
    expect(r.ok ? "" : r.code).toBe("person_only");
    expect(fs.existsSync(fixturePersonPath(tmp))).toBe(false);
  });

  it("a person on a test install makes it: 0600, sealed, its value never returned", () => {
    const r = setUp();
    expect(r.ok).toBe(true);
    expect(fs.statSync(fixturePersonPath(tmp)).mode & 0o777).toBe(0o600);
    const key = readFixtureKey(tmp);
    expect(key).not.toBeNull();
    expect(JSON.stringify(r).includes(key!.toString())).toBe(false);
    expect(verifiedFixtureKey(tmp, secret())).not.toBeNull();
  });

  it("a key file written by hand (not sealed by the server) is refused", () => {
    write("fixture-person.key", `${"A".repeat(43)}\n`);
    fs.chmodSync(fixturePersonPath(tmp), 0o600);
    expect(verifiedFixtureKey(tmp, secret())).toBeNull();
  });

  it("a sealed key copied to another install (another secret) is refused there", () => {
    setUp();
    const other = Buffer.alloc(32, 7);
    expect(verifiedFixtureKey(tmp, other)).toBeNull();
  });

  it("a key others can read is no secret: refused", () => {
    setUp();
    fs.chmodSync(fixturePersonPath(tmp), 0o644);
    expect(verifiedFixtureKey(tmp, secret())).toBeNull();
    expect(readFixtureKey(tmp)).toBeNull();
  });
});

describe("the fixture sign-in code", () => {
  it("round-trips with the fixture key, and is one the person's sign-in never takes", () => {
    setUp();
    const key = verifiedFixtureKey(tmp, secret())!;
    const code = mintFixtureCode(readFixtureKey(tmp)!);
    expect(checkFixtureCode(code, key).ok).toBe(true);
    expect(checkLoginCode(code, secret()).ok).toBe(false);
    expect(checkFixtureCode(mintLoginCode(secret()), key).ok).toBe(false);
  });

  it("expires", () => {
    setUp();
    const key = readFixtureKey(tmp)!;
    const code = mintFixtureCode(key, 1_000, 60_000);
    const r = checkFixtureCode(code, key, 1_000 + 61_000);
    expect(r.ok ? "ok" : r.reason).toBe("expired");
  });

  it("fixtureLoginLink: refused on a real install, refused with no fixture person, else /auth?fixture=", () => {
    const origin = "https://den.example.test";
    const real = fixtureLoginLink(tmp, { testInstall: false, origin });
    expect(real.ok ? "" : real.code).toBe("not_test_install");
    const none = fixtureLoginLink(tmp, { testInstall: true, origin });
    expect(none.ok ? "" : none.code).toBe("no_fixture_person");
    setUp();
    const ok = fixtureLoginLink(tmp, {
      testInstall: true,
      origin,
      next: "/agents",
    });
    const url = new URL(ok.ok ? ok.url : "http://x/");
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/auth");
    expect(url.searchParams.has("fixture")).toBe(true);
    expect(url.searchParams.get("next")).toBe("/agents");
  });
});

describe("a fixture session's lifetime", () => {
  const MIN = 60_000;
  it("has a short default", () => {
    expect(FIXTURE_SESSION_MINUTES).toBeGreaterThan(0);
    expect(FIXTURE_SESSION_MINUTES).toBeLessThanOrEqual(240);
  });
  it("ends after it", () => {
    expect(fixtureSessionExpired(0, 59 * MIN, 60)).toBe(false);
    expect(fixtureSessionExpired(0, 60 * MIN, 60)).toBe(true);
  });
  it("is read from web.fixture_session_minutes, within bounds", () => {
    expect(readWebAuthConfig(tmp).fixtureSessionMinutes).toBe(
      FIXTURE_SESSION_MINUTES,
    );
    write("config/den.yml", "web:\n  fixture_session_minutes: 15\n");
    expect(readWebAuthConfig(tmp).fixtureSessionMinutes).toBe(15);
    write("config/den.yml", "web:\n  fixture_session_minutes: 0\n");
    expect(() => readWebAuthConfig(tmp)).toThrow(/web.fixture_session_minutes/);
  });
});

describe("what a fixture session may reach: an allow-list", () => {
  it("is named the fixture person, never the human", () => {
    expect(FIXTURE_PRINCIPAL).toBe("fixture:person");
    expect(FIXTURE_LABEL).toBe("fixture person");
  });

  it.each([
    ["GET", "/settings", null],
    ["GET", "/agents", null],
    ["GET", "/theme.css", null],
    ["GET", "/api/session", "readonly"],
    ["GET", "/api/notifications", "readonly"],
    ["GET", "/api/hub", "readonly"],
    ["POST", "/api/settings", "mutating"],
    ["POST", "/api/session/logout", "mutating"],
    ["POST", "/api/notifications/read", "mutating"],
    ["POST", "/api/workspaces/notes/agents/a1/stop", "mutating"],
  ] as const)("%s %s passes", (m, p, cls) => {
    expect(fixtureScopeRefusal(m, p, cls)).toBeNull();
  });

  it.each([
    ["POST", "/api/local-dev", "mutating"],
    ["POST", "/api/hub/connect", "mutating"],
    ["POST", "/api/hub/sync", "mutating"],
    ["POST", "/api/workspaces/notes/hub-project", "mutating"],
    ["POST", "/api/web/fixture-person", "mutating"],
    ["POST", "/api/web/pair", "shell-grade"],
    ["POST", "/api/web/approve", "shell-grade"],
    ["POST", "/api/approvals/a1/decide", "mutating"],
    ["POST", "/api/sudo-password", "mutating"],
    ["GET", "/api/sessions/s1/io", "shell-grade"],
    ["GET", "/api/run", "mutating"],
    ["GET", "/api/hub/github", "readonly"],
    ["GET", "/api/web/sessions", "shell-grade"],
    ["GET", "/api/nowhere", null],
    ["DELETE", "/api/workspaces", "mutating"],
    // Hardening: agent writes that are refused to a fixture session anyway.
    ["POST", "/api/workspaces/notes/agents/a1/say", "mutating"],
    ["POST", "/api/workspaces/notes/agents/a1/restart", "mutating"],
  ] as const)("%s %s is refused", (m, p, cls) => {
    expect(fixtureScopeRefusal(m, p, cls)).toMatch(/fixture person/);
  });
});

describe("the fixture key's fingerprint (a fixture session is bound to the key it signed in with)", () => {
  it("is a hash, never the key, and differs per key", () => {
    const a = Buffer.from("a".repeat(43));
    const b = Buffer.from("b".repeat(43));
    const fa = fixtureKeyFingerprint(a);
    expect(fa).toBe(fixtureKeyFingerprint(Buffer.from("a".repeat(43))));
    expect(fa).not.toBe(fixtureKeyFingerprint(b));
    expect(fa.includes("a".repeat(16))).toBe(false);
    expect(fa).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("issue 823: who counts as a person on the install", () => {
  const S = (via: string | undefined, key: string, testOperator = false) => ({
    via,
    key,
    testOperator,
  });
  it("every person's sign-in counts: link, GitHub, claim, code, and an old link", () => {
    for (const via of ["link", "github", "claim", "code", undefined])
      expect(personsOnInstall({ sessions: [S(via, "k1")], owner: false })).toBe(
        true,
      );
  });
  it("the caller's own sign-in never counts for them, whatever its kind", () => {
    for (const via of ["link", "github", "claim", "code", undefined])
      expect(
        personsOnInstall({
          sessions: [S(via, "mine")],
          owner: false,
          except: "mine",
        }),
      ).toBe(false);
  });
  it("someone else's sign-in still counts while the caller's is exempt", () => {
    expect(
      personsOnInstall({
        sessions: [S("github", "mine"), S("code", "theirs")],
        owner: false,
        except: "mine",
      }),
    ).toBe(true);
  });
  it("a claimed owner always counts, even with the caller's sign-in exempt", () => {
    expect(
      personsOnInstall({
        sessions: [S("claim", "mine")],
        owner: true,
        except: "mine",
      }),
    ).toBe(true);
  });
  it("the sign-in that pressed Set up test person never counts, whatever its kind", () => {
    for (const via of ["link", "github", "claim", "code", undefined])
      expect(
        personsOnInstall({ sessions: [S(via, "op", true)], owner: false }),
      ).toBe(false);
  });
  it("a claimed owner counts even when the presser's sign-in is exempt", () => {
    expect(
      personsOnInstall({ sessions: [S("claim", "op", true)], owner: true }),
    ).toBe(true);
  });
  it("the link that pressed Set up test person, and the fixture, never count", () => {
    expect(
      personsOnInstall({
        sessions: [S("link", "op", true), S("fixture", "fx")],
        owner: false,
      }),
    ).toBe(false);
  });
});
