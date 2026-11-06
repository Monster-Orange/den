/**
 * SEC-1b: `<cli> web open` and `<cli> web login` (SEC-1 spec §2). The link
 * is printed alone on stdout, on localhost, and its code verifies against
 * the state dir's web.secret. The code itself is never printed by a test:
 * a failure shows booleans and parts of the URL other than it.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../../src/shared/edge/config.js", () => ({
  readWebPort: () => 7777,
}));
import {
  cmdWebLogin,
  cmdWebSessions,
  parseWebCommandArgs,
} from "../../../src/ui/cli/web-command.js";
import { readWebSecret } from "../../../src/shared/web-secret.js";
import { checkLoginCode } from "../../../src/shared/web-session.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wlogin-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function login(args: string[]) {
  let out = "";
  let err = "";
  const code = cmdWebLogin(args, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    stateDir: tmp,
  });
  return { code, out, err };
}

describe("web open", () => {
  it("is up that always opens a browser (a fresh sign-in tab)", () => {
    expect(parseWebCommandArgs(["open"], {})).toMatchObject({
      action: "open",
      openBrowser: true,
    });
    expect(parseWebCommandArgs(["open", "--no-open"], {}).openBrowser).toBe(
      true,
    );
  });
});

describe("web login", () => {
  it("prints one localhost /auth link on stdout whose code this state dir's secret verifies", () => {
    const r = login(["--port", "4321", "--next", "/settings"]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines.length).toBe(1);
    const u = new URL(lines[0]);
    expect([u.origin, u.pathname, u.searchParams.get("next")]).toEqual([
      "http://localhost:4321",
      "/auth",
      "/settings",
    ]);
    const c = u.searchParams.get("c") ?? "";
    expect(checkLoginCode(c, readWebSecret(tmp)!).ok).toBe(true);
    // The note on stderr never carries the code.
    expect(r.err).toMatch(/within 60 seconds/);
    expect(r.err.includes(c)).toBe(false);
    expect(fs.statSync(path.join(tmp, "web.secret")).mode & 0o777).toBe(0o600);
  });

  it("each call mints a new code", () => {
    const a = new URL(login(["--port", "4321"]).out.trim());
    const b = new URL(login(["--port", "4321"]).out.trim());
    expect(a.searchParams.get("c") === b.searchParams.get("c")).toBe(false);
  });

  it("--origin for the edge or a LAN name; a next off-site is dropped", () => {
    const r = login([
      "--origin",
      "https://den.acme.localhost",
      "--next",
      "//evil",
    ]);
    const u = new URL(r.out.trim());
    expect([u.origin, u.searchParams.has("next")]).toEqual([
      "https://den.acme.localhost",
      false,
    ]);
  });

  it("refuses an origin with a path, and an unknown argument", () => {
    expect(login(["--origin", "https://x/y"]).code).toBe(2);
    expect(login(["--origin", "x"]).code).toBe(2);
    expect(login(["--what"]).code).toBe(2);
    expect(login(["--what"]).out).toBe("");
  });
});

describe("web sessions --help", () => {
  it("says LAST SEEN is written at most once a minute (why it equals CREATED right after sign-in)", async () => {
    let out = "";
    const code = await cmdWebSessions(["--help"], {
      out: (x) => (out += x),
      err: () => undefined,
      stateDir: tmp,
    });
    expect(code).toBe(0);
    expect(out).toMatch(
      /LAST SEEN is written at most once a\s+minute \(60 s\)/,
    );
    expect(out).toMatch(/equals CREATED/);
  });
});
