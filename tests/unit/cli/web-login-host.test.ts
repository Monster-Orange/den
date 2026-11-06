/**
 * 0.4.3: `<cli> web login --host <name>` mints the one-time link for an
 * edge hostname (an edge domain, or an alias such as a VPN name) that
 * routes to this server, instead of localhost; any other name is refused,
 * saying what to add. The code itself is never printed by a test.
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
  readEdgeConfig: () => ({
    org: "acme",
    domain: "acme.localhost",
    aliases: ["acme.vpn.example"],
    tls: { strategy: "mkcert", ca: null },
    ports: { http: 80, https: 8443 },
    routes: {
      den: "http://host.docker.internal:7777",
      shop: "http://host.docker.internal:3000",
    },
  }),
}));
import { cmdWebLogin } from "../../../src/ui/cli/web-command.js";
import { readWebSecret } from "../../../src/shared/web-secret.js";
import { checkLoginCode } from "../../../src/shared/web-session.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-whost-")));
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

describe("web login --host", () => {
  it("the edge hostname: its edge URL (scheme and port from the edge config)", () => {
    const r = login(["--port", "7777", "--host", "den.acme.localhost"]);
    expect(r.code).toBe(0);
    const u = new URL(r.out.trim());
    expect([u.origin, u.pathname]).toEqual([
      "https://den.acme.localhost:8443",
      "/auth",
    ]);
    expect(
      checkLoginCode(u.searchParams.get("c") ?? "", readWebSecret(tmp)!).ok,
    ).toBe(true);
  });

  it("an alias domain (a VPN name), any case", () => {
    const r = login(["--port", "7777", "--host", "DEN.acme.vpn.example"]);
    expect(r.code).toBe(0);
    expect(new URL(r.out.trim()).origin).toBe(
      "https://den.acme.vpn.example:8443",
    );
  });

  it("a name not in the Host allowlist: refused, saying what to add", () => {
    for (const h of ["shop.acme.localhost", "evil.example"]) {
      const r = login(["--port", "7777", "--host", h]);
      expect([h, r.code, r.out]).toEqual([h, 2, ""]);
      expect(r.err).toMatch(/den\.acme\.localhost/);
      expect(r.err).toMatch(/edge\.aliases/);
      expect(r.err).toMatch(/--origin/);
    }
  });

  it("--origin is kept", () => {
    const r = login(["--origin", "https://den.acme.localhost"]);
    expect(new URL(r.out.trim()).origin).toBe("https://den.acme.localhost");
  });
});
