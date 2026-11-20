/**
 * den-ui, issue 584: the settings row's text-field variant
 * (settingFieldHtml in setting-row.js) and the kit's shared verbs, the
 * checks that need no browser.
 *
 *   - settingFieldHtml draws, from data: a label, a single-line input or a
 *     multi-line textarea, an error line under it, a help line, Save (the
 *     kit's button) and the save-state line (savestate.css's look).
 *   - The host's words are text or { key, vars } in the kit's tables; the
 *     kit's own words (Save, the states) are its own, in en, es and ja.
 *   - HTML in a value (or any of the host's words) is escaped.
 *   - Save is drawn disabled: nothing has changed yet. A form row (it posts
 *     with no script) draws it enabled; the client disables it on wiring.
 *   - The shared verbs (Save, Cancel, Delete, Close, Try again) are in all
 *     three tables, picked by key.
 *
 * The browser half (typing enables Save, Save runs onSave through the
 * working pop-up, the saved value, the error line) is
 * setting-text-row.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import { settingFieldHtml } from "../../../packages/den-ui/src/setting-row.js";
import * as strings from "../../../packages/den-ui/src/strings.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;
const { addStrings, kitVerb, VERBS } = strings as unknown as {
  addStrings: (lang: string, t: Table) => void;
  kitVerb: (lang: string | undefined, verb: string) => string;
  VERBS: readonly string[];
};

const base = {
  id: "folders",
  label: "Folders to watch",
  help: "One folder per line.",
  value: "notes\ndrafts",
  placeholder: "docs",
  multiline: true,
};

/** The element's text, tags out, spaces folded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("settingFieldHtml (setting-row.js)", () => {
  it("draws the label, the textarea, the error line, the help, Save and the line, in order", () => {
    const h = settingFieldHtml({ ...base, lang: "en" });
    expect(h).toMatch(
      /^<div class="den-setrow den-setfield" id="folders" data-den-setfield>/,
    );
    expect(h).toContain(
      '<label class="den-setfield-l" for="folders-in">Folders to watch</label>',
    );
    // A textarea keeps a leading newline of its value: one is added first.
    expect(h).toContain(
      '<textarea class="den-setfield-in" id="folders-in" name="folders" rows="4" placeholder="docs" aria-describedby="folders-err folders-help">\nnotes\ndrafts</textarea>',
    );
    expect(h).toContain(
      '<p class="den-setfield-err" id="folders-err" aria-live="polite"></p>',
    );
    expect(h).toContain(
      '<p class="den-setrow-help" id="folders-help">One folder per line.</p>',
    );
    expect(h).toContain(
      '<button type="button" class="den-btn" data-den-setfield-save disabled>Save</button>',
    );
    expect(h).toContain(
      '<p class="den-savestate den-setrow-state" id="folders-state" data-state="idle" role="status"></p>',
    );
    const order = [
      "den-setfield-l",
      "<textarea",
      "den-setfield-err",
      "den-setrow-help",
      "data-den-setfield-save",
      "den-setrow-state",
    ].map((s) => h.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(h).toMatch(/<\/div><\/div>$/);
  });

  it("single-line: an input with the value in its value attribute", () => {
    const h = settingFieldHtml({
      id: "host",
      label: "Host name",
      value: "web.example.com",
      lang: "en",
    });
    expect(h).toContain(
      '<input type="text" class="den-setfield-in" id="host-in" name="host" value="web.example.com" aria-describedby="host-err">',
    );
    expect(h).not.toContain("<textarea");
    expect(h).not.toContain("den-setrow-help");
  });

  it("renders from data in en, es and ja: the kit's Save and states, the host's words", () => {
    const st = (lang: string, state: string) =>
      text(
        settingFieldHtml({ ...base, lang, state } as Parameters<
          typeof settingFieldHtml
        >[0]).match(/<p class="den-savestate[^"]*"[^>]*>[\s\S]*?<\/p>/)![0],
      );
    expect(text(settingFieldHtml({ ...base, lang: "en" }))).toBe(
      "Folders to watch notes drafts One folder per line. Save",
    );
    expect(text(settingFieldHtml({ ...base, lang: "es" }))).toBe(
      "Folders to watch notes drafts One folder per line. Guardar",
    );
    expect(text(settingFieldHtml({ ...base, lang: "ja" }))).toBe(
      "Folders to watch notes drafts One folder per line. 保存",
    );
    expect(["en", "es", "ja"].map((l) => st(l, "saving"))).toEqual([
      "Saving…",
      "Guardando…",
      "保存しています…",
    ]);
    expect(["en", "es", "ja"].map((l) => st(l, "saved"))).toEqual([
      "Saved",
      "Guardado",
      "保存しました",
    ]);
  });

  it("the host's words may be { key, vars } in the kit's tables, in its language", () => {
    addStrings("en", {
      "app.folders": "Folders for {who}",
      "app.folders.save": "Save folders",
    });
    addStrings("es", {
      "app.folders": "Carpetas de {who}",
      "app.folders.save": "Guardar carpetas",
    });
    addStrings("ja", {
      "app.folders": "{who} のフォルダー",
      "app.folders.save": "フォルダーを保存",
    });
    const words = (lang: string) =>
      text(
        settingFieldHtml({
          id: "f",
          label: { key: "app.folders", vars: { who: "Sam" } },
          help: { key: "kit.verb.close" },
          saveLabel: { key: "app.folders.save" },
          lang,
        }),
      );
    expect(words("en")).toBe("Folders for Sam Close Save folders");
    expect(words("es")).toBe("Carpetas de Sam Cerrar Guardar carpetas");
    expect(words("ja")).toBe("Sam のフォルダー 閉じる フォルダーを保存");
    // A host-only action keeps the host's own words.
    expect(
      text(
        settingFieldHtml({
          id: "f",
          label: "L",
          saveLabel: "Keep",
          lang: "ja",
        }),
      ),
    ).toBe("L Keep");
  });

  it("escapes HTML in the value and in every one of the host's words", () => {
    const evil = '"><script>alert(1)</script>&';
    const one = settingFieldHtml({
      id: 'a"b <c>',
      name: 'n"<x>',
      label: "<b>x</b>",
      help: "<i>h</i>",
      value: evil,
      placeholder: "<p>",
      error: "<s>bad</s>",
      saveLabel: "<u>go</u>",
      lang: "en",
    });
    const many = settingFieldHtml({
      id: "m",
      label: "L",
      value: evil,
      multiline: true,
      lang: "en",
    });
    for (const h of [one, many]) {
      expect(h).not.toMatch(/<(script|b|i|s|u|p|c|x)>/);
      expect(h).not.toContain('"><script');
    }
    expect(one).toContain(
      'value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;"',
    );
    expect(one).toContain('id="a-b--c-"');
    expect(one).toContain('name="n&quot;&lt;x&gt;"');
    expect(many).toContain(
      ">\n&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;</textarea>",
    );
  });

  it("Save is disabled until the value changes: drawn disabled; read-only stays so", () => {
    const h = settingFieldHtml({ ...base, lang: "en" });
    expect(h).toMatch(/<button[^>]*data-den-setfield-save disabled>/);
    const ro = settingFieldHtml({ ...base, readOnly: true, lang: "en" });
    expect(ro).toMatch(/<textarea[^>]* readonly>/);
    expect(ro).toMatch(/<button[^>]*data-den-setfield-save disabled>/);
  });

  it("an error: under the input, the input marked invalid and described by it", () => {
    const h = settingFieldHtml({
      ...base,
      error: "That folder doesn't exist.",
      lang: "en",
    });
    expect(h).toContain(
      '<p class="den-setfield-err" id="folders-err" aria-live="polite">That folder doesn&#39;t exist.</p>',
    );
    expect(h).toMatch(/<textarea[^>]* aria-invalid="true"/);
    // The error state with no words of the host's: the kit's.
    const kitWords = (lang: string) =>
      settingFieldHtml({ ...base, state: "error", lang }).match(
        /<p class="den-setfield-err"[^>]*>([^<]*)<\/p>/,
      )![1];
    expect(["en", "es", "ja"].map(kitWords)).toEqual([
      "Not saved. Try again.",
      "No se guardó. Inténtalo de nuevo.",
      "保存できませんでした。もう一度お試しください。",
    ]);
  });

  it("with form: a form that posts with no script; Save drawn enabled", () => {
    const h = settingFieldHtml({
      ...base,
      form: { action: "/settings/folders", csrf: "t0k" },
      lang: "en",
    });
    expect(h).toMatch(
      /^<form class="den-setrow den-setfield" id="folders" data-den-setfield method="post" action="\/settings\/folders">/,
    );
    expect(h).toContain('<input type="hidden" name="csrf" value="t0k">');
    expect(h).toContain(
      '<button type="submit" class="den-btn" data-den-setfield-save>Save</button>',
    );
    expect(h).toMatch(/<\/form>$/);
  });

  it("who can change it and its last change, when the host gives them", () => {
    const h = settingFieldHtml({
      ...base,
      who: ["Owners"],
      last: null,
      lang: "en",
    });
    expect(h).toContain(
      '<p class="den-setrow-meta" id="folders-meta">Owners can change this · No changes yet</p>',
    );
    expect(h).toContain(
      'aria-describedby="folders-err folders-help folders-meta"',
    );
  });
});

describe("the shared verbs (strings.js)", () => {
  const KEYS = [
    "kit.verb.save",
    "kit.verb.cancel",
    "kit.verb.delete",
    "kit.verb.close",
    "kit.verb.retry",
  ];

  it("Save, Cancel, Delete, Close and Try again are in en, es and ja", () => {
    expect([...VERBS]).toEqual(["save", "cancel", "delete", "close", "retry"]);
    for (const k of KEYS)
      for (const [lang, t] of Object.entries({ en, es, ja }))
        expect([lang, k, typeof t[k], (t[k] ?? "").trim() !== ""]).toEqual([
          lang,
          k,
          "string",
          true,
        ]);
    expect(KEYS.map((k) => en[k])).toEqual([
      "Save",
      "Cancel",
      "Delete",
      "Close",
      "Try again",
    ]);
    expect(KEYS.map((k) => es[k])).toEqual([
      "Guardar",
      "Cancelar",
      "Eliminar",
      "Cerrar",
      "Intentar de nuevo",
    ]);
    expect(KEYS.map((k) => ja[k])).toEqual([
      "保存",
      "キャンセル",
      "削除",
      "閉じる",
      "もう一度試す",
    ]);
  });

  it("kitVerb picks one by key, in the language (en for any other)", () => {
    expect(VERBS.map((v) => kitVerb("es", v))).toEqual(KEYS.map((k) => es[k]));
    expect(kitVerb("ja", "delete")).toBe("削除");
    expect(kitVerb("fr", "close")).toBe("Close");
    expect(kitVerb(undefined, "retry")).toBe("Try again");
  });

  it("Save in the field row is the shared verb", () => {
    for (const lang of ["en", "es", "ja"])
      expect(
        settingFieldHtml({ id: "x", label: "L", lang }).match(
          /data-den-setfield-save disabled>([^<]*)</,
        )![1],
      ).toBe(kitVerb(lang, "save"));
  });
});
