/**
 * den#133: the kit's ask-and-tell dialogs (packages/den-ui/src/dialog.js),
 * the checks that need no browser:
 *
 *   - dialog.js names no product and has no colour of its own;
 *   - its shared words have the same keys in en, es and ja;
 *   - the markup: role, names, the danger OK, Cancel's place, the field,
 *     the product's Report in the footer, everything escaped;
 *   - where focus starts and what each kind answers;
 *   - Den serves it (/kit/dialog.js, /dialog-den.js);
 *   - the Projects and Services pages call no native confirm(), prompt()
 *     or alert(), and every dlg.* key they use is in Den's en catalog.
 *
 * The browser half (es and ja, Esc, focus, Report, 375 px) is
 * tests/unit/server/kit-dialog.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  DIALOG_WORDS,
  answerOf,
  configureDialog,
  dialogHtml,
  dialogWord,
  firstFocus,
} from "../../../packages/den-ui/src/dialog.js";
import { UI_MODULES, kitAssetFile } from "../../../src/ui/server/ui-assets.js";
import { catalogSource } from "../server/helpers/en-catalog.js";

const ROOT = path.join(__dirname, "../../..");
const SRC = fs.readFileSync(
  path.join(ROOT, "packages/den-ui/src/dialog.js"),
  "utf-8",
);
const PUBLIC = path.join(ROOT, "src/ui/server/public");

/** Each product name in a source. */
const productNames = (src: string): string[] =>
  [...src.matchAll(/\b[dD]en(?:[A-Z_$][\w$]*)?\b/g)].map((m) => m[0]);

/** Native dialog calls left in a page's code, comments taken out. */
export function nativeCalls(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return [
    ...code.matchAll(/(?<![\w.$])(?:window\.)?(confirm|prompt|alert)\s*\(/g),
  ].map((m) => m[1]!);
}

const ids = { h: "h1", m: "m1" };

describe("den#133 kit: dialog.js stands alone", () => {
  it("finds a product name when one is there (the check can fail)", () => {
    expect(productNames("window.denShell.t")).toEqual(["denShell"]);
  });
  it("names no product", () => {
    expect(productNames(SRC)).toEqual([]);
  });
  it("has no colour of its own (tokens only)", () => {
    expect(SRC.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(SRC.match(/\brgba?\(|\bhsla?\(/g) ?? []).toEqual([]);
  });
  it("en, es and ja have the same words", () => {
    const en = Object.keys(DIALOG_WORDS.en).sort();
    expect(Object.keys(DIALOG_WORDS).sort()).toEqual(["en", "es", "ja"]);
    expect(Object.keys(DIALOG_WORDS.es).sort()).toEqual(en);
    expect(Object.keys(DIALOG_WORDS.ja).sort()).toEqual(en);
  });
});

describe("den#133 kit: the words and the markup", () => {
  it("a product's words win; the kit's are the fallback", () => {
    configureDialog({ lang: () => "es", words: {}, report: null });
    expect(dialogWord("cancel")).toBe("Cancelar");
    configureDialog({ words: { es: { cancel: "Mejor no" } } });
    expect(dialogWord("cancel")).toBe("Mejor no");
    configureDialog({ lang: () => "xx", words: {} });
    expect(dialogWord("ok")).toBe("OK");
  });

  it("confirm: a danger OK, Cancel before it, the Report first, escaped", () => {
    configureDialog({
      lang: () => "en",
      words: {},
      report: () => '<button data-report="x">Report</button>',
    });
    const html = dialogHtml(
      "confirm",
      { title: "Gone <b>?", message: 'a "b"\nc', danger: true, okLabel: "Go" },
      ids,
    );
    expect(html).toContain('<h2 id="h1">Gone &lt;b&gt;?</h2>');
    expect(html).toContain('<p class="dk-msg" id="m1">a &quot;b&quot;\nc</p>');
    expect(html).toMatch(
      /class="dk-ft"><button data-report="x">Report<\/button><button type="button" class="dk-btn" data-dk="cancel">Cancel<\/button><button type="submit" class="dk-btn dk-danger" data-dk="ok">Go<\/button>/,
    );
    expect(html).not.toContain("dk-primary");
  });

  it("text: a field with its first value; tell: no Cancel; no Report when off", () => {
    configureDialog({ report: () => "" });
    const text = dialogHtml("text", { title: "Rename", value: 'x"y' }, ids);
    expect(text).toContain('data-dk="field"');
    expect(text).toContain('value="x&quot;y"');
    expect(text).toContain('aria-label="Rename"');
    expect(text).toContain("dk-primary");
    const tellHtml = dialogHtml("tell", { message: "Done" }, ids);
    expect(tellHtml).not.toContain('data-dk="cancel"');
    expect(tellHtml).not.toContain("Report");
  });

  it("focus starts on the safe answer for danger, the field for text, else OK", () => {
    expect(firstFocus("confirm", { danger: true })).toBe("cancel");
    expect(firstFocus("confirm", {})).toBe("ok");
    expect(firstFocus("text", { danger: true })).toBe("field");
    expect(firstFocus("tell", {})).toBe("ok");
  });

  it("answers: confirm true/false, text the text or null, tell nothing", () => {
    expect(answerOf("confirm", true)).toBe(true);
    expect(answerOf("confirm", false)).toBe(false);
    expect(answerOf("text", true, "north")).toBe("north");
    expect(answerOf("text", true, "")).toBe("");
    expect(answerOf("text", false, "north")).toBeNull();
    expect(answerOf("tell", true)).toBeUndefined();
  });

  it("confirm and tell are alertdialogs, text a dialog; each named and described", () => {
    expect(SRC).toMatch(/kind === "text" \? "dialog" : "alertdialog"/);
    expect(SRC).toContain('"aria-labelledby"');
    expect(SRC).toContain('"aria-describedby"');
  });
});

describe("den#133: Den serves it and its pages use it", () => {
  it("/kit/dialog.js and /dialog-den.js are served", () => {
    expect(kitAssetFile("/kit/dialog.js", ROOT)).toBe(
      path.join(ROOT, "packages/den-ui/src/dialog.js"),
    );
    expect(UI_MODULES).toContain("/dialog-den.js");
  });

  it("finds a native call when one is there (the check can fail)", () => {
    expect(nativeCalls('if (!confirm(`x`)) return;\n// confirm("no")')).toEqual(
      ["confirm"],
    );
    expect(nativeCalls("const v = prompt('a', b); window.alert(1);")).toEqual([
      "prompt",
      "alert",
    ]);
    expect(nativeCalls("await askConfirm({}); x.confirm(1);")).toEqual([]);
  });

  it.each(["local-dev.html", "services.html"])(
    "%s calls no native confirm, prompt or alert",
    (file) => {
      const src = fs.readFileSync(path.join(PUBLIC, file), "utf-8");
      expect(nativeCalls(src)).toEqual([]);
      expect(src).toContain('from "/dialog-den.js"');
    },
  );

  it("every dlg.* key the pages use is in Den's en catalog", () => {
    const en = catalogSource("en");
    const used = new Set<string>();
    for (const f of ["local-dev.html", "services.html", "dialog-den.js"])
      for (const m of fs
        .readFileSync(path.join(PUBLIC, f), "utf-8")
        .matchAll(/["'](dlg\.[\w.]+)["']/g))
        used.add(m[1]!);
    expect(used.size).toBeGreaterThan(10);
    const missing = [...used].filter((k) => !en.includes(`"${k}":`));
    expect(missing).toEqual([]);
  });
});
