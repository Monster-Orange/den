/**
 * MODE-5 (0.4.46): `<cli> web url <address>` follows the page's rules. A
 * loopback name is refused; the running web server checks the address
 * answers as this install and saves it only then (it says why when not);
 * with no web server it says so and how to go on; `--no-check` saves it
 * unchecked (an install whose web server hasn't run yet); an agent's
 * session never sets it. Every effect is injected: nothing is written.
 */
import { describe, expect, it } from "@jest/globals";
import { cmdWebUrl } from "../../../src/ui/cli/web-url-command.js";
import { ACTOR_TOKEN_ENV } from "../../../src/shared/actor-token.js";

type Check = Awaited<
  ReturnType<
    Parameters<typeof cmdWebUrl>[1] extends infer I
      ? I extends { checkAndSave: (u: string) => infer R }
        ? () => R
        : never
      : never
  >
>;

function io(answer: Check, env: NodeJS.ProcessEnv = {}) {
  const r = {
    out: "",
    err: "",
    set: [] as string[],
    checked: [] as string[],
  };
  return {
    r,
    io: {
      out: (s: string) => (r.out += s),
      err: (s: string) => (r.err += s),
      env,
      read: () => null,
      set: (a: string) => {
        r.set.push(a);
        return a;
      },
      checkAndSave: async (u: string) => {
        r.checked.push(u);
        return answer;
      },
    },
  };
}

const OK: Check = { ok: true, url: "https://acme.local.example.com" };

describe("MODE-5: web url <address> checks before it saves", () => {
  it("an address that answers is checked and saved by the web server", async () => {
    const x = io(OK);
    expect(await cmdWebUrl(["https://acme.local.example.com/"], x.io)).toBe(0);
    expect(x.r.checked).toEqual(["https://acme.local.example.com"]);
    expect(x.r.set).toEqual([]);
    expect(x.r.out).toMatch(
      /This install's address is https:\/\/acme\.local\.example\.com/,
    );
  });

  it("one that doesn't answer is not saved, and it says why", async () => {
    const x = io({
      ok: false,
      error:
        "nothing at https://gone.example.com answered within 10 s. Not saved.",
    });
    expect(await cmdWebUrl(["https://gone.example.com", "--json"], x.io)).toBe(
      1,
    );
    expect(JSON.parse(x.r.out)).toEqual({
      ok: false,
      saved: false,
      error:
        "nothing at https://gone.example.com answered within 10 s. Not saved.",
    });
    expect(x.r.set).toEqual([]);
  });

  it("no web server: it says so, and how to go on", async () => {
    const x = io({
      ok: false,
      error: "the web server is not running",
      down: true,
    });
    expect(await cmdWebUrl(["https://acme.local.example.com"], x.io)).toBe(1);
    expect(x.r.err).toMatch(
      /can't be checked\. Start it \(`\S+ web up`\).*--no-check.*Not saved\./,
    );
    expect(x.r.set).toEqual([]);
  });

  it("--no-check saves it unchecked", async () => {
    const x = io(OK);
    expect(
      await cmdWebUrl(["https://acme.local.example.com", "--no-check"], x.io),
    ).toBe(0);
    expect(x.r.set).toEqual(["https://acme.local.example.com"]);
    expect(x.r.checked).toEqual([]);
  });

  it("a loopback name is refused, even with --no-check, before any check", async () => {
    for (const a of [
      "http://localhost:7001",
      "http://127.0.0.1:7001",
      "http://[::1]:7001",
      "http://acme.localhost",
    ])
      for (const extra of [[], ["--no-check"]]) {
        const x = io(OK);
        expect(await cmdWebUrl([a, ...extra], x.io)).toBe(2);
        expect(x.r.err).toMatch(/names this machine only/);
        expect([...x.r.set, ...x.r.checked]).toEqual([]);
      }
  });

  it("an agent's session never sets it", async () => {
    const x = io(OK, { [ACTOR_TOKEN_ENV]: "x" });
    expect(await cmdWebUrl(["https://acme.local.example.com"], x.io)).toBe(1);
    expect(x.r.err).toMatch(/only a person/);
    expect([...x.r.set, ...x.r.checked]).toEqual([]);
  });

  it("the help names --no-check and when to use it", async () => {
    const x = io(OK);
    expect(await cmdWebUrl(["--help"], x.io)).toBe(0);
    expect(x.r.out).toMatch(
      /--no-check\s+save it without the check: for an install whose web app hasn't run yet/,
    );
  });
});
