/**
 * den-ui: who can see a report, the checks that need no browser (issue 415).
 *
 * reportVisibility(repo, lang) reads one of the host's info().repos[]
 * entries and gives the pill and the line above Send:
 *
 * - "public": the "Public repository" pill and the visible-to-everyone
 *   warning, as before;
 * - "private" / "internal": that pill, the audience, and a quiet line, no
 *   public warning;
 * - missing, "unknown" or anything else: the visibility isn't known. The
 *   form neither says public nor claims private: a "Visibility not known"
 *   pill and a caution (mask anything private), never "Public repository".
 *
 * The browser half is report-visibility.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

type Out = { visibility: string; audience: string; pill: string; note: string };

/**
 * reportVisibility for each [repo, lang], in Node as an ES module (jest
 * can't load report.js: it uses import.meta), plus the kit's words.
 */
function run(cases: [Record<string, unknown>, string][]): {
  has: boolean;
  out: Out[];
  words: Record<string, Record<string, string>>;
} {
  const js = `
    const R = await import("./packages/den-ui/src/report.js");
    const { kitT } = await import("./packages/den-ui/src/strings.js");
    const cases = ${JSON.stringify(cases)};
    const has = typeof R.reportVisibility === "function";
    const out = has ? cases.map(([r, l]) => R.reportVisibility(r, l)) : [];
    const words = {};
    for (const l of ["en", "es", "ja"])
      words[l] = Object.fromEntries(
        ["kit.report.unk", "kit.report.unkW", "kit.report.pub"].map((k) => [k, kitT(l, k)]),
      );
    console.log(JSON.stringify({ has, out, words }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

const one = (repo: Record<string, unknown>, lang = "en"): Out => {
  const r = run([[repo, lang]]);
  if (!r.has) throw new Error("reportVisibility is not exported");
  return r.out[0]!;
};
const vis = one;

/** Text of some markup, tags taken out. */
const text = (h: string) =>
  h
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const PUB = "Public repository";
const PRIV = "Private repository";

describe("den-ui report: reportVisibility (issue 415)", () => {
  it("is exported", () => {
    expect(run([]).has).toBe(true);
  });

  it.each([
    ["missing", { repo: "acme-eng/engine" }],
    ["unknown", { repo: "acme-eng/engine", visibility: "unknown" }],
    ["anything else", { repo: "acme-eng/engine", visibility: "secret" }],
  ])("%s visibility: not known, neither public nor private", (_n, r) => {
    const v = vis(r, "en");
    expect(v.visibility).toBe("unknown");
    expect(v.pill).toContain('data-vis="unknown"');
    expect(text(v.pill)).toBe("Visibility not known");
    // Never claims public, never claims private.
    for (const h of [v.pill, v.note]) {
      expect(text(h)).not.toContain(PUB);
      expect(text(h)).not.toContain(PRIV);
      expect(text(h)).not.toMatch(/Only people with access/);
    }
    // The caution stays: the warning box, telling them to mask.
    expect(v.note).toContain('class="fb-warn"');
    expect(text(v.note)).toMatch(/Mask anything private/);
  });

  it("an audience on an unknown target is not shown (it isn't known who sees it)", () => {
    const v = vis(
      { repo: "a/b", visibility: "unknown", audience: "the team" },
      "en",
    );
    expect(v.audience).toBe("");
    expect(text(v.pill + v.note)).not.toContain("the team");
  });

  it("public: the public pill and the visible-to-everyone warning, unchanged", () => {
    const v = vis({ repo: "a/b", visibility: "public" }, "en");
    expect(v.visibility).toBe("public");
    expect(text(v.pill)).toBe(PUB);
    expect(text(v.note)).toBe(
      `${PUB}. Screenshots and text are visible to everyone. Mask anything private.`,
    );
  });

  it("private with an audience: its pill, the audience as text, the quiet line", () => {
    const v = vis(
      { repo: "a/b", visibility: "private", audience: "<b>team</b>" },
      "en",
    );
    expect(v.visibility).toBe("private");
    expect(v.pill).not.toContain("<b>team");
    expect(text(v.pill)).toBe(`${PRIV} <b>team</b>`);
    expect(v.note).not.toContain("fb-warn");
    expect(text(v.note)).toContain("Only people with access");
  });

  it("internal with no audience: Internal pill, the quiet line alone", () => {
    const v = vis({ repo: "a/b", visibility: "internal" }, "en");
    expect(text(v.pill)).toBe("Internal repository");
    expect(text(v.note)).toBe(
      "Only people with access to this repository can see it.",
    );
  });

  it.each(["es", "ja"])("%s has its own words for not known", (lang) => {
    const v = vis({ repo: "a/b" }, lang);
    const en = vis({ repo: "a/b" }, "en");
    expect(text(v.pill)).not.toBe(text(en.pill));
    expect(text(v.note)).not.toBe(text(en.note));
    const w = run([]).words;
    for (const k of ["kit.report.unk", "kit.report.unkW"]) {
      expect(w[lang]![k]).not.toBe(k);
      expect(w[lang]![k]).not.toBe(w.en![k]);
    }
    expect(text(v.pill + v.note)).not.toContain(w[lang]!["kit.report.pub"]);
  });
});
