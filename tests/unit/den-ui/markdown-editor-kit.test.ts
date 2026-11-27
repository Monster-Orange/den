/**
 * den-ui 0.7.5: the kit's Markdown editor (packages/den-ui/src/
 * markdown-editor.js), the checks that need no browser. Ported from an
 * existing editor's own tests, adapted to the kit:
 *
 *   - the editor's document IS the stored Markdown, byte for byte (no
 *     HTML, no re-serializer), through a CodeMirror transaction too;
 *   - the live preview only draws: ranges inside the text, replacements
 *     never overlapping, markers hidden on lines being read and shown on
 *     the line being edited, the safe subset only;
 *   - the formatting commands type the markers and undo them; Enter in a
 *     list continues it; a block or a link goes where the caret is;
 *   - IME: the Enter that confirms a conversion never sends or submits,
 *     every Enter binding checks the composition first, the preview
 *     freezes while composing, the length limit never cuts a composition;
 *   - the lazy chunk: the module imports no CodeMirror statically, its
 *     packages are pinned exactly, and Den's own pages never load it;
 *   - accessible (named, described, a named toolbar) and tokens only;
 *   - its words are the kit's, in en, es and ja.
 *
 * The browser half (typing, the preview in place, IME Enter, the stand-in
 * handing over) is markdown-editor.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { EditorSelection, EditorState } from "@codemirror/state";
import * as lezerMarkdown from "@lezer/markdown";
import {
  COMPOSITION_GRACE_MS,
  applyEdit,
  composingKey,
  continueBlock,
  enterAction,
  insertBlock,
  insertLink,
  insertLinkTo,
  livePreview,
  markdownParser,
  toggleBlock,
  toggleInline,
} from "../../../packages/den-ui/src/markdown-editor.js";
import { en, es, ja } from "../../../packages/den-ui/src/strings.js";
import { KIT_FILES } from "../../../src/ui/server/ui-assets.js";

const ROOT = path.join(__dirname, "../../..");
const KIT = path.join(ROOT, "packages/den-ui");
const SRC = fs.readFileSync(path.join(KIT, "src/markdown-editor.js"), "utf-8");
const CSS = fs.readFileSync(path.join(KIT, "src/markdown-editor.css"), "utf-8");
const parser = markdownParser(lezerMarkdown);
const tokensHave = (t: string) =>
  fs.readFileSync(path.join(KIT, "src/tokens.css"), "utf-8").includes(`${t}:`);
type Range = ReturnType<typeof livePreview>[number];
const preview = (s: string, sel: Array<[number, number]> = []): Range[] =>
  livePreview(s, sel, parser);

const SAMPLES = [
  "__bold__ and *em* and _em_",
  "* star bullet\n* two",
  "1) paren list\n2) two",
  "日本語を**読む**。おはよう",
  "snake_case_name and 2 * 3 * 4",
  "line one\nline two",
  "plain **unclosed",
  "~~strike~~  trailing spaces  \n\n\n> quote\n```\ncode **not bold**\n```",
  "<img src=x onerror=alert(1)> [x](javascript:alert(1))",
];

describe("the source", () => {
  it("the editor's document IS the stored Markdown, byte for byte", () => {
    for (const s of SAMPLES) {
      const state = EditorState.create({ doc: s });
      expect(state.doc.toString()).toBe(s);
      // An edit elsewhere leaves every other byte alone.
      const typed = state
        .update({ changes: { from: s.length, to: s.length, insert: " ok" } })
        .state.doc.toString();
      expect(typed).toBe(s + " ok");
    }
  });

  it("the live preview only draws: inside the text, replacements never overlap", () => {
    for (const s of SAMPLES) {
      let end = -1;
      for (const r of preview(s)) {
        expect(r.from >= 0 && r.from <= s.length).toBe(true);
        if ("to" in r) expect(r.to <= s.length && r.to >= r.from).toBe(true);
        if (r.kind === "hide" || r.kind === "bullet") {
          expect([s, r.from >= end]).toEqual([s, true]);
          end = r.to;
        }
      }
    }
  });

  it("markers hide on lines being read and show on the line being edited", () => {
    const s = "## Hi **b** `c`\n- one [x](https://a.b)\n> q";
    const reading = preview(s);
    const hidden = (t: string) =>
      reading.some((r) => r.kind === "hide" && s.slice(r.from, r.to) === t);
    expect(hidden("## ")).toBe(true);
    expect(hidden("**")).toBe(true);
    expect(hidden("`")).toBe(true);
    expect(hidden("](https://a.b)")).toBe(true);
    expect(
      reading.some(
        (r) =>
          r.kind === "mark" &&
          r.cls === "md-strong" &&
          s.slice(r.from, r.to) === "**b**",
      ),
    ).toBe(true);
    expect(reading.some((r) => r.kind === "bullet")).toBe(true);
    expect(
      reading.some(
        (r) =>
          r.kind === "mark" &&
          r.cls === "md-link" &&
          s.slice(r.from, r.to) === "x",
      ),
    ).toBe(true);
    expect(reading.some((r) => r.kind === "line" && r.cls === "md-quote")).toBe(
      true,
    );
    expect(
      reading.some((r) => r.kind === "line" && r.cls === "md-h md-h2"),
    ).toBe(true);
    // The caret on line 1: nothing on that line is replaced (an IME
    // composing there is never disturbed).
    const editing = preview(s, [[3, 3]]);
    const line1 = s.indexOf("\n");
    expect(
      editing.filter(
        (r) => r.from < line1 && (r.kind === "hide" || r.kind === "bullet"),
      ),
    ).toEqual([]);
    expect(
      editing.some(
        (r) =>
          r.kind === "mark" &&
          r.cls === "md-marker" &&
          s.slice(r.from, r.to) === "**",
      ),
    ).toBe(true);
    // ...while line 2 still reads as the preview.
    expect(editing.some((r) => r.kind === "bullet")).toBe(true);
  });

  it("a selection over several lines shows the markers on all of them", () => {
    const s = "**a**\n**b**\n**c**";
    const r = preview(s, [[2, 8]]);
    const hides = r.filter((x) => x.kind === "hide").map((x) => x.from);
    expect(hides).toEqual([12, 15]);
  });

  it("follows the safe subset: no image, no HTML, no non-http link, nothing inside code", () => {
    const s =
      "![pic](https://x.y/a.png) <b>x</b> [x](javascript:alert(1)) `**c**`\n```\n**x**\n```";
    const ranges = preview(s);
    expect(
      ranges.some(
        (r) =>
          r.kind === "hide" && s.slice(r.from, r.to).includes("javascript"),
      ),
    ).toBe(false);
    expect(
      ranges.some((r) => r.kind === "hide" && s.slice(r.from, r.to) === "!"),
    ).toBe(false);
    expect(ranges.some((r) => r.kind === "mark" && r.cls === "md-strong")).toBe(
      false,
    );
    expect(ranges.some((r) => r.kind === "line" && r.cls === "md-fence")).toBe(
      true,
    );
    // Setext headings and indented code are off: they stay as typed.
    expect(preview("Title\n=====").some((r) => r.kind === "line")).toBe(false);
    expect(preview("    indented").some((r) => r.kind === "line")).toBe(false);
  });

  it("a rule, a closing ##, an escape and a numbered list read as typed, muted", () => {
    const s = "# T ##\n\n---\n\n\\*x\n\n1. one";
    const r = preview(s);
    expect(r.some((x) => x.kind === "line" && x.cls === "md-hr")).toBe(true);
    expect(
      r.some((x) => x.kind === "hide" && s.slice(x.from, x.to) === "##"),
    ).toBe(true);
    expect(
      r.some((x) => x.kind === "hide" && s.slice(x.from, x.to) === "\\"),
    ).toBe(true);
    expect(
      r.some(
        (x) =>
          x.kind === "mark" &&
          x.cls === "md-listmark" &&
          s.slice(x.from, x.to) === "1.",
      ),
    ).toBe(true);
  });
});

describe("the commands", () => {
  it("toolbar and shortcuts type the markers, and undo them", () => {
    const bold = toggleInline("hello world", 6, 11, "bold");
    const out = applyEdit("hello world", bold);
    expect(out).toBe("hello **world**");
    expect(out.slice(bold.anchor, bold.head)).toBe("world");
    expect(
      applyEdit(out, toggleInline(out, bold.anchor, bold.head, "bold")),
    ).toBe("hello world");
    expect(applyEdit("a b", toggleInline("a b", 0, 3, "italic"))).toBe("*a b*");
    expect(applyEdit("x", toggleInline("x", 1, 1, "code"))).toBe("x``");
    expect(applyEdit("x", toggleInline("x", 0, 1, "strike"))).toBe("~~x~~");
    expect(applyEdit(" pad ", toggleInline(" pad ", 0, 5, "bold"))).toBe(
      " **pad** ",
    );
    // The selection holds the markers: they come off.
    expect(applyEdit("**w**", toggleInline("**w**", 0, 5, "bold"))).toBe("w");
    // Italic inside bold markers wraps, never unwraps the bold.
    expect(applyEdit("**w**", toggleInline("**w**", 2, 3, "italic"))).toBe(
      "***w***",
    );
    const link = insertLink("see docs", 4, 8);
    expect(applyEdit("see docs", link)).toBe("see [docs](https://)");
    expect(applyEdit("see docs", link).slice(link.anchor, link.head)).toBe(
      "https://",
    );
    const bare = insertLink("", 0, 0, "words");
    expect(applyEdit("", bare)).toBe("[words](https://)");
    expect(applyEdit("", bare).slice(bare.anchor, bare.head)).toBe("words");
    const url = insertLink("https://a.b", 0, 11, "t");
    expect(applyEdit("https://a.b", url)).toBe("[t](https://a.b)");
    expect(applyEdit("a\nb", toggleBlock("a\nb", 0, 3, "ordered"))).toBe(
      "1. a\n2. b",
    );
    expect(applyEdit("- a\n- b", toggleBlock("- a\n- b", 0, 7, "bullet"))).toBe(
      "a\nb",
    );
    expect(applyEdit("- a", toggleBlock("- a", 0, 0, "quote"))).toBe("> a");
    expect(applyEdit("t", toggleBlock("t", 0, 0, "heading"))).toBe("## t");
  });

  it("Enter in a list continues it; Enter on an empty item ends it", () => {
    expect(applyEdit("- one", continueBlock("- one", 5)!)).toBe("- one\n- ");
    expect(applyEdit("9. nine", continueBlock("9. nine", 7)!)).toBe(
      "9. nine\n10. ",
    );
    expect(applyEdit("> q", continueBlock("> q", 3)!)).toBe("> q\n> ");
    expect(applyEdit("x\n- ", continueBlock("x\n- ", 4)!)).toBe("x\n");
    expect(continueBlock("plain", 5)).toBeNull();
  });

  it("a formatting edit goes through a CodeMirror transaction unchanged", () => {
    const s = "日本語を読む";
    const edit = toggleInline(s, 0, 3, "bold");
    const out = applyEdit(s, edit);
    expect(out).toBe("**日本語**を読む");
    const state = EditorState.create({ doc: s }).update({
      changes: edit.changes,
      selection: EditorSelection.single(edit.anchor, edit.head),
    }).state;
    expect(state.doc.toString()).toBe(out);
    expect(
      state.sliceDoc(state.selection.main.from, state.selection.main.to),
    ).toBe("日本語");
  });

  it("insertBlock puts a block at the caret on lines of its own, never at the end", () => {
    const card = ":::note Hi\nText\n:::";
    const doc = "Intro line.\n\nOutro line.";
    const at = "Intro line.".length;
    let e = insertBlock(doc, at, at, card);
    expect(applyEdit(doc, e)).toBe(
      "Intro line.\n\n" + card + "\n\nOutro line.",
    );
    expect(e.anchor).toBe(at + 2 + card.length);
    const gap = "Intro line.\n\n".length;
    e = insertBlock(doc, gap, gap, card);
    expect(applyEdit(doc, e)).toBe(
      "Intro line.\n\n" + card + "\n\nOutro line.",
    );
    expect(applyEdit("", insertBlock("", 0, 0, card))).toBe(card + "\n");
    e = insertBlock("Keep THIS keep", 5, 9, card);
    expect(applyEdit("Keep THIS keep", e)).toBe(
      "Keep \n\n" + card + "\n\n keep",
    );
  });

  it("insertLinkTo: the selected words (or the label) link to the URL, one link", () => {
    const e = insertLinkTo(
      "see [the]\ndocs now",
      4,
      14,
      "Docs",
      "https://a.b/(x) y",
    );
    expect(applyEdit("see [the]\ndocs now", e)).toBe(
      "see [the docs](https://a.b/%28x%29%20y) now",
    );
    expect(applyEdit("", insertLinkTo("", 0, 0, "Docs", "https://a.b"))).toBe(
      "[Docs](https://a.b)",
    );
    expect(applyEdit("", insertLinkTo("", 0, 0, " ", "https://a.b"))).toBe(
      "[https://a.b](https://a.b)",
    );
  });
});

describe("IME", () => {
  it("the Enter that confirms a conversion never sends or submits", () => {
    expect(enterAction({ key: "Enter", shiftKey: false }, "lite")).toBe(
      "submit",
    );
    expect(enterAction({ key: "Enter", shiftKey: true }, "lite")).toBe(
      "newline",
    );
    expect(
      enterAction({ key: "Enter", shiftKey: false, altKey: true }, "lite"),
    ).toBe("newline");
    expect(
      enterAction({ key: "Enter", shiftKey: false, isComposing: true }, "lite"),
    ).toBe("ime");
    expect(
      enterAction({ key: "Enter", shiftKey: false, keyCode: 229 }, "lite"),
    ).toBe("ime");
    expect(enterAction({ key: "Enter", shiftKey: false }, "lite", true)).toBe(
      "ime",
    );
    expect(enterAction({ key: "Enter", shiftKey: false }, "full")).toBe(
      "newline",
    );
    expect(
      enterAction({ key: "Enter", shiftKey: false, metaKey: true }, "full"),
    ).toBe("submit");
    expect(
      enterAction({ key: "Enter", shiftKey: false, ctrlKey: true }, "full"),
    ).toBe("submit");
    expect(
      enterAction(
        { key: "Enter", shiftKey: false, metaKey: true, isComposing: true },
        "full",
      ),
    ).toBe("ime");
    expect(enterAction({ key: "a", shiftKey: false }, "lite")).toBeNull();
    expect(composingKey({ keyCode: 229 })).toBe(true);
    expect(composingKey({ keyCode: 13 })).toBe(false);
    expect(COMPOSITION_GRACE_MS).toBe(100);
  });

  it("every Enter binding checks the composition first; the preview freezes while composing", () => {
    const enters =
      SRC.match(/\{\s*key: "(?:Mod-|Shift-|Alt-)?Enter",\s*run: [^}]*\}/g) ??
      [];
    expect(enters.length).toBe(5);
    for (const b of enters) expect(b).toMatch(/imeEnter\(v\) \|\|/);
    expect(SRC).toMatch(
      /view\.composing \|\|\s*composingKey\(lastKey\) \|\|\s*Date\.now\(\) - compositionEnded < COMPOSITION_GRACE_MS/,
    );
    expect(SRC).toMatch(
      /if \(u\.view\.composing \|\| u\.view\.compositionStarted\) \{\s*this\.decorations = this\.decorations\.map\(u\.changes\);\s*return;\s*\}/,
    );
    // The length limit never cuts an open composition.
    expect(SRC).toMatch(
      /tr\.isUserEvent\("input\.type\.compose"\)\) return tr;/,
    );
    // The stand-in textarea (while the chunk loads) uses the same rule.
    expect(SRC).toMatch(
      /enterAction\(\s*\{[^}]*isComposing: e\.isComposing,\s*keyCode: e\.keyCode,?\s*\},\s*mode,?\s*\)/,
    );
  });
});

describe("the lazy chunk", () => {
  it("imports no CodeMirror statically: one dynamic import() of each package", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /(^|[^:])\/\/.*$/gm,
      "$1",
    );
    expect(code).not.toMatch(/^\s*import\s[^(]*["']@(codemirror|lezer)\//m);
    expect(code).not.toMatch(
      /^\s*export\s[^(]*from\s*["']@(codemirror|lezer)\//m,
    );
    for (const name of [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/commands",
      "@lezer/markdown",
    ])
      expect(code).toContain(`import("${name}")`);
    // Its only static import is the kit's words.
    expect(
      [...code.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]),
    ).toEqual(["./strings.js"]);
  });

  it("pins every CodeMirror and Lezer package exactly", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(KIT, "package.json"), "utf-8"),
    ) as { dependencies: Record<string, string> };
    const names = Object.keys(pkg.dependencies).sort();
    expect(names).toEqual([
      "@codemirror/commands",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/markdown",
    ]);
    for (const n of names)
      expect(pkg.dependencies[n]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("Den's own pages never load it: not served at /kit/, not imported", () => {
    expect(KIT_FILES.some((f) => f.startsWith("markdown-editor"))).toBe(false);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs|html)$/.test(f.name)) {
          if (
            /markdown-editor|@codemirror\/|@lezer\//.test(
              fs.readFileSync(p, "utf-8"),
            )
          )
            hits.push(path.relative(ROOT, p));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(hits).toEqual([]);
  });
});

describe("accessible, tokens only, the kit's words", () => {
  it("names and describes the editor; the toolbar is named and keeps the caret", () => {
    for (const a of [
      '"aria-labelledby"',
      '"aria-describedby"',
      '"aria-multiline": "true"',
      'role: "textbox"',
      '"aria-invalid"',
      '"aria-disabled"',
      '"aria-readonly"',
      '"aria-required"',
    ])
      expect(SRC).toContain(a);
    expect(SRC).toMatch(/role", "toolbar"/);
    expect(SRC).toMatch(/"aria-label", word\("kit\.md\.toolbar"\)/);
    expect(SRC).toMatch(
      /addEventListener\("mousedown", \(e\) => e\.preventDefault\(\)\)/,
    );
  });

  it("has no colour or product name of its own", () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(/);
    expect(SRC).not.toMatch(/\b[dD]en\b(?!-ui)/);
    // Every var() it reads is a kit token, its own knob, or a theme hook
    // (issue 1137: the kit leaves it unset, a theme such as sketch sets it,
    // and the rule gives today's value as the fallback).
    const tokens = fs.readFileSync(path.join(KIT, "src/tokens.css"), "utf-8");
    const sketch = fs.readFileSync(
      path.join(KIT, "src/themes/sketch.css"),
      "utf-8",
    );
    const hook = (v: string) =>
      sketch.includes(`${v}:`) && css.includes(`var(${v}, `);
    for (const m of css.matchAll(/var\((--[\w-]+)/g))
      expect([
        m[1],
        tokens.includes(`${m[1]}:`) || /^--md-/.test(m[1]!) || hook(m[1]!),
      ]).toEqual([m[1], true]);
  });

  it("touch sizes: on a touch or narrow screen, 44px buttons and 16px text; desktop as before", () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    // The kit's own touch and narrow breakpoints (shell.css, base.css).
    const at = css.indexOf("@media (pointer: coarse), (max-width: 720px) {");
    expect(at).toBeGreaterThan(-1);
    let depth = 0,
      end = at;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const touch = css.slice(at, end);
    const rule = (sel: string, src: string) =>
      new RegExp(
        `(?:^|[\\s,}])${sel.replace(/[.*]/g, "\\$&")}(?![\\w-])[^{]*\\{([^}]*)\\}`,
      ).exec(src)?.[1] ?? "";
    expect(rule(".md-tool", touch)).toMatch(/min-width: var\(--tap\);/);
    expect(rule(".md-tool", touch)).toMatch(/min-height: var\(--tap\);/);
    expect(touch).toMatch(
      /\.md-editor-host,\s*\.md-fallback,\s*\.md-field \.md-fallback \{\s*font-size: 16px;/,
    );
    // Desktop keeps the source's values.
    const desktop = css.slice(0, at);
    expect(rule(".md-tool", desktop)).toMatch(
      /width: 28px;[\s\S]*height: 28px;/,
    );
    expect(rule(".md-editor-host,\n.md-fallback", desktop)).toMatch(
      /font-size: 15px;/,
    );
    expect(tokensHave("--tap")).toBe(true);
  });

  it("its words are the kit's, in en, es and ja", () => {
    const keys = [
      "kit.md.toolbar",
      "kit.md.toolKey",
      "kit.md.bold",
      "kit.md.italic",
      "kit.md.code",
      "kit.md.link",
      "kit.md.heading",
      "kit.md.bulleted",
      "kit.md.numbered",
      "kit.md.quote",
      "kit.md.linkText",
    ];
    for (const t of [en, es, ja] as Array<Record<string, string>>)
      for (const k of keys) expect([k, typeof t[k]]).toEqual([k, "string"]);
    expect((ja as Record<string, string>)["kit.md.toolbar"]).toBe("書式");
    for (const m of SRC.matchAll(/word\("(kit\.md\.\w+)"/g))
      expect(keys).toContain(m[1]);
  });
});
