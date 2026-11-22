/**
 * Issue 205: a held write's Review lines, each beside its message key, so
 * the Allow dialog shows the line in the page's language. A check returns
 * `...reviewLines([line(text, key, vars), …])`: its `details` (the lines,
 * in English) and `detailKeys` (one per line, in the same order).
 * tests/unit/server/held-review-keys-205.test.ts checks that each key, in
 * English, is its line word for word.
 */
export interface DetailKey {
  key: string;
  vars?: Record<string, string>;
}
export type ReviewLine = [string, DetailKey];

/** One Review line and its key; `vars` fill the key's {placeholders}. */
export const line = (
  text: string,
  key: string,
  vars?: Record<string, string>,
): ReviewLine => [text, vars ? { key, vars } : { key }];

/** The Review lines and their keys, one per line. */
export const reviewLines = (lines: ReviewLine[]) => ({
  details: lines.map((l) => l[0]),
  detailKeys: lines.map((l) => l[1]),
});
