/**
 * The kit's Markdown editor (0.7.5): CodeMirror 6 on the Markdown text, the
 * live preview drawn in place, IME-safe, loaded lazily. Link
 * markdown-editor.css after tokens.css.
 */

/** "full": a form field with a toolbar; Enter is a new line, ⌘/Ctrl+Enter submits. "lite": a chat box, no toolbar; Enter sends, Shift+Enter is a new line. */
export type MarkdownMode = "full" | "lite";
export type InlineFormat = "bold" | "italic" | "code" | "strike";
export type BlockFormat = "heading" | "bullet" | "ordered" | "quote";
export type MarkdownFormat = InlineFormat | BlockFormat | "link";

export interface MarkdownEditorOptions {
  /** The text it opens with: the Markdown source, kept byte for byte. */
  value?: string;
  /** Every change the person makes, as the whole Markdown source. Never called for setValue. */
  onChange?: (value: string) => void;
  /** Default "full". */
  mode?: MarkdownMode;
  /** The editing surface's id (the stand-in textarea has it first). Default: one made up. */
  id?: string;
  /** The editor's accessible name (aria-label). Give this or labelledBy. */
  label?: string;
  /** The id of the element that names it (aria-labelledby). */
  labelledBy?: string;
  /** The ids of the elements that describe it: help, an error (aria-describedby). */
  describedBy?: string;
  placeholder?: string;
  /** full: ⌘/Ctrl+Enter; lite: Enter. Never while an IME is composing. */
  onSubmit?: () => void;
  /** Escape inside the editor; it stops there (a dialog around it stays open). */
  onEscape?: () => void;
  /** Focus left the field, the toolbar included. */
  onBlur?: () => void;
  disabled?: boolean;
  /** No toolbar, no edits; the text can still be selected and copied. */
  readOnly?: boolean;
  /** Counts the Markdown SOURCE (what is stored), as a textarea's maxLength does. An open IME composition is never cut. */
  maxLength?: number;
  required?: boolean;
  /** Marks it invalid (aria-invalid, the danger border) when its message is shown elsewhere. */
  invalid?: boolean;
  /** The text's language (the lang attribute), for spelling and line breaking. */
  lang?: string;
  /** The language of the toolbar's words: en, es or ja. Default: <html lang>, else en. */
  uiLang?: string;
  /** full: the editing area's minimum height in text rows (default 3). */
  rows?: number;
  /** full: false hides the toolbar (the shortcuts still work). */
  toolbar?: boolean;
  /** No link button (a field whose text may not hold a link). */
  noLinks?: boolean;
  autoFocus?: boolean;
  /** Where the caret goes when the editor arrives (default: where it was in the stand-in, else nowhere). */
  initialCaret?: number;
  /** The page's CSP nonce: CodeMirror writes its base styles into a <style>. */
  nonce?: string;
  /** Classes added to the field's box (.md-field). */
  className?: string;
}

/** What `update` may change after mounting. */
export type MarkdownEditorUpdate = Partial<
  Omit<MarkdownEditorOptions, "value" | "mode" | "id" | "nonce" | "rows">
>;

export interface MarkdownEditor {
  /** Resolves when CodeMirror has taken over from the stand-in; rejects when it could not load (the stand-in stays and works). */
  readonly ready: Promise<void>;
  /** The Markdown source now. */
  getValue(): string;
  /** A value from outside (a send cleared it, a server answered): onChange is not called, and it is the new unsaved-changes baseline. */
  setValue(value: string): void;
  focus(): void;
  /** What a toolbar button or shortcut does, on the selection. */
  run(format: MarkdownFormat): void;
  /** Put a block where the caret is, on lines of its own. */
  insertBlock(block: string): void;
  /** Put a link where the caret is, the selected words (else `label`) as its words. */
  insertLinkTo(label: string, url: string): void;
  /** Replace the last `count` characters with `text`, the caret after it. */
  replaceEnd(count: number, text: string): void;
  /** Change options: names, state, callbacks, the toolbar. */
  update(options: MarkdownEditorUpdate): void;
  /** Takes the editor and its box away. */
  destroy(): void;
}

/**
 * Mounts an editor in `el`. A plain textarea takes the typing until
 * CodeMirror arrives (one dynamic import, its own chunk in a bundle); then
 * the editor goes on from its text, focus, caret and selection. The
 * content element carries `data-md-dirty` while it holds unsaved text.
 */
export declare function mountMarkdownEditor(
  el: Element,
  options?: MarkdownEditorOptions,
): MarkdownEditor;

/** Loads CodeMirror ahead of the first editor (once; shared). */
export declare function loadMarkdownEditor(): Promise<void>;

// The pure parts, for a product's own tests or a server.

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}
/** True while the key belongs to an IME composition (isComposing, or keyCode 229). */
export declare function composingKey(
  e: Pick<KeyLike, "isComposing" | "keyCode">,
): boolean;
/** Within this long after compositionend, an Enter is the composition's (Safari): 100 ms. */
export declare const COMPOSITION_GRACE_MS: number;
/** What Enter does in a mode; "ime" while composing; null for another key. */
export declare function enterAction(
  e: KeyLike,
  mode: MarkdownMode,
  composing?: boolean,
): "submit" | "newline" | "ime" | null;

/** A text edit: changes in the old text's positions, the selection in the new. */
export interface MarkdownEdit {
  changes: Array<{ from: number; to: number; insert: string }>;
  anchor: number;
  head: number;
}
export declare function toggleInline(
  doc: string,
  from: number,
  to: number,
  format: InlineFormat,
): MarkdownEdit;
export declare function insertLink(
  doc: string,
  from: number,
  to: number,
  placeholder?: string,
): MarkdownEdit;
export declare function toggleBlock(
  doc: string,
  from: number,
  to: number,
  format: BlockFormat,
): MarkdownEdit;
export declare function continueBlock(
  doc: string,
  pos: number,
): MarkdownEdit | null;
export declare function insertBlock(
  doc: string,
  from: number,
  to: number,
  block: string,
): MarkdownEdit;
export declare function insertLinkTo(
  doc: string,
  from: number,
  to: number,
  label: string,
  url: string,
): MarkdownEdit;
export declare function applyEdit(doc: string, edit: MarkdownEdit): string;

/** One drawing instruction of the live preview. */
export type LiveRange =
  | { kind: "hide"; from: number; to: number }
  | { kind: "mark"; from: number; to: number; cls: string }
  | { kind: "line"; from: number; cls: string }
  | { kind: "bullet"; from: number; to: number };
/** A Lezer Markdown parser (from markdownParser). */
export interface MarkdownParser {
  parse(text: string): unknown;
}
/** The preview's parser, made from the @lezer/markdown module given. */
export declare function markdownParser(md: unknown): MarkdownParser;
/** Every drawing instruction for `text`, given the selections whose lines are being edited. */
export declare function livePreview(
  text: string,
  selection: ReadonlyArray<readonly [number, number]>,
  parser: MarkdownParser,
): LiveRange[];
