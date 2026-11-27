/**
 * den-ui: the Markdown editor (0.7.5). CodeMirror 6 on the Markdown TEXT:
 * the document is the string that is stored, character for character, and
 * the live preview is drawn in place, as decoration only. Nothing is ever
 * converted to HTML and back, and there is no preview pane. Framework-free:
 *
 *   import { mountMarkdownEditor } from "@monster-orange/den-ui/markdown-editor";
 *   // and @monster-orange/den-ui/markdown-editor.css, after tokens.css
 *   const ed = mountMarkdownEditor(el, {
 *     value: "", onChange: (text) => save(text),
 *     label: "Notes",            the editor's name (or labelledBy)
 *     mode: "full",              "full": a form field with a toolbar;
 *                                "lite": a chat box, no toolbar
 *     onSubmit: () => send(),    full: ⌘/Ctrl+Enter; lite: Enter
 *   });
 *   ed.setValue(""); ed.focus(); ed.destroy();
 *
 * Every option and method is in markdown-editor.d.ts.
 *
 * Lazy: this file imports no CodeMirror. On mount it loads the packages
 * with import(), so a consumer's bundler puts them in their own chunk, and
 * a plain textarea (the stand-in) takes the typing until they arrive. The
 * toolbar works on the stand-in too. When the editor arrives it goes on
 * from the stand-in's text, focus, caret and selection, so nothing typed
 * is lost and what is typed next lands where the caret was.
 *
 * The preview (livePreview below): on a line the caret is NOT on, the
 * markers hide (`**`, `_`, `` ` ``, `~~`, `#`, `>`, the `[`/`](url)` around
 * a link's words, a backslash escape) and the words show formatted; `- `
 * becomes a bullet. On the line being edited every marker stays visible,
 * muted, so the caret never lands inside something hidden. Unfocused, the
 * whole field reads as the preview. The subset is CommonMark without the
 * parts a safe renderer leaves as plain text (setext headings, indented
 * code, HTML, entities, reference links, images, autolinks), plus
 * strikethrough; only an http(s) link is drawn as a link.
 *
 * IME: CodeMirror ignores key events during a composition, and on top of
 * that every Enter here checks `view.composing`, the keydown's own
 * isComposing / keyCode 229, and a confirming Enter that lands within
 * COMPOSITION_GRACE_MS of `compositionend` (Safari fires that keydown after
 * compositionend, isComposing already false). The preview's ranges are
 * frozen (mapped, not rebuilt) while a composition is open, and the line
 * being edited never has markers hidden, so the DOM around an open
 * composition is never rewritten. The length limit never cuts one.
 *
 * Words: the toolbar's are the kit's (strings.js, kit.md.*), in the
 * `uiLang` option's language, else the page's (<html lang>). Its look is
 * markdown-editor.css: tokens only. Under a strict style-src, pass the
 * page's `nonce`: CodeMirror writes its own base styles into a <style>.
 *
 * Ported from an existing editor, value for value.
 */
import { kitT } from "./strings.js";

// ------------------------------------------------------------- Enter and the IME

/** True while the key belongs to an IME composition: leave it to the IME. */
export function composingKey(e) {
  return !!e.isComposing || e.keyCode === 229;
}

/** Within this long after `compositionend`, an Enter is the composition's, not a send (Safari). */
export const COMPOSITION_GRACE_MS = 100;

/**
 * What Enter does. `lite` (a chat): Enter sends, Shift+Enter (or
 * Alt+Enter) is a new line. `full` (a form field): Enter is a new line,
 * ⌘/Ctrl+Enter submits. Never while composing: "ime".
 */
export function enterAction(e, mode, composing = false) {
  if (e.key !== "Enter") return null;
  if (composing || composingKey(e)) return "ime";
  if (mode === "lite") return e.shiftKey || e.altKey ? "newline" : "submit";
  return e.metaKey || e.ctrlKey ? "submit" : "newline";
}

// ------------------------------------------------------------------ the commands
// The formatting commands as pure text edits. Each takes the Markdown source
// and the selection and returns the edit to make: the markers typed into the
// source exactly as a person would type them. The toolbar, ⌘B/⌘I/⌘E/⌘K,
// ⌘⇧X and Enter in a list all go through here, so a formatted word is stored
// as `**word**`, never as HTML. An edit is { changes: [{ from, to, insert }],
// anchor, head }: changes in the OLD text's positions, the selection in the
// new one.

const MARKER = { bold: "**", italic: "*", code: "`", strike: "~~" };

/**
 * Wrap the selection in the format's markers, or unwrap it when it is
 * already wrapped. An empty selection gets the pair with the caret between.
 */
export function toggleInline(doc, from, to, format) {
  const m = MARKER[format];
  const n = m.length;
  const inner = doc.slice(from, to);
  // `**word**` with the markers just outside the selection.
  if (
    doc.slice(from - n, from) === m &&
    doc.slice(to, to + n) === m &&
    !(
      format === "italic" &&
      doc.slice(from - 2, from) === "**" &&
      doc.slice(from - 3, from) !== "***"
    )
  ) {
    return {
      changes: [
        { from: from - n, to: from, insert: "" },
        { from: to, to: to + n, insert: "" },
      ],
      anchor: from - n,
      head: to - n,
    };
  }
  // The selection includes the markers.
  if (inner.length >= 2 * n && inner.startsWith(m) && inner.endsWith(m)) {
    return {
      changes: [{ from, to, insert: inner.slice(n, inner.length - n) }],
      anchor: from,
      head: to - 2 * n,
    };
  }
  // Leading/trailing spaces stay outside the markers (`** word**` would not be bold).
  const lead = /^\s*/.exec(inner)[0].length;
  const trail = inner.length > lead ? /\s*$/.exec(inner)[0].length : 0;
  const a = from + lead,
    b = to - trail;
  return {
    changes: [
      { from: a, to: a, insert: m },
      { from: b, to: b, insert: m },
    ],
    anchor: a + n,
    head: b + n,
  };
}

/**
 * `[words](https://)`: the selection becomes the words and the address is
 * selected to type over; with nothing selected, the words placeholder is
 * selected first. A selected address becomes the address.
 */
export function insertLink(doc, from, to, placeholder = "text") {
  const sel = doc.slice(from, to);
  if (/^https?:\/\/\S+$/.test(sel)) {
    const insert = `[${placeholder}](${sel})`;
    return {
      changes: [{ from, to, insert }],
      anchor: from + 1,
      head: from + 1 + placeholder.length,
    };
  }
  const words = sel || placeholder;
  const insert = `[${words}](https://)`;
  if (!sel)
    return {
      changes: [{ from, to, insert }],
      anchor: from + 1,
      head: from + 1 + words.length,
    };
  const url = from + words.length + 3;
  return {
    changes: [{ from, to, insert }],
    anchor: url,
    head: url + "https://".length,
  };
}

const BLOCK_PREFIX = /^(\s{0,3})(#{1,6}\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s?)?/;
const IS = {
  heading: /^#{1,6}\s+$/,
  bullet: /^[-*+]\s+$/,
  ordered: /^\d{1,9}[.)]\s+$/,
  quote: /^>\s?$/,
};

/**
 * Turn every line the selection touches into the block (`## `, `- `,
 * `1. `, `> `), replacing another block prefix; when every line already is
 * that block, take the prefix off.
 */
export function toggleBlock(doc, from, to, format) {
  const start = doc.lastIndexOf("\n", from - 1) + 1;
  let end = doc.indexOf("\n", to);
  if (end < 0) end = doc.length;
  const lines = doc.slice(start, end).split("\n");
  const prefixes = lines.map((l) => BLOCK_PREFIX.exec(l));
  const all = prefixes.every((p) => p[2] && IS[format].test(p[2]));
  const changes = [];
  let at = start,
    shiftFrom = 0,
    shiftTo = 0,
    n = 0;
  lines.forEach((line, i) => {
    const p = prefixes[i];
    const cut = p[0].length;
    const blank = !line.trim();
    let insert = p[1];
    if (!all && !(blank && lines.length > 1)) {
      n += 1;
      insert +=
        format === "heading"
          ? "## "
          : format === "bullet"
            ? "- "
            : format === "ordered"
              ? `${n}. `
              : "> ";
    }
    if (insert !== p[0]) changes.push({ from: at, to: at + cut, insert });
    const delta = insert.length - cut;
    if (at <= from) shiftFrom += delta;
    shiftTo += delta;
    at += line.length + 1;
  });
  return {
    changes,
    anchor: Math.max(start, from + shiftFrom),
    head: Math.max(start, to + shiftTo),
  };
}

/**
 * Enter inside a list or a quote: the next line gets the same marker (a
 * numbered list counts on). Enter on an empty item ends the list (its
 * marker is removed). Null when the line is neither, and the caller
 * inserts a plain newline.
 */
export function continueBlock(doc, pos) {
  const start = doc.lastIndexOf("\n", pos - 1) + 1;
  const line = doc.slice(start, pos);
  const m =
    /^(\s*)([-*+]|\d{1,9}[.)]|>)(\s+)(.*)$/.exec(line) ??
    /^(\s*)(>)()(.*)$/.exec(line);
  if (!m) return null;
  const [, indent, mark, space, rest] = m;
  if (
    !rest.trim() &&
    doc
      .slice(pos, (doc.indexOf("\n", pos) + 1 || doc.length + 1) - 1)
      .trim() === ""
  ) {
    return {
      changes: [{ from: start, to: pos, insert: "" }],
      anchor: start,
      head: start,
    };
  }
  const ord = /^(\d{1,9})([.)])$/.exec(mark);
  const next = ord ? `${Number(ord[1]) + 1}${ord[2]}` : mark;
  const insert = `\n${indent}${next}${space || " "}`;
  return {
    changes: [{ from: pos, to: pos, insert }],
    anchor: pos + insert.length,
    head: pos + insert.length,
  };
}

/**
 * Put a block (a snippet, a card) where the caret is, replacing any
 * selection, on lines of its own: a blank line before and after unless the
 * text there already gives one. The caret lands after the block.
 */
export function insertBlock(doc, from, to, block) {
  const before = doc.slice(0, from),
    after = doc.slice(to);
  const lead =
    before === "" || before.endsWith("\n\n")
      ? ""
      : before.endsWith("\n")
        ? "\n"
        : "\n\n";
  const tail =
    after === ""
      ? "\n"
      : after.startsWith("\n\n")
        ? ""
        : after.startsWith("\n")
          ? "\n"
          : "\n\n";
  const insert = lead + block + tail;
  const caret = from + lead.length + block.length;
  return { changes: [{ from, to, insert }], anchor: caret, head: caret };
}

/**
 * A link to `url` where the caret is, replacing the selection: the
 * selected words become the link's words (else `label`, else the URL),
 * brackets and line breaks flattened so the Markdown stays one link. The
 * caret lands after it.
 */
export function insertLinkTo(doc, from, to, label, url) {
  const flat = (s) =>
    s
      .replace(/[[\]\n\r]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const words = flat(doc.slice(from, to)) || flat(label) || url;
  const safe = url.replace(
    /[()\s]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  const insert = `[${words}](${safe})`;
  const caret = from + insert.length;
  return { changes: [{ from, to, insert }], anchor: caret, head: caret };
}

/** Apply an edit to a string (tests and the stand-in). Changes do not overlap. */
export function applyEdit(doc, edit) {
  let out = doc;
  for (const c of [...edit.changes].sort((a, b) => b.from - a.from))
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

// --------------------------------------------------------------- the live preview

const parsers = new WeakMap();

/** The preview's Markdown parser, from the @lezer/markdown module given. */
export function markdownParser(md) {
  let p = parsers.get(md);
  if (!p) {
    p = md.parser.configure([
      md.Strikethrough,
      {
        remove: [
          "SetextHeading",
          "IndentedCode",
          "HTMLBlock",
          "HTMLTag",
          "Entity",
          "LinkReference",
          "Image",
          "Autolink",
          "Comment",
          "ProcessingInstruction",
        ],
      },
    ]);
    parsers.set(md, p);
  }
  return p;
}

const INLINE = {
  StrongEmphasis: "md-strong",
  Emphasis: "md-em",
  InlineCode: "md-code",
  Strikethrough: "md-del",
};
const MARKS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark"]);
const rank = (r) => (r.kind === "line" ? 0 : r.kind === "mark" ? 1 : 2);

/**
 * Every drawing instruction for `text`, given the selection ranges
 * (`[from, to]`) whose lines are being edited. `hide` and `bullet` replace
 * their range; `mark` styles it; `line` styles the whole line that starts
 * at `from`. Sorted by `from`; replacing ranges never overlap. Nothing here
 * changes the text.
 */
export function livePreview(text, selection, parser) {
  const starts = [0];
  for (let i = 0; i < text.length; i++)
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const activeLines = new Set();
  for (const [a, b] of selection)
    for (let l = lineOf(Math.min(a, b)); l <= lineOf(Math.max(a, b)); l++)
      activeLines.add(l);
  const active = (from, to) => {
    for (let l = lineOf(from); l <= lineOf(Math.max(from, to - 1)); l++)
      if (activeLines.has(l)) return true;
    return false;
  };

  const out = [];
  const hide = (from, to) => {
    if (to <= from) return;
    if (active(from, to)) {
      out.push({ kind: "mark", from, to, cls: "md-marker" });
      return;
    }
    out.push({ kind: "hide", from, to });
  };
  const lineDeco = (from, to, cls) => {
    for (let l = lineOf(from); l <= lineOf(Math.max(from, to - 1)); l++)
      out.push({ kind: "line", from: starts[l], cls });
  };

  parser.parse(text).iterate({
    enter(node) {
      const { name, from, to } = node;
      if (name in INLINE)
        out.push({ kind: "mark", from, to, cls: INLINE[name] });
      if (MARKS.has(name)) {
        hide(from, to);
        return;
      }
      const heading = /^ATXHeading([1-6])$/.exec(name);
      if (heading) {
        lineDeco(from, to, `md-h md-h${Math.min(Number(heading[1]), 3)}`);
        return;
      }
      switch (name) {
        case "HeaderMark": {
          // The `##` and the one space after it.
          const end = text[to] === " " ? to + 1 : to;
          if (
            node.node.parent?.name.startsWith("ATXHeading") &&
            from === node.node.parent.from
          )
            hide(from, end);
          else hide(from, to); // a closing `##`
          return;
        }
        case "Blockquote":
          lineDeco(from, to, "md-quote");
          return;
        case "QuoteMark":
          hide(from, text[to] === " " ? to + 1 : to);
          return;
        case "FencedCode":
          lineDeco(from, to, "md-fence");
          return false;
        case "HorizontalRule":
          lineDeco(from, to, "md-hr");
          out.push({ kind: "mark", from, to, cls: "md-marker" });
          return;
        case "ListMark": {
          const mark = text.slice(from, to);
          if (/^[-*+]$/.test(mark) && !active(from, to))
            out.push({ kind: "bullet", from, to });
          else out.push({ kind: "mark", from, to, cls: "md-listmark" });
          return;
        }
        case "Escape":
          hide(from, from + 1);
          return;
        case "Link": {
          const url = node.node.getChild("URL");
          // Only an http(s) address is a link to the reader; anything else stays as typed.
          if (!url || !/^https?:\/\//.test(text.slice(url.from, url.to)))
            return false;
          const marks = node.node.getChildren("LinkMark");
          const close = marks.find((m) => text.slice(m.from, m.to) === "]");
          if (!close || marks[0].from !== from) return false;
          out.push({
            kind: "mark",
            from: from + 1,
            to: close.from,
            cls: "md-link",
          });
          hide(from, from + 1);
          hide(close.from, to);
          return;
        }
      }
    },
  });
  return out.sort((a, b) => a.from - b.from || rank(a) - rank(b));
}

// ------------------------------------------------------------------ the lazy chunk

let loading = null;

/**
 * Loads CodeMirror (once; every editor shares it). mountMarkdownEditor
 * calls it; call it earlier to warm the chunk before a field is shown.
 */
export function loadMarkdownEditor() {
  return chunk().then(() => undefined);
}

/** The loaded modules, built once. */
function chunk() {
  if (!loading) {
    loading = Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/commands"),
      import("@lezer/markdown"),
    ]).then(([state, view, commands, md]) => build(state, view, commands, md));
    // A chunk that failed to load is tried again by the next editor.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** What the editors share, made once from the loaded modules. */
function build(state, cmView, commands, md) {
  const { EditorView, Decoration, ViewPlugin, WidgetType } = cmView;
  const parser = markdownParser(md);

  class BulletWidget extends WidgetType {
    eq() {
      return true;
    }
    toDOM() {
      const span = document.createElement("span");
      span.className = "md-bullet";
      span.setAttribute("aria-hidden", "true");
      span.textContent = "•";
      return span;
    }
    ignoreEvent() {
      return false;
    }
  }
  const BULLET = new BulletWidget();
  const HIDE = Decoration.replace({});

  function decorate(view) {
    // Unfocused, the whole field reads as the preview; focused, the caret's lines show their markers.
    const sel = view.hasFocus
      ? view.state.selection.ranges.map((r) => [r.from, r.to])
      : [];
    const ranges = livePreview(view.state.doc.toString(), sel, parser).map(
      (r) => {
        switch (r.kind) {
          case "hide":
            return HIDE.range(r.from, r.to);
          case "mark":
            return Decoration.mark({ class: r.cls }).range(r.from, r.to);
          case "line":
            return Decoration.line({ class: r.cls }).range(r.from);
          case "bullet":
            return Decoration.replace({ widget: BULLET }).range(r.from, r.to);
        }
      },
    );
    return Decoration.set(ranges, true);
  }

  const livePreviewPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = decorate(view);
      }
      update(u) {
        if (u.view.composing || u.view.compositionStarted) {
          this.decorations = this.decorations.map(u.changes);
          return;
        }
        if (u.docChanged || u.selectionSet || u.focusChanged)
          this.decorations = decorate(u.view);
      }
    },
    { decorations: (p) => p.decorations },
  );

  return {
    ...state,
    ...cmView,
    ...commands,
    /** A change that came from setValue, not from the person typing. */
    External: state.Annotation.define(),
    livePreviewPlugin,
  };
}

// ------------------------------------------------------------------------- mount

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl+";

const svg = (d) =>
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  d +
  "</svg>";

const TOOLS = [
  {
    format: "bold",
    label: "kit.md.bold",
    key: "B",
    icon: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  },
  {
    format: "italic",
    label: "kit.md.italic",
    key: "I",
    icon: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  },
  {
    format: "code",
    label: "kit.md.code",
    key: "E",
    icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  },
  {
    format: "link",
    label: "kit.md.link",
    key: "K",
    icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  },
  "sep",
  {
    format: "heading",
    label: "kit.md.heading",
    icon: '<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>',
  },
  {
    format: "bullet",
    label: "kit.md.bulleted",
    icon: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  },
  {
    format: "ordered",
    label: "kit.md.numbered",
    icon: '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  },
  {
    format: "quote",
    label: "kit.md.quote",
    icon: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
  },
];

/** The edit a format makes (the editor and the stand-in share it). */
function formatEdit(doc, from, to, format, linkText) {
  return format === "link"
    ? insertLink(doc, from, to, linkText)
    : format === "heading" ||
        format === "bullet" ||
        format === "ordered" ||
        format === "quote"
      ? toggleBlock(doc, from, to, format)
      : toggleInline(doc, from, to, format);
}

/** Two strings as one replacement (shared prefix and suffix kept). */
function diff(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (
    e < a.length - s &&
    e < b.length - s &&
    a[a.length - 1 - e] === b[b.length - 1 - e]
  )
    e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}

let seq = 0;

/**
 * Mounts a Markdown editor in `el` (appended to what is there). See
 * markdown-editor.d.ts for the options and the handle.
 */
export function mountMarkdownEditor(el, options) {
  const o = { ...options };
  const mode = o.mode === "lite" ? "lite" : "full";
  const lite = mode === "lite";
  const id = o.id || `md-editor-${++seq}`;
  const lang = () =>
    o.uiLang ||
    (typeof document !== "undefined" &&
      document.documentElement.lang?.slice(0, 2)) ||
    "en";
  const word = (key, vars) => kitT(lang(), key, vars);
  const linkText = () => word("kit.md.linkText");

  let cm = null;
  let view = null;
  let destroyed = false;
  let swapping = false;
  let dyn = null;
  let onKeyRec = null;

  // The field's box: a form field's look (full) or a chat's (lite).
  const box = document.createElement("div");
  box.className = lite ? "md-field md-lite" : "md-field";
  for (const c of String(o.className || "").split(/\s+/))
    if (c) box.classList.add(c);
  box.setAttribute(lite ? "data-markdown-lite" : "data-markdown-field", "");
  if (!lite)
    box.style.setProperty(
      "--md-min-height",
      `${(o.rows ?? 3) * 1.5 * 15 + 20}px`,
    );
  const paint = () => {
    if (!lite && o.invalid) box.setAttribute("data-invalid", "true");
    else box.removeAttribute("data-invalid");
    if (o.disabled) box.setAttribute("data-disabled", "true");
    else box.removeAttribute("data-disabled");
  };
  paint();
  // Focus left the field, the toolbar included.
  box.addEventListener("focusout", (e) => {
    if (swapping || !o.onBlur) return;
    if (!box.contains(e.relatedTarget)) o.onBlur();
  });
  // Escape inside is the editor's (a dialog around it stays open).
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && o.onEscape) e.stopPropagation();
  });

  // The toolbar (full only): it works on the stand-in too.
  let bar = null;
  const drawToolbar = () => {
    bar?.remove();
    bar = null;
    if (lite || o.readOnly || o.toolbar === false) return;
    bar = document.createElement("div");
    bar.className = "md-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", word("kit.md.toolbar"));
    bar.setAttribute("aria-controls", id);
    for (const tool of TOOLS) {
      if (tool !== "sep" && o.noLinks && tool.format === "link") continue;
      if (tool === "sep") {
        const s = document.createElement("span");
        s.className = "md-toolbar-sep";
        s.setAttribute("aria-hidden", "true");
        bar.append(s);
        continue;
      }
      const name = tool.key
        ? word("kit.md.toolKey", {
            name: word(tool.label),
            key: MOD + tool.key,
          })
        : word(tool.label);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "md-tool";
      b.disabled = !!o.disabled;
      b.setAttribute("aria-label", name);
      b.title = name;
      b.innerHTML = svg(tool.icon);
      // A toolbar press keeps the caret in the text.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => run(tool.format));
      bar.append(b);
    }
    box.prepend(bar);
  };
  drawToolbar();

  // The stand-in: a plain textarea with the same value, names and limit.
  const area = document.createElement("textarea");
  area.id = id;
  area.className = "md-fallback";
  area.rows = lite ? 1 : (o.rows ?? 3);
  area.value = String(o.value ?? "");
  area.setAttribute("data-md-editor", mode);
  const paintArea = () => {
    const set = (k, v) =>
      v === undefined || v === null || v === false
        ? area.removeAttribute(k)
        : area.setAttribute(k, v === true ? "" : String(v));
    set("placeholder", o.placeholder);
    set("maxlength", o.maxLength);
    set("disabled", !!o.disabled);
    set("readonly", !lite && !!o.readOnly);
    set("required", !!o.required);
    set("lang", o.lang);
    set("aria-label", o.label);
    set("aria-labelledby", o.labelledBy);
    set("aria-describedby", o.describedBy);
    set("aria-invalid", !!o.invalid && "true");
  };
  paintArea();
  area.addEventListener("input", () => o.onChange?.(area.value));
  area.addEventListener("keydown", (e) => {
    const act = enterAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        isComposing: e.isComposing,
        keyCode: e.keyCode,
      },
      mode,
    );
    if (act === "submit" && o.onSubmit) {
      e.preventDefault();
      o.onSubmit();
    } else if (act === "submit" && lite) e.preventDefault();
    else if (e.key === "Escape" && o.onEscape) {
      e.preventDefault();
      o.onEscape();
    }
  });
  box.append(area);
  el.append(box);
  if (o.autoFocus) area.focus();

  /** An edit on the stand-in, as the person would make it. */
  const standInEdit = (edit) => {
    area.value = applyEdit(area.value, edit);
    o.onChange?.(area.value);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(edit.anchor, edit.head);
    });
  };
  const apply = (edit, userEvent) =>
    view.dispatch({
      changes: edit.changes,
      selection: cm.EditorSelection.single(edit.anchor, edit.head),
      userEvent,
      scrollIntoView: true,
    });
  const runFormat = (v, format) => {
    if (!v.state.facet(cm.EditorView.editable) || v.state.readOnly)
      return false;
    const { from, to } = v.state.selection.main;
    apply(
      formatEdit(v.state.doc.toString(), from, to, format, linkText()),
      "input.format",
    );
    return true;
  };
  const newline = (v) => {
    if (v.state.readOnly) return false;
    const { from, to } = v.state.selection.main;
    const edit =
      from === to ? continueBlock(v.state.doc.toString(), from) : null;
    if (edit) apply(edit, "input");
    else
      v.dispatch(v.state.replaceSelection("\n"), {
        userEvent: "input",
        scrollIntoView: true,
      });
    return true;
  };

  function run(format) {
    if (view) {
      runFormat(view, format);
      view.focus();
      return;
    }
    standInEdit(
      formatEdit(
        area.value,
        area.selectionStart,
        area.selectionEnd,
        format,
        linkText(),
      ),
    );
  }
  /** From outside (a button): the editor when it has loaded, else the stand-in's caret. */
  const atCaret = (make) => {
    if (view) {
      // The selection survives the blur a click outside causes: this is where the person last was.
      const { from, to } = view.state.selection.main;
      const edit = make(view.state.doc.toString(), from, to);
      view.dispatch({
        changes: edit.changes,
        selection: { anchor: edit.anchor, head: edit.head },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    standInEdit(make(area.value, area.selectionStart, area.selectionEnd));
  };

  // The editor's own attributes and state, reconfigured by update().
  const dynamic = () => {
    const attrs = {
      id,
      tabindex: o.disabled ? "-1" : "0",
      "aria-multiline": "true",
      role: "textbox",
      "data-md-editor": mode,
      autocapitalize: "sentences",
      autocorrect: "on",
      spellcheck: "true",
    };
    if (o.label) attrs["aria-label"] = o.label;
    if (o.labelledBy) attrs["aria-labelledby"] = o.labelledBy;
    if (o.describedBy) attrs["aria-describedby"] = o.describedBy;
    if (o.invalid) attrs["aria-invalid"] = "true";
    if (o.required) attrs["aria-required"] = "true";
    if (o.disabled) attrs["aria-disabled"] = "true";
    if (o.readOnly) attrs["aria-readonly"] = "true";
    if (o.lang) attrs.lang = o.lang;
    return [
      cm.EditorView.editable.of(!o.disabled),
      cm.EditorState.readOnly.of(!!o.disabled || !!o.readOnly),
      cm.EditorView.contentAttributes.of(attrs),
      o.placeholder ? cm.placeholder(o.placeholder) : [],
    ];
  };

  function start(loaded) {
    cm = loaded;
    const { EditorState, EditorView, Prec, Transaction, keymap } = cm;
    let compositionEnded = 0;
    let lastKey = { isComposing: false, keyCode: 0 };
    const imeEnter = (view) =>
      view.composing ||
      composingKey(lastKey) ||
      Date.now() - compositionEnded < COMPOSITION_GRACE_MS;
    const submit = () => {
      const fn = o.onSubmit;
      if (!fn) return false;
      fn();
      return true;
    };
    const keys = [
      { key: "Mod-b", run: (v) => runFormat(v, "bold") },
      { key: "Mod-i", run: (v) => runFormat(v, "italic") },
      { key: "Mod-e", run: (v) => runFormat(v, "code") },
      { key: "Mod-k", run: (v) => runFormat(v, "link") },
      { key: "Mod-Shift-x", run: (v) => runFormat(v, "strike") },
      // An Enter that belongs to the IME is swallowed here (true), so no lower keymap inserts a line either.
      lite
        ? { key: "Enter", run: (v) => imeEnter(v) || submit() || newline(v) }
        : { key: "Enter", run: (v) => imeEnter(v) || newline(v) },
      { key: "Shift-Enter", run: (v) => imeEnter(v) || newline(v) },
      { key: "Alt-Enter", run: (v) => imeEnter(v) || newline(v) },
      { key: "Mod-Enter", run: (v) => imeEnter(v) || submit() || true },
      {
        key: "Escape",
        run: () => {
          const fn = o.onEscape;
          if (!fn) return false;
          fn();
          return true;
        },
      },
    ];

    const limit = EditorState.transactionFilter.of((tr) => {
      const max = o.maxLength;
      if (
        !max ||
        !tr.docChanged ||
        tr.annotation(cm.External) ||
        !tr.annotation(Transaction.userEvent)
      )
        return tr;
      if (
        tr.newDoc.length <= max ||
        tr.newDoc.length <= tr.startState.doc.length
      )
        return tr;
      // Never cut an open IME composition: a count beside the field says it is over.
      if (tr.isUserEvent("input.type.compose")) return tr;
      const changes = [];
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
        changes.push({ from: fromA, to: toA, insert: inserted.toString() }),
      );
      if (changes.length !== 1) return [];
      const c = changes[0];
      let insert = c.insert.slice(
        0,
        c.insert.length - (tr.newDoc.length - max),
      );
      if (/[\ud800-\udbff]$/.test(insert)) insert = insert.slice(0, -1);
      if (!insert) return [];
      return {
        changes: { from: c.from, to: c.to, insert },
        selection: { anchor: c.from + insert.length },
        userEvent: tr.annotation(Transaction.userEvent),
      };
    });

    // The stand-in hands over its text, focus, caret and selection as they are now.
    const doc = area.value;
    const handed = {
      focus: document.activeElement === area,
      caret: area.selectionStart,
      end: area.selectionEnd,
    };
    const opened = doc;
    const focus = o.autoFocus || handed.focus;
    const caret = o.initialCaret ?? (handed.focus ? handed.caret : undefined);
    // a selection in the stand-in comes over whole (anchor at its start, head at its end)
    const end =
      o.initialCaret === undefined && handed.focus ? handed.end : undefined;
    dyn = new cm.Compartment();
    const host = document.createElement("div");
    host.className = `md-editor-host md-editor-${mode}`;
    area.before(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection:
          caret !== undefined
            ? {
                anchor: Math.min(caret, doc.length),
                head: Math.min(end ?? caret, doc.length),
              }
            : undefined,
        extensions: [
          o.nonce ? EditorView.cspNonce.of(o.nonce) : [],
          cm.history(),
          Prec.highest(keymap.of(keys)),
          keymap.of([...cm.standardKeymap, ...cm.historyKeymap]),
          EditorView.lineWrapping,
          cm.livePreviewPlugin,
          limit,
          EditorView.domEventHandlers({
            compositionend() {
              compositionEnded = Date.now();
              return false;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            if (!u.transactions.some((tr) => tr.annotation(cm.External)))
              o.onChange?.(text);
            // Unsaved typing, for an update notice's "reload anyway?".
            if (text !== opened && text.trim())
              u.view.contentDOM.setAttribute("data-md-dirty", "");
            else u.view.contentDOM.removeAttribute("data-md-dirty");
          }),
          dyn.of(dynamic()),
        ],
      }),
    });
    // Record the keydown before CodeMirror's handlers see it (keyCode 229 = an IME's key).
    onKeyRec = (e) => {
      lastKey = { isComposing: e.isComposing, keyCode: e.keyCode };
    };
    view.dom.addEventListener("keydown", onKeyRec, true);
    swapping = true;
    area.remove();
    swapping = false;
    if (focus) {
      view.focus();
      if (caret === undefined)
        view.dispatch({ selection: { anchor: view.state.doc.length } });
    }
  }

  const ready = chunk().then((loaded) => {
    if (!destroyed) start(loaded);
  });
  ready.catch(() => {
    /* the stand-in stays: a plain textarea that still works */
  });

  return {
    ready,
    getValue: () => (view ? view.state.doc.toString() : area.value),
    setValue(v) {
      const next = String(v ?? "");
      if (!view) {
        area.value = next;
        return;
      }
      const doc = view.state.doc.toString();
      if (next === doc) return;
      view.dispatch({
        changes: diff(doc, next),
        annotations: cm.External.of(true),
      });
      // A value set from outside (a send cleared it, a save answered) is the new baseline.
      view.contentDOM.removeAttribute("data-md-dirty");
    },
    focus: () => (view ? view.focus() : area.focus()),
    run,
    insertBlock: (block) =>
      atCaret((doc, from, to) => insertBlock(doc, from, to, block)),
    insertLinkTo: (label, url) =>
      atCaret((doc, from, to) => insertLinkTo(doc, from, to, label, url)),
    replaceEnd(count, text) {
      if (view) {
        const end = view.state.doc.length,
          from = Math.max(0, end - count);
        view.dispatch({
          changes: { from, to: end, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
        });
        view.focus();
        return;
      }
      const next =
        area.value.slice(0, Math.max(0, area.value.length - count)) + text;
      area.value = next;
      o.onChange?.(next);
      requestAnimationFrame(() => {
        area.focus();
        area.setSelectionRange(next.length, next.length);
      });
    },
    update(next) {
      Object.assign(o, next ?? {});
      paint();
      paintArea();
      drawToolbar();
      view?.dispatch({ effects: dyn.reconfigure(dynamic()) });
    },
    destroy() {
      destroyed = true;
      if (view) {
        view.dom.removeEventListener("keydown", onKeyRec, true);
        view.destroy();
        view = null;
      }
      box.remove();
    },
  };
}
