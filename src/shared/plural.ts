/**
 * Counts in output: "1 repo", "3 repos", never "1 repos" or "repo(s)".
 */

/** `word` in the form `n` takes: "repo" for 1, "repos" (or `many`) otherwise. */
export function noun(n: number, word: string, many = `${word}s`): string {
  return n === 1 ? word : many;
}

/** `n` and its noun: plural(1, "repo") → "1 repo", plural(2, "repo") → "2 repos". */
export function plural(n: number, word: string, many?: string): string {
  return `${n} ${noun(n, word, many)}`;
}
