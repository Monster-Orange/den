/**
 * A fixed marker the web server adds to every HTML page it serves, so the CLI
 * can tell its own UI is up without matching any product or brand text
 * (a brand may differ from the product title, even in case).
 */
export const DEN_UI_MARKER = '<meta name="den-ui" content="1">';

/** Insert the marker right after <head> (or at the start when there is none). */
export function addDenUiMarker(html: string): string {
  if (html.includes(DEN_UI_MARKER)) return html;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return DEN_UI_MARKER + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + DEN_UI_MARKER + html.slice(at);
}

export function hasDenUiMarker(html: string): boolean {
  return html.includes(DEN_UI_MARKER);
}
