/**
 * Issue 868 (tests first), without a browser: the signed-out page lists
 * the sign-in methods this install has set up, and says plainly when none
 * works from another computer, with the fix.
 *
 *  - signinMethods (server): what the page is told, from the GitHub
 *    sign-in state, whether a person's browser is signed in to approve,
 *    whether the request came from another computer, and first run.
 *  - methodsBlock (the page): the list, and the "can't sign in from here
 *    yet" line with its fix, in the page's words.
 *  - every new word is in en, es and ja.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { signinMethods } from "../../../src/ui/server/signin-methods.js";
import { methodsBlock } from "../../../src/ui/server/public/error-page.js";

type Table = Record<string, string>;
const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

function catalogs(): Record<string, Table> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  }
  return window.denMessages as Record<string, Table>;
}
const M = catalogs();
/** The page's t() for one language: the key itself when it is missing. */
const tFor =
  (lang: string) =>
  (key: string, vars: Record<string, string> = {}): string =>
    (M[lang]?.[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) =>
      k in vars ? vars[k] : `{${k}}`,
    );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const CMD = "den web login --origin https://den.example.test";
const RESTART = "den web restart";

describe("signinMethods: what the page is told", () => {
  it("no GitHub client, nobody signed in, from another computer: stuck, with the setting named", () => {
    const m = signinMethods({
      github: { state: "no_client_id" },
      signedInBrowser: false,
      remote: true,
      firstRun: false,
      terminal: CMD,
      restart: RESTART,
    });
    expect(m).toEqual({
      github: "no_client_id",
      setting: "web.github_client_id",
      file: "config/local/user.yml",
      restart: RESTART,
      ask: true,
      browser: false,
      terminal: CMD,
      remote: true,
      firstRun: false,
      stuck: true,
    });
  });

  it("on this computer it is never stuck: the terminal is right here", () => {
    const m = signinMethods({
      github: { state: "no_client_id" },
      signedInBrowser: false,
      remote: false,
      firstRun: false,
      terminal: CMD,
      restart: RESTART,
    });
    expect([m.remote, m.stuck]).toEqual([false, false]);
  });

  it("a signed-in browser to approve, or GitHub sign-in that works: not stuck", () => {
    const base = {
      remote: true,
      firstRun: false,
      terminal: CMD,
      restart: RESTART,
    };
    expect(
      signinMethods({
        ...base,
        github: { state: "no_client_id" },
        signedInBrowser: true,
      }).stuck,
    ).toBe(false);
    expect(
      signinMethods({
        ...base,
        github: { state: "ready" },
        signedInBrowser: false,
      }),
    ).toMatchObject({ github: "ready", stuck: false });
  });

  it("a claim only the GitHub org can make from the host doesn't work from here; one named owner can", () => {
    const base = {
      remote: true,
      firstRun: true,
      terminal: CMD,
      restart: RESTART,
      signedInBrowser: false,
    };
    expect(
      signinMethods({ ...base, github: { state: "claim", org: "example" } }),
    ).toMatchObject({ github: "no_owner", stuck: true });
    expect(
      signinMethods({
        ...base,
        github: { state: "claim", ownerGithub: "someone" },
      }),
    ).toMatchObject({ github: "ready", stuck: false });
  });
});

describe("methodsBlock: the list on the signed-out page", () => {
  const s = {
    name: "Den",
    machine: "host-a",
    cmd: CMD,
    github: { owner: "den web owner link" },
    methods: signinMethods({
      github: { state: "no_client_id" },
      signedInBrowser: false,
      remote: true,
      firstRun: false,
      terminal: CMD,
      restart: RESTART,
    }),
  };

  it("lists GitHub sign-in, asking from this device, and the terminal link, each with whether it is set up here", () => {
    const html = methodsBlock(s, tFor("en"));
    expect(html).toContain('id="den-signin-methods"');
    for (const m of ["github", "pair", "terminal"])
      expect(html).toMatch(new RegExp(`data-method="${m}"`));
    expect(html).toMatch(/data-method="github" data-ready="0"/);
    expect(html).toMatch(/data-method="pair" data-ready="0"/);
    const words = text(html);
    expect(words).toContain(CMD);
    // Ruling 11-21: no file to edit on the host and no restart to run:
    // the page asks, and a person signed in to this Den allows it.
    expect(words).not.toContain("config/local/user.yml");
    expect(words).not.toContain(RESTART);
    expect(html).toMatch(/<button [^>]*id="den-signin-gh-ask"/);
    expect(html).toContain('id="den-signin-gh-asked"');
  });

  it("GitHub sign-in that is set up, or only lacks an owner: no ask", () => {
    for (const github of ["ready", "no_owner"])
      expect(
        methodsBlock(
          { ...s, methods: { ...s.methods, github, ask: false } },
          tFor("en"),
        ),
      ).not.toContain("den-signin-gh-ask");
  });

  it("from another computer with no way in: says so plainly, and offers the fix", () => {
    const html = methodsBlock(s, tFor("en"));
    expect(html).toContain('id="den-signin-stuck"');
    expect(html).toContain('id="den-signin-fix"');
    expect(text(html)).toMatch(
      /can't be signed into from another computer yet/,
    );
  });

  it("with a signed-in browser: no stuck line, and a link starts asking to sign in", () => {
    const html = methodsBlock(
      { ...s, methods: { ...s.methods, browser: true, stuck: false } },
      tFor("en"),
    );
    expect(html).not.toContain('id="den-signin-stuck"');
    expect(html).toMatch(/data-method="pair" data-ready="1"/);
    expect(html).toMatch(/<a [^>]*href="#den-pair"[^>]*id="den-signin-ask"/);
  });

  // No tool lets an agent set the GitHub client id yet: the page must not
  // send a person to ask one, in any language.
  it.each(["en", "es", "ja"])(
    "in %s, it never says an agent can set up GitHub sign-in",
    (lang) => {
      for (const github of ["no_client_id", "no_owner"]) {
        const html = methodsBlock(
          { ...s, methods: { ...s.methods, github } },
          tFor(lang),
        );
        expect([
          lang,
          github,
          /agent|agente|エージェント/i.test(text(html)),
        ]).toEqual([lang, github, false]);
      }
    },
  );

  it("no methods (an older server): nothing", () => {
    expect(methodsBlock({ ...s, methods: undefined }, tFor("en"))).toBe("");
  });

  it.each(["es", "ja"])("in %s, no key shows through", (lang) => {
    const html = methodsBlock(s, tFor(lang));
    expect(text(html)).not.toMatch(/err\.signin\.methods/);
  });
});

describe("issue 868's words are in en, es and ja", () => {
  const keys = Object.keys(M.en).filter((k) =>
    k.startsWith("err.signin.methods."),
  );
  it("there are some", () => {
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });
  it.each(["es", "ja"])("%s has each, with the same placeholders", (lang) => {
    for (const k of keys) {
      expect([k, typeof M[lang][k]]).toEqual([k, "string"]);
      const ph = (v: string) => (v.match(/\{\w+\}/g) ?? []).sort();
      expect([k, ph(M[lang][k])]).toEqual([k, ph(M.en[k])]);
    }
  });
});
