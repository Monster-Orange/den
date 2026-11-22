/**
 * den-ui, issue 584: the text-field settings row (setting-field.js) and
 * the kit's shared button verbs.
 *
 *   - settingFieldHtml draws, from data: a label, a single-line input or a
 *     multi-line box, help text, Save, and an error line under the input.
 *   - The host's words come as its own text or as { key, vars }; Save is a
 *     shared verb by key, or the host's own words ("Save folders").
 *   - Save is disabled until the value changes; while it saves it goes
 *     through the kit's working pop-up; done, the row shows the saved
 *     value and Save is disabled again.
 *   - Save, Cancel, Delete, Close and Try again are in en, es and ja.
 *
 * Its look in a browser (light and dark, 1280 and 390) rides the kit's
 * browser suites; these are the checks that need no browser.
 */
import { describe, expect, it } from "@jest/globals";
import {
  hydrateSettingField,
  settingFieldHtml,
} from "../../../packages/den-ui/src/setting-field.js";
import * as strings from "../../../packages/den-ui/src/strings.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;
const VERBS = ["save", "cancel", "delete", "close", "tryAgain"];

const base = {
  id: "folders",
  label: "Folders it may read",
  help: "One folder per line.",
  value: ["~/notes", "~/code"],
  multiline: true,
  placeholder: "~/notes",
};

/** The text, tags out, spaces folded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("the shared verbs (strings.js)", () => {
  it("Save, Cancel, Delete, Close and Try again are in en, es and ja", () => {
    for (const v of VERBS)
      for (const [lang, t] of Object.entries({ en, es, ja }))
        expect([lang, v, typeof t[`kit.verb.${v}`]]).toEqual([
          lang,
          v,
          "string",
        ]);
    expect(en["kit.verb.tryAgain"]).toBe("Try again");
    expect(es["kit.verb.save"]).toBe("Guardar");
    expect(ja["kit.verb.close"]).toBe("閉じる");
  });
});

describe("settingFieldHtml (setting-field.js)", () => {
  it.each([
    ["en", "Save"],
    ["es", "Guardar"],
    ["ja", "保存"],
  ])("draws the label, box, help, Save and error line in %s", (lang, save) => {
    const h = settingFieldHtml({ ...base, lang });
    expect(h).toMatch(
      /^<div class="den-setfield" id="folders" data-den-setfield>/,
    );
    expect(h).toContain(
      '<label class="den-setfield-l" for="folders-in">Folders it may read</label>',
    );
    // Multi-line: one value per line, in a textarea, described by the help.
    expect(h).toContain(
      '<textarea id="folders-in" name="folders" rows="4" placeholder="~/notes" aria-describedby="folders-help folders-err">~/notes\n~/code</textarea>',
    );
    expect(h).toContain(
      '<p class="den-setfield-help" id="folders-help">One folder per line.</p>',
    );
    expect(h).toContain(
      '<p class="den-setfield-err" id="folders-err" role="alert" hidden></p>',
    );
    // Save: the kit's button, its shared verb, disabled until a change.
    expect(h).toMatch(
      new RegExp(
        `<button type="button" class="den-btn primary sm" data-den-setfield-save="" disabled>${save}</button>`,
      ),
    );
  });

  it("single-line: an input with the value", () => {
    const h = settingFieldHtml({
      id: "url",
      label: "Address",
      value: "https://a.example",
    });
    expect(h).toContain(
      '<input type="text" id="url-in" name="url" value="https://a.example" aria-describedby="url-err">',
    );
    expect(h).not.toContain("<textarea");
  });

  it("the host's words as { key, vars }, and its own Save words", () => {
    strings.addStrings("en", { "host.f.label": "Folders for {who}" });
    const h = settingFieldHtml({
      ...base,
      lang: "en",
      label: { key: "host.f.label", vars: { who: "Ana" } },
      save: "Save folders",
    });
    expect(text(h)).toContain("Folders for Ana");
    expect(h).toContain(
      'data-den-setfield-save="" disabled>Save folders</button>',
    );
    // A shared verb by key.
    expect(
      settingFieldHtml({ ...base, lang: "es", save: { verb: "tryAgain" } }),
    ).toContain(
      `data-den-setfield-save="" disabled>${es["kit.verb.tryAgain"]}</button>`,
    );
  });

  it("HTML in a value, a label or help is escaped", () => {
    const h = settingFieldHtml({
      id: "x",
      label: "<b>L</b>",
      help: '<img src=x onerror="1">',
      value: '</textarea><script>alert(1)</script>"',
      placeholder: '"><i>',
      multiline: true,
    });
    expect(h).not.toMatch(/<script|<img|<b>|<i>|<\/textarea><script/);
    expect(h).toContain("&lt;/textarea&gt;&lt;script&gt;");
    expect(h).toContain('placeholder="&quot;&gt;&lt;i&gt;"');
  });

  it("an error drawn at once, and a row nobody can change", () => {
    const h = settingFieldHtml({
      ...base,
      error: "Not a folder: ~/x",
      readOnly: true,
    });
    expect(h).toContain(
      '<p class="den-setfield-err" id="folders-err" role="alert">Not a folder: ~/x</p>',
    );
    expect(h).toMatch(/<textarea[^>]* readonly/);
  });
});

/** A stand-in for the drawn row: the box, Save and the error line. */
function fakeRow(value: string) {
  const handlers: Record<string, ((e?: unknown) => void)[]> = {};
  const on =
    (el: Record<string, unknown>, name: string) =>
    (t: string, f: (e?: unknown) => void) => {
      (handlers[`${name}:${t}`] ??= []).push(f);
      void el;
    };
  const box: Record<string, unknown> = { value, readOnly: false };
  box.addEventListener = on(box, "box");
  box.removeEventListener = () => {};
  const save: Record<string, unknown> = { disabled: true };
  save.addEventListener = on(save, "save");
  save.removeEventListener = () => {};
  const err: Record<string, unknown> = { hidden: true, textContent: "" };
  const el = {
    querySelector: (s: string) =>
      s.includes("save") ? save : s.includes("err") ? err : box,
    getAttribute: () => null,
    closest: () => null,
  };
  const fire = (k: string) =>
    (handlers[k] ?? []).forEach((f) => f({ preventDefault() {} }));
  return { el, box, save, err, fire };
}

describe("hydrateSettingField: Save follows the value", () => {
  it("disabled until the value changes; back to the saved value, disabled again", () => {
    const r = fakeRow("a\nb");
    hydrateSettingField(r.el as never, { onSave: async () => {} });
    expect(r.save.disabled).toBe(true);
    r.box.value = "a\nb\nc";
    r.fire("box:input");
    expect(r.save.disabled).toBe(false);
    r.box.value = "a\nb";
    r.fire("box:input");
    expect(r.save.disabled).toBe(true);
  });

  it("Save goes through the working pop-up; done, it shows the saved value", async () => {
    const r = fakeRow("a");
    const seen: unknown[] = [];
    const row = hydrateSettingField(r.el as never, {
      onSave: async (v: string, lines: string[]) => {
        seen.push([v, lines]);
        return " a ,b "; // the value as it was saved
      },
      busy: async (btn: unknown, run: () => Promise<unknown>) => {
        seen.push(btn === r.save ? "pop-up" : "?");
        return run();
      },
    });
    r.box.value = "a\n\n b ";
    r.fire("box:input");
    await row.save();
    expect(seen).toEqual(["pop-up", ["a\n\n b ", ["a", "b"]]]);
    expect(r.box.value).toBe(" a ,b ");
    expect(r.save.disabled).toBe(true);
    expect(r.err.hidden).toBe(true);
  });

  it("a refused save shows its words under the box and keeps Save on", async () => {
    const r = fakeRow("a");
    const row = hydrateSettingField(r.el as never, {
      lang: "es",
      onSave: async () => {
        throw new Error("nope");
      },
      busy: async (_b: unknown, run: () => Promise<unknown>) => run(),
    });
    r.box.value = "b";
    r.fire("box:input");
    await row.save();
    expect(r.err.hidden).toBe(false);
    expect(r.err.textContent).toBe(es["kit.setrow.error"]);
    expect(r.save.disabled).toBe(false);
    // Typing again clears it.
    r.fire("box:input");
    expect(r.err.hidden).toBe(true);
  });
});
