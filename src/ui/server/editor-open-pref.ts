/**
 * Where a file path in an agent's pane opens (AG-4b): ⌘-click (Ctrl-click
 * elsewhere) opens it in this editor by its URL scheme, at the line
 * (vscode://file/…, cursor://file/…, zed://file/…), or, with `none` (the
 * default), copies its absolute path. A person's view preference, stored
 * in the user config as `editor_open` (the `editor` key is already the
 * repo editor's, ↗) and served by /api/settings as `editor_open`. Nothing
 * here runs an editor: the browser hands the URL to the OS.
 */
import type { UserConfig } from "../../shared/den-config.js";

export const EDITOR_OPENS = ["vscode", "cursor", "zed", "none"] as const;
export type EditorOpen = (typeof EDITOR_OPENS)[number];
export const EDITOR_OPEN_DEFAULT: EditorOpen = "none";

const isEditorOpen = (v: unknown): v is EditorOpen =>
  typeof v === "string" && (EDITOR_OPENS as readonly string[]).includes(v);

/** The stored choice, or none when unset or hand-broken. */
export function editorOpen(user: UserConfig): EditorOpen {
  const v = user.editor_open;
  return isEditorOpen(v) ? v : EDITOR_OPEN_DEFAULT;
}

/**
 * Apply a POSTed `editor_open` to `user` (in place): an editor sets it,
 * null clears it. Anything else: the error to answer with.
 */
export function patchEditorOpen(
  user: UserConfig,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (v !== null && !isEditorOpen(v))
    return {
      ok: false,
      error: `editor_open must be one of ${EDITOR_OPENS.map((e) => `"${e}"`).join(", ")}, or null`,
    };
  if (v === null) delete user.editor_open;
  else user.editor_open = v;
  return { ok: true };
}
