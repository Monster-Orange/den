/** The kit's words: every key starts `kit.`; en, es and ja hold the same keys. */
export type Words = Record<string, string>;
export declare const en: Words;
export declare const es: Words;
export declare const ja: Words;
export declare const STRINGS: { en: Words; es: Words; ja: Words };
/** The name `{product}` fills in. */
export declare function setProduct(name: string): void;
/** A product's own words, or its versions of the kit's, for a language. */
export declare function addStrings(lang: string, table: Words): void;
/** The word for `key` in `lang` (else en, else the key), vars filled in. */
export declare function kitT(
  lang: string | undefined,
  key: string,
  vars?: Record<string, string | number>,
): string;
/** HTML-escaped text. */
export declare function esc(v: unknown): string;
/** An id safe in an attribute and a CSS selector: letters, digits, _ and -. */
export declare function safeId(v: unknown): string;
