/**
 * Issue 1127: text Den's tooling files on GitHub (an issue's title and body,
 * a comment) passes the same org-name check as commits and files, before it
 * is sent. A hit refuses the write and quotes the writer's own phrase,
 * with its field and line, and neutral words to use: never the list.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as path from "path";
import {
  filedTextCheck,
  filedTextHits,
  filedTextRefusal,
  filedTextWhere,
  needsFiledCheck,
} from "../../../src/shared/filed-text-check.js";
import * as shared from "../../../src/shared/org-names.js";

const ROOT = process.cwd();
const patterns = shared.orgPatterns({ DEN_ORG_NAMES: "acmewidgets\nzorblax" });

describe("issue 1127: one matcher", () => {
  it("scripts/org-names.js is the product's matcher, not a second copy", async () => {
    const scripts = (await import(
      path.join(ROOT, "scripts", "org-names.js")
    )) as typeof shared;
    expect(scripts.orgHitsWide).toBe(shared.orgHitsWide);
    expect(scripts.orgPatterns).toBe(shared.orgPatterns);
  });
});

describe("issue 1127: the filing check", () => {
  it("refuses a title, a body and a comment that hold a listed term", () => {
    expect(
      filedTextHits(
        [{ field: "title", text: "Crash at Acme Widgets" }],
        patterns,
      ),
    ).toEqual([{ field: "title", line: 1, index: 1, phrase: "Acme Widgets" }]);
    expect(
      filedTextHits(
        [
          {
            field: "body",
            text: "Steps:\n1. open it\n2. see acme-widgets.example",
          },
        ],
        patterns,
      ),
    ).toEqual([{ field: "body", line: 3, index: 1, phrase: "acme-widgets" }]);
    expect(
      filedTextHits(
        [{ field: "comment", text: "seen on ZORBLAX too" }],
        patterns,
      ),
    ).toEqual([{ field: "comment", line: 1, index: 2, phrase: "ZORBLAX" }]);
  });

  it("lets clean text through", () => {
    expect(
      filedTextHits(
        [
          { field: "title", text: "The bell misses a row" },
          { field: "body", text: "Steps:\n1. open the bell\n2. no row" },
        ],
        patterns,
      ),
    ).toEqual([]);
  });

  it("lets the target repo's own owner/name through (a link to it is not a leak)", () => {
    const text = "See https://github.com/Acme-Widgets/den/issues/4";
    expect(filedTextHits([{ field: "body", text }], patterns)).not.toEqual([]);
    expect(
      filedTextHits([{ field: "body", text }], patterns, "Acme-Widgets/den"),
    ).toEqual([]);
  });

  it("the refusal quotes the writer's own phrase and neutral words, never the list", () => {
    const listed = shared.orgPatterns({
      DEN_ORG_NAMES: "acmewidgets\nzorbl[a-z]+",
    });
    const hits = filedTextHits(
      [
        { field: "title", text: "Acme Widgets crash" },
        { field: "body", text: "ok\nZorblaxia here" },
      ],
      listed,
    );
    const msg = filedTextRefusal(hits);
    expect(msg).toContain('title line 1: "Acme Widgets"');
    expect(msg).toContain('body line 2: "Zorblaxia"');
    expect(msg).toContain("nothing was sent");
    expect(msg).toMatch(/"the person", "the project"/);
    expect(msg).toMatch(/an internal host/);
    expect(msg).not.toContain("acmewidgets");
    expect(msg).not.toContain("zorbl[a-z]+");
    expect(msg).not.toContain("pattern #");
  });

  it("the phrase is the listed one, not the target repo's own name beside it", () => {
    const hits = filedTextHits(
      [{ field: "body", text: "See Acme-Widgets/den and Acme Widgets HQ" }],
      patterns,
      "Acme-Widgets/den",
    );
    expect(hits.map((h) => h.phrase)).toEqual(["Acme Widgets"]);
  });

  it("the audit's words name only field, line and pattern number", () => {
    const hits = filedTextHits(
      [{ field: "title", text: "Zorblax down" }],
      patterns,
    );
    const where = filedTextWhere(hits);
    expect(where).toContain("title line 1");
    expect(where).toContain("pattern #2");
    expect(where.toLowerCase()).not.toContain("zorblax");
  });

  it("checks public repos and unknown visibility, and skips private and internal ones", () => {
    expect(needsFiledCheck("public")).toBe(true);
    expect(needsFiledCheck(null)).toBe(true);
    expect(needsFiledCheck("private")).toBe(false);
    expect(needsFiledCheck("internal")).toBe(false);
  });
});

describe("issue 1127: the check as a write runs it", () => {
  const texts = [{ field: "title" as const, text: "Crash at Zorblax" }];
  it("no listed names: nothing refused", () => {
    expect(filedTextCheck(texts, "o/r", "public", [])).toBeNull();
  });
  it("a private repo: nothing refused; public or unknown: refused", () => {
    expect(filedTextCheck(texts, "o/r", "private", patterns)).toBeNull();
    expect(filedTextCheck(texts, "o/r", "public", patterns)).toContain(
      "title line 1",
    );
    expect(filedTextCheck(texts, "o/r", null, patterns)).toContain(
      "nothing was sent",
    );
  });
});

describe("issue 1127: a bad line in the list never shows its text", () => {
  it("an invalid pattern throws naming only its line number", () => {
    let msg = "";
    try {
      shared.orgPatterns({
        DEN_ORG_NAMES: "# a comment\nzorblax\nqx(secretword",
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("line 3");
    expect(msg).not.toMatch(/qx|secretword|zorblax/);
  });

  it("orgMask replaces each listed match, and nothing else", () => {
    expect(
      shared.orgMask("page /projects/Zorblax/agents and zorblax.lan", patterns),
    ).toBe("page /projects/<listed>/agents and <listed>.lan");
    expect(shared.orgMask("clean text", patterns)).toBe("clean text");
  });

  it("orgMask leaves no spaced or hyphenated form of a listed name (the wider match)", () => {
    const out = shared.orgMask(
      "version 9.9.9\npage http://acme-widgets.lan:7777/agents\nAcme Widgets HQ",
      patterns,
    );
    expect(out.split("\n")[0]).toBe("version 9.9.9");
    expect(shared.orgHitsWide(out, patterns)).toEqual([]);
    expect(out.toLowerCase()).not.toMatch(/acme|widgets/);
  });
});
