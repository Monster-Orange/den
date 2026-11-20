/**
 * issue 668 (harmony): every date or time Den's pages draw reads in the
 * person's chosen zone (<html data-den-tz>), else the browser's, in the
 * page's language, through the kit's time.js. One kit way, no local one.
 *
 *   T1  guard: no file in src/ui/server/public formats a date itself
 *       (toLocale*String, Intl.DateTimeFormat) outside the allow-list.
 *   T2  parity: one stamp drawn Den's way and the kit's way, for the same
 *       zone and language, is identical (en, es, ja × three zones).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { formatTime } from "../../../packages/den-ui/src/time.js";

const PUBLIC = path.resolve(__dirname, "../../../src/ui/server/public");

/**
 * Real non-display uses (or a fallback that already honours the pick):
 * each with why.
 */
const ALLOW: Record<string, string> = {
  // A classic script: until the kit's module loads it draws with the
  // browser's Intl and <html data-den-tz>, then hands over to the kit.
  "shell.js": "fallback before /kit/time.js loads, with data-den-tz",
  // The log column: 24 hours with seconds so the column stays even, in the
  // kit's currentTimeZone().
  "logs.html": "fixed-width log clock in the kit's zone",
};

const FORMATS = /\.toLocale(?:Date|Time)?String\s*\(|Intl\.DateTimeFormat\s*\(/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|mjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("T1 guard: public/ never formats a date itself", () => {
  it("only the allow-list calls toLocale*String or Intl.DateTimeFormat", () => {
    const hits: string[] = [];
    for (const f of files(PUBLIC)) {
      const rel = path.relative(PUBLIC, f);
      if (ALLOW[rel]) continue;
      fs.readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (FORMATS.test(line)) hits.push(`${rel}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("the guard catches a local format (it can fail)", () => {
    expect(FORMATS.test("new Date(x).toLocaleTimeString([], {})")).toBe(true);
    expect(FORMATS.test("d.toLocaleString(lang)")).toBe(true);
    expect(FORMATS.test("new Intl.DateTimeFormat('en')")).toBe(true);
    expect(FORMATS.test("formatTime(iso, { style: 'time' })")).toBe(false);
  });

  it("every allow-listed file still exists", () => {
    for (const f of Object.keys(ALLOW))
      expect(fs.existsSync(path.join(PUBLIC, f))).toBe(true);
  });
});

// A page in Node: <html lang data-den-tz> and the shell's words, which hand
// back the value a line would show.
const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, window: g.window };
function page(lang: string, zone: string) {
  const dataset: Record<string, string> = { denTz: zone };
  g.document = {
    documentElement: {
      lang,
      dataset,
      getAttribute: (n: string) =>
        n === "lang" ? lang : n === "data-den-tz" ? zone : null,
    },
  };
}

const ISO = "2026-11-16T00:32:05Z";
const ZONES = ["America/Los_Angeles", "Asia/Tokyo", "UTC"];
const LANGS = ["en", "es", "ja"];

describe("T2 parity: Den's way = the kit's way, same zone and language", () => {
  let mods: Record<string, any>;
  beforeAll(async () => {
    g.window = {
      denShell: {
        t: (_k: string, v: Record<string, unknown> | undefined) =>
          v ? String(v.since ?? v.t ?? v.date ?? v.at ?? "") : _k,
      },
    };
    mods = {
      address: await import("../../../src/ui/server/public/address-card.js"),
      gate: await import("../../../src/ui/server/public/gate-chip.js"),
      bell: await import("../../../src/ui/server/public/bell.js"),
      verify: await import("../../../src/ui/server/public/verify-page.js"),
      settings: await import(
        "../../../src/ui/server/public/settings-registry.js"
      ),
    };
  });
  afterAll(() => {
    g.document = saved.document;
    g.window = saved.window;
  });

  for (const zone of ZONES)
    for (const lang of LANGS)
      it(`${zone} · ${lang}`, () => {
        page(lang, zone);
        const time = formatTime(ISO, { style: "time" });
        const datetime = formatTime(ISO);
        const date = formatTime(ISO, { style: "date" });
        // The kit itself reads the page's zone (sanity: not the process's).
        expect(time).toBe(
          formatTime(ISO, { style: "time", zone, locale: lang }),
        );

        expect(mods.address.clock(ISO)).toBe(time);
        expect(mods.gate.gateTime(ISO)).toBe(time);
        expect(
          mods.bell.noteText({ msg: { key: "bell.m.x", vars: { since: ISO } } }),
        ).toBe(datetime);
        expect(mods.verify.metaLine({ endedAt: ISO })).toBe(datetime);
        expect(
          mods.settings.accountLine(
            { configured: true, set_at: ISO },
            (_k: string, v: Record<string, string>) => v?.date ?? _k,
          ).text,
        ).toBe(date);
        expect(mods.settings.appKeyWhen(ISO)).toBe(datetime);
      });
});
