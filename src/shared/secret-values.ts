import { stripVTControlCharacters } from "node:util";
import { redactValues } from "./redact.js";

export const MIN_MASKED_LENGTH = 6;

const known = new Set<string>();
let longestFirst: string[] = [];

export function rememberSecretValues(values: Iterable<unknown>): void {
  let added = false;
  for (const v of values)
    if (
      typeof v === "string" &&
      v.length >= MIN_MASKED_LENGTH &&
      !known.has(v)
    ) {
      known.add(v);
      added = true;
    }
  if (added) longestFirst = [...known].sort((a, b) => b.length - a.length);
}

export function maskSecretValues(text: string): string {
  return longestFirst.length ? redactValues(text, longestFirst) : text;
}

export function maskSecretLine(line: string): string {
  if (!longestFirst.length) return line;
  const plain = stripVTControlCharacters(line);
  const masked = maskSecretValues(plain);
  return masked === plain ? line : masked;
}

export function forgetSecretValues(): void {
  known.clear();
  longestFirst = [];
}
