/**
 * den-ui, issue 554: the settings on/off row (setting-row.js), the checks
 * that need no browser.
 *
 *   - settingRowHtml draws, from data: a checkbox and its label, a help
 *     line, Save (the kit's button), the save-state line (savestate.css's
 *     look) and a line "who can change this · last changed".
 *   - The host gives its own words (the label, the help, who) as data; the
 *     kit's words are its own, in en, es and ja.
 *   - The checkbox is described by the help and the line; a person who
 *     can't change it gets it and Save disabled.
 *   - With `form`, the row is a form that posts with no script (csrf in a
 *     hidden field); without, Save is a plain button the client wires.
 *
 * The browser half (Save calls onSave, the states, keys and focus, the
 * look in light and dark at 1280 and 390) is kit-button-menu-row.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import { settingRowHtml } from "../../../packages/den-ui/src/setting-row.js";
import * as strings from "../../../packages/den-ui/src/strings.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;

const NOW = "2026-11-18T10:42:00.000Z";
const base = {
  id: "downloads",
  label: "Owners can download",
  help: "Each download is in the history.",
  checked: true,
  who: ["Admins", "Owners"],
  last: { by: "@sam", at: "2026-11-18T10:40:00.000Z" },
  now: NOW,
  zone: "UTC",
};

/** The element's text, tags out, spaces folded. */
const text = (html: string) =>
  html
    .replace(/<\/?time[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const attr = (html: string, sel: RegExp) => html.match(sel)?.[1] ?? null;

describe("settingRowHtml (setting-row.js)", () => {
  it("draws the checkbox, its label, the help, Save and the line, in order", () => {
    const h = settingRowHtml({ ...base, lang: "en" });
    expect(h).toMatch(
      /^<div class="den-setrow" id="downloads" data-den-setrow>/,
    );
    expect(h).toContain(
      '<label class="den-setrow-l"><input type="checkbox" id="downloads-cb" name="downloads" value="on" aria-describedby="downloads-help downloads-meta" checked> <span>Owners can download</span></label>',
    );
    expect(h).toContain(
      '<p class="den-setrow-help" id="downloads-help">Each download is in the history.</p>',
    );
    // Save is the kit's button; the state line wears savestate.css's look.
    expect(h).toContain(
      '<button type="button" class="den-btn" data-den-setrow-save>Save</button>',
    );
    expect(h).toContain(
      '<p class="den-savestate den-setrow-state" id="downloads-state" data-state="idle" role="status"></p>',
    );
    expect(text(h)).toBe(
      "Owners can download Each download is in the history. Save Admins and Owners can change this · Last changed 2 minutes ago by @sam",
    );
    const order = [
      'type="checkbox"',
      "den-setrow-help",
      "data-den-setrow-save",
      "den-setrow-state",
      "den-setrow-meta",
    ].map((s) => h.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > 0)).toBe(true);
  });

  it("the time is a <time> the kit can draw again, in the row's language", () => {
    const h = settingRowHtml({ ...base, lang: "en" });
    expect(h).toContain('<time datetime="2026-11-18T10:40:00.000Z" title="');
    expect(h).toContain('data-den-time="relative">2 minutes ago</time>');
  });

  it("an unchecked row, no changes yet, one who, and nobody", () => {
    const h = settingRowHtml({
      ...base,
      checked: false,
      who: ["Owners"],
      last: null,
      lang: "en",
    });
    expect(h).not.toMatch(/ checked[ >]/);
    expect(text(h)).toContain("Owners can change this · No changes yet");
    expect(
      text(settingRowHtml({ ...base, who: [], last: null, lang: "en" })),
    ).toContain("Nobody can change this · No changes yet");
  });

  it("no help: the checkbox is described by the line alone", () => {
    const h = settingRowHtml({ ...base, help: "", lang: "en" });
    expect(h).not.toContain("den-setrow-help");
    expect(attr(h, /aria-describedby="([^"]*)"/)).toBe("downloads-meta");
  });

  it("a person who can't change it: the checkbox and Save are disabled", () => {
    const h = settingRowHtml({ ...base, readOnly: true, lang: "en" });
    expect(h).toMatch(/<input type="checkbox"[^>]* checked disabled>/);
    expect(h).toContain(
      '<button type="button" class="den-btn" data-den-setrow-save disabled>Save</button>',
    );
  });

  it("the save state, drawn: saving, saved and error words are the kit's", () => {
    const st = (state: string, lang = "en") =>
      text(
        settingRowHtml({ ...base, state, lang } as Parameters<
          typeof settingRowHtml
        >[0]).match(/<p class="den-savestate[^"]*"[^>]*>[\s\S]*?<\/p>/)![0],
      );
    expect([st("idle"), st("saving"), st("saved"), st("error")]).toEqual([
      "",
      "Saving…",
      "Saved",
      "Not saved. Try again.",
    ]);
    expect(st("saved", "es")).toBe("Guardado");
    expect(st("error", "ja")).toBe(
      "保存できませんでした。もう一度お試しください。",
    );
    // An unknown state draws idle.
    expect(
      settingRowHtml({ ...base, state: "nope" } as unknown as Parameters<
        typeof settingRowHtml
      >[0]),
    ).toContain('data-state="idle"');
  });

  it("speaks es and ja: Save, who, last changed, nobody", () => {
    expect(text(settingRowHtml({ ...base, lang: "es" }))).toContain(
      "Guardar Admins y Owners pueden cambiar esto · Último cambio: hace 2 minutos, por @sam",
    );
    expect(text(settingRowHtml({ ...base, lang: "ja" }))).toContain(
      "保存 Admins、Ownersが変更できます · 最終変更: 2 分前（@sam）",
    );
    expect(
      text(settingRowHtml({ ...base, who: [], last: null, lang: "ja" })),
    ).toContain("誰も変更できません · まだ変更はありません");
  });

  it("escapes the host's words; the id is kept to safe characters", () => {
    const h = settingRowHtml({
      ...base,
      id: 'a"b <c>',
      label: "<b>x</b>",
      help: "y & z",
      who: ["<i>r</i>"],
      last: { by: "<s>", at: base.last.at },
      lang: "en",
    });
    expect(h).not.toMatch(/<(b|i|s|c)>/);
    expect(h).toContain('id="a-b--c-"');
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("with form: a form that posts with no script, csrf in a hidden field", () => {
    const h = settingRowHtml({
      ...base,
      form: { action: "/settings/downloads", csrf: "t0k" },
      lang: "en",
    });
    expect(h).toMatch(
      /^<form class="den-setrow" id="downloads" data-den-setrow method="post" action="\/settings\/downloads">/,
    );
    expect(h).toContain('<input type="hidden" name="csrf" value="t0k">');
    expect(h).toContain(
      '<button type="submit" class="den-btn" data-den-setrow-save>Save</button>',
    );
    expect(h).toMatch(/<\/form>$/);
    const named = settingRowHtml({
      ...base,
      name: "dl",
      form: { action: "/s", method: "get", csrf: "t", field: "_tok" },
      lang: "en",
    });
    expect(named).toContain('method="get"');
    expect(named).toContain('name="_tok" value="t"');
    expect(named).toContain('name="dl" value="on"');
  });

  it("its words are in all three tables, with the same holes", () => {
    for (const k of [
      "kit.setrow.save",
      "kit.setrow.who",
      "kit.setrow.nobody",
      "kit.setrow.last",
      "kit.setrow.never",
      "kit.setrow.error",
    ]) {
      expect([k, typeof en[k]]).toEqual([k, "string"]);
      expect([k, typeof es[k]]).toEqual([k, "string"]);
      expect([k, typeof ja[k]]).toEqual([k, "string"]);
    }
  });
});
