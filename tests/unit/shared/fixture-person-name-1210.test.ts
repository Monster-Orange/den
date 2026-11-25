/**
 * Issue 1210: `web.fixture_person: { name, login }`, set by hand in the
 * distribution config (like `web.test_install`), gives a test install's
 * fixture person an invented name and login. Read from the distribution
 * config only; a wrong value is ignored with a warning (never a refusal to
 * start: on an install that isn't a test install it must do nothing).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  fixturePersonOffInstallWarning,
  ignoredConfigWarning,
  readWebAuthConfig,
} from "../../../src/shared/web-session.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function root(team: string[], user: string[] = []): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "den-fx1210-"));
  dirs.push(r);
  fs.mkdirSync(path.join(r, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(r, "config", "den.yml"), team.join("\n") + "\n");
  if (user.length)
    fs.writeFileSync(
      path.join(r, "config", "local", "user.yml"),
      user.join("\n") + "\n",
    );
  return r;
}

const person = (name: string, login: string) => [
  "web:",
  "  fixture_person:",
  `    name: ${JSON.stringify(name)}`,
  `    login: ${JSON.stringify(login)}`,
];

describe("web.fixture_person (issue 1210)", () => {
  it("read from the distribution config: the name and login, trimmed", () => {
    const c = readWebAuthConfig(
      root(person("  Robin Example ", "robin-example")),
    );
    expect(c.fixturePerson).toEqual({
      name: "Robin Example",
      login: "robin-example",
    });
    expect(ignoredConfigWarning(c)).toBeNull();
  });

  it("unset: none", () => {
    const c = readWebAuthConfig(root(["web:", "  test_install: true"]));
    expect(c.fixturePerson).toBeUndefined();
  });

  it("in user.yml: ignored, and said at start", () => {
    const c = readWebAuthConfig(
      root([], person("Robin Example", "robin-example")),
    );
    expect(c.fixturePerson).toBeUndefined();
    expect(ignoredConfigWarning(c)).toMatch(
      /web\.fixture_person \(config\/local\/user\.yml\): ignored/,
    );
  });

  it.each([
    [
      "a name with @ (never an email)",
      person("robin@example.test", "robin-example"),
    ],
    [
      "a login that isn't login-shaped",
      person("Robin Example", "robin example"),
    ],
    ["a login over 39 characters", person("Robin Example", "r".repeat(40))],
    ["a name over 64 characters", person("R".repeat(65), "robin-example")],
    ["a name on two lines", person("Robin\nExample", "robin-example")],
    ["no login", ["web:", "  fixture_person:", "    name: Robin Example"]],
    ["not a mapping", ["web:", "  fixture_person: Robin Example"]],
  ])(
    "%s: ignored with a warning naming the key, never a refusal",
    (_k, team) => {
      const c = readWebAuthConfig(root(team));
      expect(c.fixturePerson).toBeUndefined();
      expect(ignoredConfigWarning(c)).toMatch(
        /web\.fixture_person \(config\/den\.yml\)/,
      );
    },
  );

  it("doctor flags it on an install that isn't marked a test install", () => {
    const c = readWebAuthConfig(root(person("Robin Example", "robin-example")));
    expect(fixturePersonOffInstallWarning(c)).toMatch(
      /web\.fixture_person .*web\.test_install: true/,
    );
    const marked = readWebAuthConfig(
      root([
        ...person("Robin Example", "robin-example"),
        "  test_install: true",
      ]),
    );
    expect(fixturePersonOffInstallWarning(marked)).toBeNull();
    expect(
      fixturePersonOffInstallWarning(readWebAuthConfig(root([]))),
    ).toBeNull();
  });
});
