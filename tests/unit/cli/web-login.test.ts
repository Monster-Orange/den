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
import * as net from "net";
import type { AddressInfo } from "net";
import {
  cmdWebLogin,
  cmdWebLogout,
  cmdWebSessions,
  cmdWebToken,
  parseWebCommandArgs,
  WEB_SUBCOMMANDS_WITH_HELP,
} from "../../../src/ui/cli/web-command.js";
import {
  bindActorSession,
  lookupActorToken,
  mintActorToken,
} from "../../../src/shared/actor-token.js";
import {
  SUBCOMMAND_OWN_HELP,
  ownsSubcommandHelp,
} from "../../../src/ui/cli/flag-parser.js";
import { MCP_CONNECT_SUBCOMMANDS } from "../../../src/ui/cli/mcp-connect.js";
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
    expect(r.err).toMatch(/within 5 minutes/);
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

/** A port nothing listens on (the CLI then edits the state files). */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "localhost", r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}
const io = () => {
  const o = { out: "", err: "" };
  return {
    o,
    io: {
      out: (x: string) => (o.out += x),
      err: (x: string) => (o.err += x),
      stateDir: tmp,
    },
  };
};

describe("each web subcommand's own --help (the dispatcher answers for none of them)", () => {
  it("login, logout, token and sessions print their own usage, exit 0, and do nothing else", async () => {
    const port = String(await freePort());
    const a = io();
    expect(cmdWebLogin(["--help"], a.io)).toBe(0);
    expect(a.o.out).toMatch(/^Usage: den web login \[--next <path>\]/);
    expect(a.o.out).toMatch(/On localhost nothing asks for a sign-in/);
    // No link was minted, so no secret was made for one.
    expect(a.o.out).not.toMatch(/\/auth\?c=/);
    const b = io();
    expect(await cmdWebLogout(["--help", "--port", port], b.io)).toBe(0);
    expect(b.o.out).toMatch(/^Usage: den web logout \[<id prefix>\] \[--all\]/);
    expect(b.o.out).toMatch(/revoke every agent's token/);
    expect(b.o.out).not.toMatch(/Signed out/);
    const c = io();
    expect(cmdWebToken(["-h"], c.io)).toBe(0);
    expect(c.o.out).toMatch(/^Usage: den web token --print/);
    expect(c.o.out).not.toMatch(/den_pt_/);
    const d = io();
    expect(await cmdWebSessions(["-h", "--port", port], d.io)).toBe(0);
    expect(d.o.out).toMatch(/A session never\s+expires/);
    expect(d.o.out).not.toMatch(/web\.session\.idle/);
  });

  it("the dispatcher's list is each command's own: web's and mcp's subcommands", () => {
    expect([...SUBCOMMAND_OWN_HELP.web]).toEqual([
      ...WEB_SUBCOMMANDS_WITH_HELP,
    ]);
    expect([...SUBCOMMAND_OWN_HELP.mcp]).toEqual([...MCP_CONNECT_SUBCOMMANDS]);
    expect(ownsSubcommandHelp("web", "sessions")).toBe(true);
    expect(ownsSubcommandHelp("web", "up")).toBe(false);
    expect(ownsSubcommandHelp("web", undefined)).toBe(false);
    expect(ownsSubcommandHelp("mcp", "connect")).toBe(true);
    expect(ownsSubcommandHelp("status", "x")).toBe(false);
  });
});

describe("web logout (no server running: the state files)", () => {
  /** An agent's live token: minted, bound, its session listed as running. */
  function liveAgentToken(id: string): string {
    const { token, key } = mintActorToken(tmp, {
      agentId: id,
      workspace: "north",
      sessionName: `den-north:${id}`,
    });
    bindActorSession(tmp, key, `s-${id}`);
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "sessions", `s-${id}.json`),
      JSON.stringify({ id: `s-${id}`, exited: false }),
    );
    return token;
  }
  const state = (t: string) => {
    const r = lookupActorToken(tmp, t);
    return r === null ? "unknown" : r.revokedAt ? "revoked" : "live";
  };

  it("plain logout leaves agent tokens alone; --all revokes them and says so (restart or resume)", async () => {
    const port = String(await freePort());
    const t1 = liveAgentToken("planner");
    const t2 = liveAgentToken("writer");
    const plain = io();
    expect(await cmdWebLogout(["--port", port], plain.io)).toBe(0);
    expect(plain.o.out.trim()).toBe("Signed out 0 browsers.");
    expect([state(t1), state(t2)]).toEqual(["live", "live"]);

    const all = io();
    expect(await cmdWebLogout(["--all", "--port", port], all.io)).toBe(0);
    expect(all.o.out).toMatch(
      /web\.secret rotated: every old session and person token is void; this CLI keeps working\./,
    );
    expect(all.o.out).toMatch(
      /Revoked 2 agent tokens: a running agent must be restarted or resumed to get a new one\./,
    );
    expect([state(t1), state(t2)]).toEqual(["revoked", "revoked"]);
    // No token reaches the output.
    expect(`${all.o.out}${all.o.err}`.includes(t1)).toBe(false);
  });
});
