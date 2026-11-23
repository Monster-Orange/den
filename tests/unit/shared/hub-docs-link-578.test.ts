/**
 * Issue 578: Settings › Hub has a "What is Hub?" link to the published
 * docs page for the running version (docs/hub.md at its release tag in
 * the public repo), opening in a new tab. The doc path comes from one
 * place (shared/docs-link.ts), so other pages link docs the same way.
 * Its words are in en, es and ja.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { docsPageUrl, DOCS_REPO } from "../../../src/shared/docs-link.js";
import { hubHtml } from "../../../src/ui/server/public/settings-registry.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

describe("issue 578: one place for a docs page's address", () => {
  it("a release: the file at its tag", () => {
    expect(docsPageUrl("hub.md", "0.4.86")).toBe(
      `${DOCS_REPO}/blob/v0.4.86/docs/hub.md`,
    );
  });

  it("a dev build: its dev tag", () => {
    expect(docsPageUrl("hub.md", "0.4.86-dev.3")).toBe(
      `${DOCS_REPO}/blob/v0.4.86-dev.3/docs/hub.md`,
    );
  });

  it("no version, or one that isn't a version: main", () => {
    expect(docsPageUrl("hub.md", undefined)).toBe(
      `${DOCS_REPO}/blob/main/docs/hub.md`,
    );
    expect(docsPageUrl("hub.md", "../x")).toBe(
      `${DOCS_REPO}/blob/main/docs/hub.md`,
    );
  });

  it("only a plain docs file name", () => {
    expect(() => docsPageUrl("../secrets.md", "0.4.86")).toThrow();
    expect(() => docsPageUrl("hub.html", "0.4.86")).toThrow();
  });
});

describe("issue 578: Settings › Hub links its docs", () => {
  const url = `${DOCS_REPO}/blob/v0.4.86/docs/hub.md`;
  const link = (html: string) =>
    /<a [^>]*data-hub-docs[^>]*>[^<]*<\/a>/.exec(html)?.[0] ?? "";

  it("not connected: the link, to the running version's page, in a new tab", () => {
    const a = link(hubHtml({ configured: false, docsUrl: url }));
    expect(a).toContain(`href="${url}"`);
    expect(a).toContain('target="_blank"');
    expect(a).toMatch(/rel="[^"]*noopener/);
    expect(a).toContain("What is Hub?");
  });

  it("connected: the link too", () => {
    const a = link(
      hubHtml({
        configured: true,
        state: "connected",
        team: "North",
        docsUrl: url,
      }),
    );
    expect(a).toContain(`href="${url}"`);
  });

  it("no address, or one that isn't https: no link", () => {
    expect(link(hubHtml({ configured: false }))).toBe("");
    expect(
      link(hubHtml({ configured: false, docsUrl: "javascript:alert(1)" })),
    ).toBe("");
  });
});

describe("issue 578: the link's words in en, es and ja", () => {
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
        /* shell.js stops at its first DOM use */
      }
    }
    return window.denMessages as Record<string, Record<string, string>>;
  }

  it("set.ui.hub.what is in each, and es and ja aren't English", () => {
    const c = catalogs();
    expect(c.en["set.ui.hub.what"]).toBe("What is Hub?");
    for (const l of ["es", "ja"]) {
      expect(typeof c[l]["set.ui.hub.what"]).toBe("string");
      expect(c[l]["set.ui.hub.what"]).not.toBe(c.en["set.ui.hub.what"]);
    }
  });
});
