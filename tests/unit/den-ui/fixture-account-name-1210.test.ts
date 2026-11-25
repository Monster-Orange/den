/**
 * Issue 1210: the fixture person's rail entry shows the invented name from
 * web.fixture_person, never Hub's name for a login that happens to match:
 * that would put a real person's name on a test install's fixture person.
 * accountModel (public/shell.js) is run from Den's own source, as in
 * account-name-parity.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { sameAsLogin } from "../../../packages/den-ui/src/shell-html.js";

const SHELL = fs.readFileSync(
  path.join(process.cwd(), "src", "ui", "server", "public", "shell.js"),
  "utf-8",
);
const start = SHELL.indexOf("  function accountModel() {");
const source = SHELL.slice(start, SHELL.indexOf("\n  }\n", start) + 4);

function account(identity: Record<string, unknown>) {
  const ctx = {
    state: {
      identity,
      // Hub is connected as a real person whose login collides.
      hub: { state: "connected", login: "robin-example", name: "Real Person" },
    },
    DUI: { sameAsLogin },
    lang: "en",
    t: (k: string) => k,
    result: null as unknown,
  };
  vm.runInNewContext(source + "\nresult = accountModel();", ctx);
  return ctx.result as { login?: string; name?: string };
}

describe("the fixture person's rail entry (issue 1210)", () => {
  it("shows the invented name, never Hub's for a matching login", () => {
    const a = account({
      kind: "github",
      via: "fixture",
      login: "robin-example",
      name: "Robin Example",
    });
    expect([a.login, a.name]).toEqual(["robin-example", "Robin Example"]);
  });

  it("with no invented name, shows @login alone, never Hub's name", () => {
    const a = account({
      kind: "github",
      via: "fixture",
      login: "robin-example",
    });
    expect(a.login).toBe("robin-example");
    expect(a.name).toBeUndefined();
  });

  it("a real GitHub sign-in still takes Hub's name (issue 406)", () => {
    const a = account({
      kind: "github",
      via: "github",
      login: "robin-example",
    });
    expect(a.name).toBe("Real Person");
  });
});
