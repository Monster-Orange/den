/**
 * Issue 810: the CLI side of the fixture person.
 *  - `web fixture-person` (the fallback to Settings' button): a person's,
 *    on a test install only; refused inside an agent's session.
 *  - `web fixture-login`: the gate runner (an agent) gets a one-time
 *    sign-in link as the fixture person, on a test install only, with the
 *    fixture person made.
 *  - An agent's own `web login` stays refused, test install or not.
 *  - `config web.test_install=…` is refused: only a person sets the mark,
 *    by hand, in the distribution config.
 * No secret or link code is printed by a failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cmdWebFixtureLogin,
  cmdWebFixturePerson,
  cmdWebLogin,
  cmdWebLoginWait,
} from "../../../src/ui/cli/web-command.js";
import { cmdConfig } from "../../../src/ui/cli/config-command.js";
import { fixturePersonPath } from "../../../src/shared/fixture-person.js";

let tmp = "";
const AGENT_KEYS = ["DEN_AGENT", "DEN_ACTOR_TOKEN", "DEN_ACTOR_TOKEN_FILE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wfx-")));
  for (const k of AGENT_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function io(testInstall: boolean) {
  const o = { out: "", err: "" };
  return {
    o,
    io: {
      out: (s: string) => (o.out += s),
      err: (s: string) => (o.err += s),
      stateDir: tmp,
      webUrl: () => ({ url: "https://den.example.test", confirmed: true }),
      testInstall: () => testInstall,
    },
  };
}
const asAgent = () => {
  process.env.DEN_ACTOR_TOKEN = "den_at_x";
};
const secretValue = () =>
  fs.readFileSync(fixturePersonPath(tmp), "utf-8").trim();

describe("web fixture-person (a person, on a test install)", () => {
  it("is refused on a real install, and writes nothing", async () => {
    const { o, io: i } = io(false);
    expect(await cmdWebFixturePerson([], i)).toBe(1);
    expect(o.err).toMatch(/isn't marked a test install/);
    expect(fs.existsSync(fixturePersonPath(tmp))).toBe(false);
  });

  it("is refused inside an agent's session, even on a test install", async () => {
    asAgent();
    const { o, io: i } = io(true);
    expect(await cmdWebFixturePerson([], i)).toBe(1);
    expect(o.err).toMatch(/An agent can't/);
    expect(fs.existsSync(fixturePersonPath(tmp))).toBe(false);
  });

  it("a person on a test install makes it (0600), and its value is never printed", async () => {
    const { o, io: i } = io(true);
    expect(await cmdWebFixturePerson([], i)).toBe(0);
    expect(fs.statSync(fixturePersonPath(tmp)).mode & 0o777).toBe(0o600);
    const v = secretValue();
    expect((o.out + o.err).includes(v)).toBe(false);
    expect(o.out + o.err).toMatch(/fixture person/);
  });
});

describe("web fixture-login (the gate runner, an agent)", () => {
  it("a real install refuses the fixture path", async () => {
    asAgent();
    const { o, io: i } = io(false);
    expect(await cmdWebFixtureLogin([], i)).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).toMatch(/isn't marked a test install/);
  });

  it("a test install with no fixture person refuses, saying how to make one", async () => {
    asAgent();
    const { o, io: i } = io(true);
    expect(await cmdWebFixtureLogin([], i)).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).toMatch(/Set up test person/);
  });

  it("a test install grants it: one /auth?fixture= link, never the secret", async () => {
    const made = io(true);
    expect(await cmdWebFixturePerson([], made.io)).toBe(0);
    asAgent();
    const { o, io: i } = io(true);
    expect(await cmdWebFixtureLogin(["--next", "/agents"], i)).toBe(0);
    const url = new URL(o.out.trim());
    expect(url.origin).toBe("https://den.example.test");
    expect(url.pathname).toBe("/auth");
    expect(url.searchParams.has("fixture")).toBe(true);
    expect(url.searchParams.has("c")).toBe(false);
    expect((o.out + o.err).includes(secretValue())).toBe(false);
  });
});

describe("an agent's own web login stays refused", () => {
  it.each([
    ["a real install", false],
    ["a test install", true],
  ])("on %s", async (_name, testInstall) => {
    asAgent();
    const a = io(testInstall);
    expect(await cmdWebLogin(["--no-wait"], a.io)).toBe(1);
    expect(a.o.err).toMatch(/An agent can't do this/);
    const b = io(testInstall);
    expect(await cmdWebLoginWait([], b.io)).toBe(1);
    expect(b.o.err).toMatch(/An agent can't do this/);
    expect(fs.existsSync(path.join(tmp, "web.secret"))).toBe(false);
  });
});

describe("the test-install mark can't be set from the CLI", () => {
  it.each(["web.test_install=true", "test_install=true"])(
    "config %s is refused",
    async (arg) => {
      await expect(cmdConfig([arg])).rejects.toThrow(/test install.*by hand/i);
    },
  );
});
