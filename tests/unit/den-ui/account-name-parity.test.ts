/**
 * Issue 656: the account entry shows "@login" alone when the person has no
 * display name, in every product that draws it with the kit. A name that
 * is just the login (in another case, with or without a leading "@", with
 * spaces around it) is no name: one line, never "sam" over "@sam".
 *
 * Parity: from the same person, the account entry's data is built the way
 * Den builds it (public/shell.js accountModel, run here from Den's own
 * source with its page state stubbed) and the way the other product
 * builds it, then both are drawn through the kit (the rail's entry and the
 * account menu's header) and must match. The other product lives in its
 * own repo: it hands the kit `{ name, login, role }` straight from its
 * signed-in person ("me"), so that shape is mirrored here, not imported.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import {
  accountHtml,
  accountMenuHtml,
  accountWho,
} from "../../../packages/den-ui/src/shell-html.js";

const SHELL = fs.readFileSync(
  path.join(process.cwd(), "src", "ui", "server", "public", "shell.js"),
  "utf-8",
);

/** Den's accountModel, cut from shell.js as it stands. */
function denAccountModelSource(): string {
  const start = SHELL.indexOf("  function accountModel() {");
  expect(start).toBeGreaterThan(-1);
  const end = SHELL.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return SHELL.slice(start, end + 4);
}

/** A person as each product knows them. */
type Person = {
  login: string;
  /** GitHub's name for them (Den's sign-in), if any. */
  githubName?: string | null;
  /** Hub's name for them, if any (Den reads it when connected). */
  hubName?: string | null;
};

/** The account data as Den's rail builds it (a GitHub sign-in). */
function denAccount(p: Person): Record<string, unknown> {
  const state = {
    identity: {
      kind: "github",
      login: p.login,
      name: p.githubName ?? undefined,
    },
    hub:
      p.hubName != null
        ? { state: "connected", login: p.login, name: p.hubName }
        : null,
  };
  const ctx = {
    state,
    lang: "en",
    t: (k: string) => k,
    result: null as unknown,
  };
  vm.runInNewContext(
    denAccountModelSource() + "\nresult = accountModel();",
    ctx,
  );
  return ctx.result as Record<string, unknown>;
}

/**
 * The account data as the other product builds it: its signed-in person
 * `me` ({ name, login, role }), passed to the kit as it is.
 */
function otherAccount(p: Person): Record<string, unknown> {
  const me = {
    name: p.hubName ?? p.githubName ?? null,
    login: p.login,
    role: undefined,
  };
  return { name: me.name, login: me.login, role: me.role };
}

/** What the person sees: the entry's lines, its shape and its tooltip. */
function seen(html: string) {
  return {
    lines: [
      ...html.matchAll(/<span class="den-acct-(n|l|r)">([^<]*)<\/span>/g),
    ].map((m) => `${m[1]}:${m[2]}`),
    shape: /data-nav-shape="([^"]*)"/.exec(html)?.[1] ?? null,
    title: /title="([^"]*)"/.exec(html)?.[1] ?? null,
  };
}

const rail = (a: Record<string, unknown>) =>
  seen(accountHtml({ ...a, href: "/me" } as Parameters<typeof accountHtml>[0]));
const menu = (a: Record<string, unknown>) =>
  seen(
    accountMenuHtml({
      name: a.name as string | undefined,
      login: a.login as string,
      role: "Admin",
      items: [],
    }),
  );

describe("issue 656: a name that is just the login is no name", () => {
  it.each([
    ["the same login", "sam"],
    ["another case", "SAM"],
    ["a leading @", "@sam"],
    ["spaces around it", "  Sam  "],
  ])("the kit: a name equal to the login (%s) draws @login alone", (_, n) => {
    expect(accountWho({ name: n, login: "sam" })?.lines).toEqual(["@sam"]);
    const r = rail({ name: n, login: "sam" });
    expect(r.lines).toEqual(["n:@sam"]);
    expect(r.shape).toBe("login");
    expect(r.title).toBe("@sam");
    expect(menu({ name: n, login: "sam" }).lines).toEqual([
      "n:@sam",
      "r:Admin",
    ]);
  });

  it("the kit: a real name is still drawn over @login", () => {
    const r = rail({ name: "Sam Rivera", login: "sam" });
    expect(r.lines).toEqual(["n:Sam Rivera", "l:@sam"]);
    expect(r.shape).toBe("name,login");
  });

  it("Den passes a name only when it differs from the login", () => {
    expect(denAccount({ login: "sam", githubName: "sam" }).name).toBe(
      undefined,
    );
    expect(denAccount({ login: "sam", hubName: "SAM" }).name).toBe(undefined);
    expect(
      denAccount({ login: "sam", githubName: "@Sam", hubName: "Sam Rivera" })
        .name,
    ).toBe("Sam Rivera");
    expect(denAccount({ login: "sam", githubName: "Sam Rivera" }).name).toBe(
      "Sam Rivera",
    );
  });
});

describe("issue 656: Den and the other product draw the same person the same way", () => {
  const PEOPLE: [string, Person, string[]][] = [
    ["no name", { login: "sam" }, ["n:@sam"]],
    [
      "GitHub's name is the login in another case",
      { login: "sam", githubName: "Sam" },
      ["n:@sam"],
    ],
    [
      "Hub's name is the login in another case",
      { login: "sam", hubName: "SAM" },
      ["n:@sam"],
    ],
    [
      "a real name",
      { login: "sam", githubName: "Sam Rivera" },
      ["n:Sam Rivera", "l:@sam"],
    ],
    [
      "a real name from Hub",
      { login: "sam", hubName: "Sam Rivera" },
      ["n:Sam Rivera", "l:@sam"],
    ],
  ];
  it.each(PEOPLE)("%s: the rail's entry", (_, p, lines) => {
    const den = rail(denAccount(p));
    expect(den).toEqual(rail(otherAccount(p)));
    expect(den.lines).toEqual(lines);
  });
  it.each(PEOPLE)("%s: the account menu's header", (_, p, lines) => {
    const den = menu(denAccount(p));
    expect(den).toEqual(menu(otherAccount(p)));
    expect(den.lines).toEqual([...lines, "r:Admin"]);
  });
});
