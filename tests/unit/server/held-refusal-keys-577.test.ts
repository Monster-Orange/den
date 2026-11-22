/**
 * Issue 577: a held write's refusals reach the person in their language.
 * Each refusal held-actions.ts writes itself returns its English `error`
 * and a sibling `errorKey: { key, vars }` (the scheme agreed for 746's
 * keys): the page renders t(key, vars) and falls back to `error`. Each
 * key is in the en, es and ja catalogs with the same {vars}, and its
 * English is the `error` word for word (with the product's title).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import {
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";
import {
  REFUSAL_WORDS,
  refusal,
} from "../../../src/shared/held-refusal-words.js";

const SRC = path.join(process.cwd(), "src");
const PUBLIC = path.join(SRC, "ui", "server", "public");
const HELD = path.join(SRC, "ui", "server", "held-actions.ts");

function catalogs(): Record<string, Record<string, string>> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
    try {
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx);
    } catch {
      /* shell.js stops at its first DOM use; its catalog is set first */
    }
  }
  return window.denMessages as Record<string, Record<string, string>>;
}

const vars = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("issue 577: held-actions.ts writes no refusal without a key", () => {
  it('no error: "…" or error: `…` literal is left (each goes through refusal())', () => {
    const src = fs.readFileSync(HELD, "utf-8");
    const left = src
      .split("\n")
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }, i, all) => {
        const here = /\berror:\s*["`]/.test(l);
        const wrapped =
          /\berror:\s*$/.test(l) && /^\s*["`]/.test(all[i + 1]?.l ?? "");
        return here || wrapped;
      })
      .map(({ n, l }) => `${n}: ${l.trim()}`);
    expect(left).toEqual([]);
  });
});

describe("issue 577: the refusal words are in en, es and ja", () => {
  const cat = catalogs();
  const keys = Object.keys(REFUSAL_WORDS);

  it("has the refusals (a sanity floor)", () => {
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(k).toMatch(/^ap\.err\.\w+$/);
  });

  it.each(["en", "es", "ja"])(
    "%s has every key, with the same {vars}",
    (lang) => {
      const missing = keys.filter((k) => typeof cat[lang]?.[k] !== "string");
      expect(missing).toEqual([]);
      for (const k of keys)
        expect([k, vars(cat[lang][k])]).toEqual([k, vars(REFUSAL_WORDS[k])]);
    },
  );

  it("en's text is the server's English word for word", () => {
    for (const k of keys) expect([k, cat.en[k]]).toEqual([k, REFUSAL_WORDS[k]]);
  });

  it("es and ja are not English copies", () => {
    for (const lang of ["es", "ja"])
      for (const k of keys)
        expect([lang, k, cat[lang][k] === cat.en[k]]).toEqual([lang, k, false]);
  });
});

describe("issue 577: refusal() gives the English and its key", () => {
  it("fills {vars} and the product's title", () => {
    expect(refusal("ap.err.noProject", { project: "north" })).toEqual({
      ok: false,
      error: 'there is no project "north"',
      errorKey: { key: "ap.err.noProject", vars: { project: "north" } },
    });
    expect(refusal("ap.err.cantRestart", {}, "Acme").error).toBe(
      "this Acme can't restart itself",
    );
  });
});

function deps(o: Partial<Record<string, unknown>> = {}): HeldActionDeps {
  return {
    rules: () => ({ home: "/home/x" }) as never,
    validate: () => ({ ok: true }) as never,
    workspaceCreateRefusal: () => null,
    createWorkspace: (n: string) => n,
    activateWorkspace: () => {},
    workspaceActive: (n: string) => n === "default",
    workspaceExists: (n: string) => n !== "nowhere",
    defaultWorkspace: () => "default",
    serviceTarget: (s: string) => ({ ok: true, address: s }),
    tryService: async () => ({}) as never,
    ...o,
  } as unknown as HeldActionDeps;
}

describe("issue 577: real held checks answer with a key", () => {
  const acts = (o?: Partial<Record<string, unknown>>) =>
    heldActions(deps(o)) as unknown as Record<
      string,
      {
        check: (
          a: Record<string, unknown>,
          who?: unknown,
        ) => unknown | Promise<unknown>;
      }
    >;

  it("a Den that can't restart itself", async () => {
    const r = (await acts().den_restart.check({ reason: "a fix" })) as {
      ok: boolean;
      errorKey?: { key: string };
    };
    expect(r.ok).toBe(false);
    expect(r.errorKey?.key).toBe("ap.err.cantRestart");
  });

  it("a project that isn't there (service_try)", async () => {
    const r = (await acts().service_try.check({
      service: "api",
      workspace: "nowhere",
    })) as { ok: boolean; error?: string; errorKey?: unknown };
    expect(r).toEqual({
      ok: false,
      error: 'there is no project "nowhere"',
      errorKey: { key: "ap.err.noProject", vars: { project: "nowhere" } },
    });
  });
});

describe("issue 577: the page shows a refusal in its language", () => {
  /** shell.js's apRefusal, loaded as a page in `lang`. */
  function apRefusal(lang: string): (r: unknown) => string {
    const window: Record<string, unknown> = {};
    const document = {
      getElementById: () => null,
      documentElement: { lang },
      addEventListener: () => {},
    };
    const ctx = vm.createContext({ window, document, Intl });
    for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
      try {
        vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx);
      } catch {
        /* shell.js stops at its first DOM use */
      }
    }
    return window.denApRefusal as (r: unknown) => string;
  }

  it("a keyed refusal in es, with its vars", () => {
    const show = apRefusal("es");
    expect(typeof show).toBe("function");
    expect(
      show({
        ok: false,
        error: 'there is no project "north"',
        errorKey: { key: "ap.err.noProject", vars: { project: "north" } },
      }),
    ).toBe('no hay ningún proyecto "north"');
  });

  it("no key: the English as sent", () => {
    expect(apRefusal("ja")({ ok: false, error: "git commit: failed" })).toBe(
      "git commit: failed",
    );
  });
});
