/**
 * SEC-2a: `<cli> web owner link|show|unlink`. Link runs GitHub's device flow
 * in the terminal (the code and https://github.com/login/device, then a
 * wait), stores `github:<id>` and the login in a 0600 file, and keeps no
 * token. A fake GitHub on localhost (never github.com); sleeps injected.
 * A failure never prints a code or token: only booleans and lengths.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdWebOwner } from "../../../src/ui/cli/web-command.js";
import {
  GITHUB_TEST_BASE_ENV,
  githubEndpoints,
} from "../../../src/shared/github-app.js";
import { githubDeviceClient } from "../../../src/shared/github-device.js";
import { webOwnerPath } from "../../../src/shared/web-owner.js";
import {
  startFakeGithub,
  type FakeGithub,
} from "../server/helpers/fake-github.js";

let gh: FakeGithub;
let tmp = "";
beforeAll(async () => {
  gh = await startFakeGithub();
});
afterAll(async () => gh.close());
beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-owner-cli-")),
  );
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function owner(
  args: string[],
  opts: { approveAs?: { id: number; login: string }; clientId?: string } = {},
) {
  let out = "";
  let err = "";
  const code = await cmdWebOwner(args, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    stateDir: tmp,
    clientId: opts.clientId ?? "Iv23liAcme",
    client: githubDeviceClient(
      githubEndpoints({ [GITHUB_TEST_BASE_ENV]: gh.url }),
    ),
    sleep: async () => {
      const c = gh.codes[gh.codes.length - 1];
      if (opts.approveAs) gh.approve(c.userCode, opts.approveAs);
      else gh.deny(c.userCode);
    },
  });
  return { code, out, err };
}

describe("web owner", () => {
  it("show, with none linked, says how to link one", async () => {
    const r = await owner([]);
    expect(r).toEqual({
      code: 0,
      out: "No owner is linked. Run `den web owner link`.\n",
      err: "",
    });
  });

  it("link shows the code and github.com/login/device, stores github:<id> 0600, and keeps no token", async () => {
    const r = await owner(["link"], {
      approveAs: { id: 4242, login: "octo-owner" },
    });
    expect([r.code, r.err]).toEqual([0, ""]);
    const userCode = gh.codes[gh.codes.length - 1].userCode;
    expect(
      r.out.startsWith(
        "Open https://github.com/login/device and enter this code:\n",
      ),
    ).toBe(true);
    expect(r.out.includes(`    ${userCode}\n`)).toBe(true);
    expect(r.out).toContain(
      "Linked @octo-owner (github:4242) as this Den's owner; the token was not kept.",
    );
    const file = webOwnerPath(tmp);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const saved = fs.readFileSync(file, "utf-8");
    expect(JSON.parse(saved)).toMatchObject({
      owner: "github:4242",
      login: "octo-owner",
    });
    // No token anywhere in the state dir, or in what was printed.
    const all = fs
      .readdirSync(tmp)
      .map((f) => fs.readFileSync(path.join(tmp, f), "utf-8"))
      .join("\n");
    for (const t of gh.tokens) {
      expect(all.includes(t)).toBe(false);
      expect(r.out.includes(t)).toBe(false);
    }
    expect((await owner(["show"])).out).toMatch(
      /^Owner: @octo-owner \(github:4242\), linked \d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ\.\n$/,
    );
  });

  it("link is refused while an owner is linked; unlink forgets it", async () => {
    await owner(["link"], { approveAs: { id: 4242, login: "octo-owner" } });
    const again = await owner(["link"], {
      approveAs: { id: 7, login: "someone-else" },
    });
    expect([again.code, again.err]).toEqual([
      1,
      "den: this Den's owner is @octo-owner already; `den web owner unlink` first.\n",
    ]);
    const u = await owner(["unlink"]);
    expect(u.out).toBe(
      "Unlinked @octo-owner. Signed-in browsers stay signed in (`den web logout` ends them).\n",
    );
    expect(fs.existsSync(webOwnerPath(tmp))).toBe(false);
    expect((await owner(["unlink"])).out).toBe("No owner was linked.\n");
  });

  it("cancelled on GitHub: nothing is stored", async () => {
    const r = await owner(["link"]);
    expect([r.code, r.err]).toEqual([
      1,
      "den: the request was cancelled on GitHub\n",
    ]);
    expect(fs.existsSync(webOwnerPath(tmp))).toBe(false);
  });

  it("no client id configured: says so and how to set one, and never asks GitHub", async () => {
    const before = gh.requests.length;
    const r = await owner(["link"], { clientId: "" });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "Sign in with GitHub needs a GitHub App client id, and none is configured.",
    );
    expect(r.err).toContain("web.github_client_id");
    expect(gh.requests.length).toBe(before);
  });

  it("--json, and a usage error for anything else", async () => {
    expect(JSON.parse((await owner(["show", "--json"])).out)).toEqual({
      owner: null,
    });
    expect((await owner(["frobnicate"])).code).toBe(2);
    expect((await owner(["--help"])).out).toMatch(/^Usage: den web owner/);
  });
});
